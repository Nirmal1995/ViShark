import type { MongoClient } from 'mongodb';
import mongoose from 'mongoose';
import type { Logger } from 'pino';
import type { AppConfig } from '../config/env.ts';

// Safety settings (sanitizeFilter, strictQuery, no buffering): see mongoose-settings.ts.
import './mongoose-settings.ts';

export type MongoConnection = {
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  ping: () => Promise<void>;
};

/** Removes credentials from a connection string before it is logged. */
export function redactMongoUrl(url: string): string {
  return url.replace(/\/\/([^@/]+)@/, '//***:***@');
}

export function createMongoConnection(
  config: Pick<AppConfig, 'MONGO_URL' | 'MONGO_SERVER_SELECTION_TIMEOUT_MS' | 'NODE_ENV'>,
  logger: Logger,
): MongoConnection {
  const log = logger.child({ component: 'mongo' });
  const conn = mongoose.connection;

  conn.on('connected', () => log.info('connected'));
  conn.on('disconnected', () => log.warn('disconnected'));
  conn.on('reconnected', () => log.info('reconnected'));
  conn.on('error', (err: Error) => log.error({ err }, 'connection error'));

  return {
    async connect() {
      log.info({ url: redactMongoUrl(config.MONGO_URL) }, 'connecting');
      await mongoose.connect(config.MONGO_URL, {
        serverSelectionTimeoutMS: config.MONGO_SERVER_SELECTION_TIMEOUT_MS,
        // Index builds at startup are convenient locally but can lock large
        // production collections; production indexes go through migrations.
        autoIndex: config.NODE_ENV !== 'production',
        maxPoolSize: 20,
      });
    },
    async disconnect() {
      await mongoose.disconnect();
    },
    async ping() {
      const db = conn.db;
      if (conn.readyState !== mongoose.ConnectionStates.connected || !db) {
        throw new Error('not connected');
      }
      await db.command({ ping: 1 });
    },
  };
}

/**
 * Resolves with the driver client once the first connection succeeds, however
 * many attempts that takes. It never rejects.
 *
 * Do not use mongoose.connection.asPromise() for this: it rejects when the
 * first attempt fails, so an API container that starts before its database
 * crashed with an unhandled rejection (and a session store waiting on it would
 * stay broken even after the database came up). Found by the CI image smoke
 * test, which starts the container without a database.
 */
export function whenConnected(): Promise<MongoClient> {
  const conn = mongoose.connection;
  if (conn.readyState === mongoose.ConnectionStates.connected) {
    return Promise.resolve(conn.getClient());
  }
  return new Promise((resolve) => {
    conn.once('connected', () => resolve(conn.getClient()));
  });
}

/**
 * Database migration step: creates every index the application relies on
 * (unique email, TTL expiry of tokens, session lookups).
 *
 *   pnpm db:migrate                                   (local)
 *   node apps/api/dist/cli/migrate.js                 (inside the API image)
 *
 * In production the API does not build indexes when it starts (autoIndex off:
 * index builds can lock large collections), so every deployment runs this
 * once, before the new version starts. Creating an index that already exists
 * does nothing, so running it on every deploy is safe.
 */
import mongoose from 'mongoose';
import { loadConfig } from '../config/env.ts';
import { ensureIndexes } from '../database/indexes.ts';
import '../database/mongoose-settings.ts';
import { createLogger } from '../infrastructure/logger.ts';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ ...config, LOG_PRETTY: false });
  const started = Date.now();
  await mongoose.connect(config.MONGO_URL, {
    serverSelectionTimeoutMS: config.MONGO_SERVER_SELECTION_TIMEOUT_MS,
    autoIndex: false,
  });
  try {
    await ensureIndexes();
    logger.info({ event: 'db.migrated', durationMs: Date.now() - started }, 'indexes in place');
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(`db:migrate failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});

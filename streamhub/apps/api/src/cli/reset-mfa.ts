/**
 * Removes two-factor authentication from an account (lost authenticator and
 * lost recovery codes):
 *
 *   pnpm admin:mfa-reset --email admin@example.com
 *
 * Signs the account out everywhere. Confirm the person's identity before
 * running this: it removes a security control.
 */
import mongoose from 'mongoose';
import { loadConfig } from '../config/env.ts';
import '../database/mongoose-settings.ts';
import { createLogger } from '../infrastructure/logger.ts';
import { parseMfaResetArgs, resetMfa } from '../modules/admin/mfa-reset.ts';

async function main(): Promise<void> {
  const { email } = parseMfaResetArgs(process.argv.slice(2));
  const config = loadConfig();
  const logger = createLogger({ ...config, LOG_PRETTY: false });
  await mongoose.connect(config.MONGO_URL, {
    serverSelectionTimeoutMS: config.MONGO_SERVER_SELECTION_TIMEOUT_MS,
  });
  try {
    const result = await resetMfa(email, { logger });
    console.log(
      result === 'reset'
        ? `Two-factor authentication removed for ${email}; all sessions signed out.`
        : `${email} does not have two-factor authentication enabled. Nothing changed.`,
    );
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(`admin:mfa-reset failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});

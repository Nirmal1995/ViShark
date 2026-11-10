import { parseArgs } from 'node:util';
import { emailSchema } from '@streamhub/contracts';
import type { Logger } from 'pino';
import { clearMfa } from '../auth/mfa.service.ts';
import { revokeAllSessions } from '../auth/sessions.service.ts';
import { UserModel } from '../users/user.model.ts';
import { AdminBootstrapError } from './admin-bootstrap.ts';

/**
 * Logic behind `pnpm admin:mfa-reset --email <email>`: for someone who lost
 * both their authenticator and their recovery codes. Removes two-factor
 * authentication and signs the account out everywhere; the user then signs in
 * with their password and enrols again.
 *
 * Deliberately a server-side CLI, not an API endpoint: it needs shell access
 * to the server and the database credentials, so a stolen admin session
 * cannot use it to strip another admin's second factor.
 */
export function parseMfaResetArgs(argv: string[]): { email: string } {
  let values: { email?: string };
  try {
    ({ values } = parseArgs({ args: argv, options: { email: { type: 'string' } }, strict: true }));
  } catch (err) {
    throw new AdminBootstrapError(err instanceof Error ? err.message : 'invalid arguments');
  }
  const email = emailSchema.safeParse(values.email ?? '');
  if (!email.success) {
    throw new AdminBootstrapError('--email is required and must be a valid email address');
  }
  return { email: email.data };
}

export type MfaResetResult = 'reset' | 'not-enabled';

export async function resetMfa(email: string, deps: { logger: Logger }): Promise<MfaResetResult> {
  const user = await UserModel.findOne({ email }).exec();
  if (!user) throw new AdminBootstrapError(`no account found for ${email}`);
  if (!user.mfa?.enabledAt) return 'not-enabled';
  const userId = user._id.toString();
  await clearMfa(userId);
  const revokedSessions = await revokeAllSessions(userId);
  deps.logger.warn(
    { event: 'admin.mfa_reset', userId, revokedSessions, via: 'cli' },
    'two-factor authentication removed by operator',
  );
  return 'reset';
}

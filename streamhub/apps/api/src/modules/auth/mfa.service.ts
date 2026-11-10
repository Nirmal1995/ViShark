import { randomInt } from 'node:crypto';
import { RECOVERY_CODE_ALPHABET, type SecondFactor } from '@streamhub/contracts';
import type { Redis } from 'ioredis';
import mongoose from 'mongoose';
import type { Logger } from 'pino';
import { AppError } from '../../common/errors.ts';
import { sendInBackground, type Mailer } from '../../infrastructure/mailer.ts';
import { hit, serviceUnavailable, tooManyRequests } from '../../middleware/rate-limit.ts';
import { UserModel } from '../users/user.model.ts';
import {
  mfaDisabledEmail,
  mfaEnabledEmail,
  recoveryCodeUsedEmail,
  recoveryCodesRegeneratedEmail,
} from './emails.ts';
import type { PasswordHasher } from './password.ts';
import type { SecretBox } from './secret-box.ts';
import { base32Encode, generateTotpSecret, otpauthUri, verifyTotp } from './totp.ts';

/**
 * Two-factor authentication with TOTP (ADR-030, ADR-031).
 *
 * Enrolment: setup (password re-check) creates an encrypted pending seed and
 * returns it once; enable confirms it with a first code, activates it and
 * returns ten single-use recovery codes, shown once.
 *
 * Verification protects against:
 * - replay: each accepted code's time step is stored and a code is only
 *   accepted for a later step (atomic update, so two parallel requests with the
 *   same code cannot both succeed);
 * - guessing: failures are counted per account in Redis across all sign-in
 *   attempts (a 6-digit code has only a million values), and fail closed if
 *   Redis is down;
 * - database theft: seeds are encrypted and recovery codes are keyed hashes,
 *   both with keys that are not in the database.
 */
export const RECOVERY_CODE_COUNT = 10;
const SETUP_TTL_MS = 10 * 60_000;

export const invalidMfaCode = () =>
  new AppError(400, 'INVALID_MFA_CODE', 'The code is incorrect or has already been used');
const wrongPassword = () =>
  new AppError(400, 'INVALID_CURRENT_PASSWORD', 'The password is incorrect');
const notEnabled = () =>
  new AppError(409, 'MFA_NOT_ENABLED', 'Two-factor authentication is not enabled');

/** Ten characters from a 31-character alphabet: about 49 bits each. */
export function generateRecoveryCode(): string {
  let code = '';
  for (let i = 0; i < 10; i++)
    code += RECOVERY_CODE_ALPHABET[randomInt(RECOVERY_CODE_ALPHABET.length)];
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/** Same normalisation as the request schema: no dash, no spaces, lowercase. */
const normaliseRecoveryCode = (code: string) => code.toLowerCase().replace(/[\s-]/g, '');

/** Binds an encrypted seed to its owner (see secret-box.ts). */
const seedContext = (userId: string) => `user:${userId}`;

type MfaFields = {
  enabledAt: Date | null;
  secret: string | null;
  pendingSecret: string | null;
  pendingCreatedAt: Date | null;
  lastUsedStep: number;
  recoveryCodeHashes: string[];
};

export type MfaService = ReturnType<typeof createMfaService>;

export function createMfaService(deps: {
  box: SecretBox;
  hasher: PasswordHasher;
  redis: Redis;
  logger: Logger;
  mailer: Mailer;
  settings: { issuer: string; failureLimit: number; failureWindowSeconds: number };
  /** Tests move the clock to exercise replay and drift handling. */
  now?: () => number;
}) {
  const { box, hasher, settings } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.logger.child({ component: 'mfa' });
  const failureKey = (userId: string) => `mfa:fail:${userId}`;

  async function assertNotLocked(userId: string): Promise<void> {
    let failures: number;
    try {
      failures = Number((await deps.redis.get(failureKey(userId))) ?? 0);
    } catch {
      throw serviceUnavailable();
    }
    if (failures >= settings.failureLimit) {
      log.warn({ event: 'auth.mfa.locked', userId }, 'too many wrong codes');
      throw tooManyRequests('Too many incorrect codes. Please wait and try again.');
    }
  }

  async function recordFailure(userId: string, reason: string): Promise<never> {
    await hit(deps.redis, failureKey(userId), settings.failureWindowSeconds);
    log.warn({ event: 'auth.mfa.failed', userId, reason }, 'second factor rejected');
    throw invalidMfaCode();
  }

  async function loadWithPassword(userId: string, password: string) {
    const user = await UserModel.findById(userId)
      .select('+passwordHash +mfa.secret +mfa.pendingSecret +mfa.pendingCreatedAt')
      .exec();
    if (!user || !(await hasher.verify(user.passwordHash, password))) throw wrongPassword();
    return user;
  }

  async function issueRecoveryCodes(userId: string): Promise<string[]> {
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
    await UserModel.updateOne(
      { _id: userId },
      {
        $set: { 'mfa.recoveryCodeHashes': codes.map((c) => box.digest(normaliseRecoveryCode(c))) },
      },
    );
    return codes;
  }

  /**
   * Checks a TOTP code or a recovery code for a user with MFA enabled.
   * Throws INVALID_MFA_CODE (and counts the failure) if it is wrong or reused.
   */
  async function verify(userId: string, factor: SecondFactor): Promise<'totp' | 'recovery'> {
    await assertNotLocked(userId);
    const user = await UserModel.findById(userId).select('+mfa.secret').lean<{
      _id: mongoose.Types.ObjectId;
      email: string;
      displayName: string;
      mfa?: MfaFields;
    }>();
    if (!user?.mfa?.enabledAt || !user.mfa.secret) throw notEnabled();

    if ('code' in factor) {
      let secret: Buffer;
      try {
        secret = box.open(user.mfa.secret, seedContext(userId));
      } catch {
        // Wrong MFA_ENCRYPTION_KEY, or a seed copied from another account.
        // Never a 500 and never a hint to the caller; operators see the error.
        log.error({ event: 'auth.mfa.decrypt_failed', userId }, 'cannot decrypt mfa seed');
        return recordFailure(userId, 'undecryptable_seed');
      }
      const step = verifyTotp(secret, factor.code, now());
      if (step === null) return recordFailure(userId, 'wrong_code');
      // Atomic replay check: only one request can move lastUsedStep forward
      // to this step, so the same code cannot be used twice, even in parallel.
      const { modifiedCount } = await UserModel.updateOne(
        {
          _id: userId,
          'mfa.enabledAt': mongoose.trusted({ $ne: null }),
          'mfa.lastUsedStep': mongoose.trusted({ $lt: step }),
        },
        { $set: { 'mfa.lastUsedStep': step } },
      );
      if (modifiedCount !== 1) return recordFailure(userId, 'replayed_code');
      await deps.redis.del(failureKey(userId)).catch(() => undefined);
      return 'totp';
    }

    const digest = box.digest(normaliseRecoveryCode(factor.recoveryCode));
    // Atomic single use: the code is removed in the same operation that finds it.
    const updated = await UserModel.findOneAndUpdate(
      { _id: userId, 'mfa.recoveryCodeHashes': digest },
      { $pull: { 'mfa.recoveryCodeHashes': digest } },
      { returnDocument: 'after', projection: { 'mfa.recoveryCodeHashes': 1 } },
    ).lean<{ mfa?: { recoveryCodeHashes?: string[] } }>();
    if (!updated) return recordFailure(userId, 'wrong_recovery_code');
    const remaining = updated.mfa?.recoveryCodeHashes?.length ?? 0;
    await deps.redis.del(failureKey(userId)).catch(() => undefined);
    log.warn({ event: 'auth.mfa.recovery_used', userId, remaining }, 'recovery code used');
    sendInBackground(
      deps.mailer,
      recoveryCodeUsedEmail(user.email, user.displayName, remaining),
      log,
      'auth.email.mfa_recovery_used',
    );
    return 'recovery';
  }

  return {
    verify,

    /** Starts enrolment. The seed is returned once and never again. */
    async setup(userId: string, password: string) {
      const user = await loadWithPassword(userId, password);
      if (user.mfa?.enabledAt) {
        throw new AppError(409, 'MFA_ALREADY_ENABLED', 'Two-factor authentication is already on');
      }
      const secret = generateTotpSecret();
      await UserModel.updateOne(
        { _id: userId },
        {
          $set: {
            'mfa.pendingSecret': box.seal(secret, seedContext(userId)),
            'mfa.pendingCreatedAt': new Date(now()),
          },
        },
      );
      log.info({ event: 'auth.mfa.setup_started', userId }, 'mfa enrolment started');
      return {
        secret: base32Encode(secret),
        otpauthUri: otpauthUri({ issuer: settings.issuer, account: user.email, secret }),
      };
    },

    /** Confirms enrolment with a first code and returns the recovery codes. */
    async enable(userId: string, code: string): Promise<string[]> {
      await assertNotLocked(userId);
      const user = await UserModel.findById(userId)
        .select('+mfa.pendingSecret +mfa.pendingCreatedAt')
        .exec();
      if (!user) throw notEnabled();
      if (user.mfa?.enabledAt) {
        throw new AppError(409, 'MFA_ALREADY_ENABLED', 'Two-factor authentication is already on');
      }
      const pending = user.mfa?.pendingSecret;
      const startedAt = user.mfa?.pendingCreatedAt?.getTime() ?? 0;
      if (!pending || now() - startedAt > SETUP_TTL_MS) {
        throw new AppError(
          400,
          'MFA_SETUP_EXPIRED',
          'Setup has expired. Please start two-factor setup again.',
        );
      }
      const step = verifyTotp(box.open(pending, seedContext(userId)), code, now());
      if (step === null) return recordFailure(userId, 'wrong_setup_code');

      const { modifiedCount } = await UserModel.updateOne(
        { _id: userId, 'mfa.enabledAt': null, 'mfa.pendingSecret': pending },
        {
          $set: {
            'mfa.enabledAt': new Date(now()),
            'mfa.secret': pending,
            'mfa.pendingSecret': null,
            'mfa.pendingCreatedAt': null,
            'mfa.lastUsedStep': step,
          },
        },
      );
      if (modifiedCount !== 1) {
        throw new AppError(409, 'MFA_ALREADY_ENABLED', 'Two-factor authentication is already on');
      }
      const codes = await issueRecoveryCodes(userId);
      log.info({ event: 'auth.mfa.enabled', userId }, 'mfa enabled');
      sendInBackground(
        deps.mailer,
        mfaEnabledEmail(user.email, user.displayName),
        log,
        'auth.email.mfa_enabled',
      );
      return codes;
    },

    /** Turns MFA off. Needs the password and a second factor. */
    async disable(userId: string, password: string, factor: SecondFactor): Promise<void> {
      const user = await loadWithPassword(userId, password);
      if (!user.mfa?.enabledAt) throw notEnabled();
      await verify(userId, factor);
      await clearMfa(userId);
      log.warn({ event: 'auth.mfa.disabled', userId }, 'mfa disabled');
      sendInBackground(
        deps.mailer,
        mfaDisabledEmail(user.email, user.displayName),
        log,
        'auth.email.mfa_disabled',
      );
    },

    /** Replaces all recovery codes. Needs the password and a current TOTP code. */
    async regenerateRecoveryCodes(userId: string, password: string, code: string) {
      const user = await loadWithPassword(userId, password);
      if (!user.mfa?.enabledAt) throw notEnabled();
      await verify(userId, { code });
      const codes = await issueRecoveryCodes(userId);
      log.info({ event: 'auth.mfa.recovery_regenerated', userId }, 'recovery codes replaced');
      sendInBackground(
        deps.mailer,
        recoveryCodesRegeneratedEmail(user.email, user.displayName),
        log,
        'auth.email.mfa_recovery_regenerated',
      );
      return codes;
    },
  };
}

/**
 * Removes MFA from an account (operator action for a lost authenticator and
 * lost recovery codes). The caller also revokes the user's sessions.
 */
export async function clearMfa(userId: string): Promise<boolean> {
  const { modifiedCount } = await UserModel.updateOne(
    { _id: userId },
    {
      $set: {
        'mfa.enabledAt': null,
        'mfa.secret': null,
        'mfa.pendingSecret': null,
        'mfa.pendingCreatedAt': null,
        'mfa.lastUsedStep': 0,
        'mfa.recoveryCodeHashes': [],
      },
    },
  );
  return modifiedCount === 1;
}

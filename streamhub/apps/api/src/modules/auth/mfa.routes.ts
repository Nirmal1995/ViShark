import {
  mfaDisableBodySchema,
  mfaEnableBodySchema,
  mfaRecoveryCodesBodySchema,
  mfaSetupBodySchema,
  mfaVerifyBodySchema,
  type MfaDisableBody,
  type MfaEnableBody,
  type MfaRecoveryCodesBody,
  type MfaSetupBody,
  type MfaVerifyBody,
} from '@streamhub/contracts';
import { Router } from 'express';
import type { Redis } from 'ioredis';
import { Types } from 'mongoose';
import { AppError } from '../../common/errors.ts';
import { ok } from '../../common/http.ts';
import { requireAuth, requirePermission } from '../../middleware/authenticate.ts';
import { rateLimit } from '../../middleware/rate-limit.ts';
import { validate } from '../../middleware/validate.ts';
import { toUserDto } from '../users/user.dto.ts';
import type { AuthService } from './auth.service.ts';
import type { MfaService } from './mfa.service.ts';
import { destroy, save, startSession } from './session-actions.ts';
import { revokeOtherSessions } from './sessions.service.ts';

/** How long a password-verified sign-in waits for its second factor. */
export const MFA_CHALLENGE_TTL_MS = 5 * 60_000;
/** Wrong codes allowed per sign-in attempt (the account-wide limit is separate). */
export const MFA_CHALLENGE_MAX_ATTEMPTS = 5;

const challengeExpired = () =>
  new AppError(401, 'MFA_CHALLENGE_EXPIRED', 'Your sign-in has expired. Please sign in again.');

export function mfaRouter(deps: {
  auth: AuthService;
  mfa: MfaService;
  redis: Redis;
  limits: { ipLimit: number; ipWindowSeconds: number };
}): Router {
  const router = Router();
  const ipLimiter = (name: string) =>
    rateLimit({
      redis: deps.redis,
      name,
      limit: deps.limits.ipLimit,
      windowSeconds: deps.limits.ipWindowSeconds,
    });

  /** Second step of sign-in: exchanges a pending session for a real one. */
  router.post(
    '/verify',
    ipLimiter('mfa-verify'),
    validate({ body: mfaVerifyBodySchema }),
    async (req, res) => {
      const { body } = res.locals.validated as { body: MfaVerifyBody };
      const pending = req.session?.mfaPending;
      if (
        !pending ||
        Date.now() - pending.createdAt > MFA_CHALLENGE_TTL_MS ||
        pending.attempts >= MFA_CHALLENGE_MAX_ATTEMPTS
      ) {
        if (pending) await destroy(req);
        throw challengeExpired();
      }
      let method: 'totp' | 'recovery';
      try {
        method = await deps.mfa.verify(pending.userId, body);
      } catch (err) {
        pending.attempts += 1;
        await save(req);
        throw err;
      }
      const user = await deps.auth.completeLogin(pending.userId, method);
      // New session ID again: the pending one is discarded.
      const csrfToken = await startSession(req, user);
      res.set('Cache-Control', 'no-store');
      res.json(ok({ mfaRequired: false, user: toUserDto(user), csrfToken }));
    },
  );

  router.post(
    '/setup',
    requireAuth,
    requirePermission('mfa:manage-own'),
    ipLimiter('mfa-manage'),
    validate({ body: mfaSetupBodySchema }),
    async (req, res) => {
      const { body } = res.locals.validated as { body: MfaSetupBody };
      const result = await deps.mfa.setup(req.session.userId ?? '', body.password);
      res.set('Cache-Control', 'no-store');
      res.json(ok(result));
    },
  );

  router.post(
    '/enable',
    requireAuth,
    requirePermission('mfa:manage-own'),
    ipLimiter('mfa-manage'),
    validate({ body: mfaEnableBodySchema }),
    async (req, res) => {
      const { body } = res.locals.validated as { body: MfaEnableBody };
      const userId = req.session.userId ?? '';
      const recoveryCodes = await deps.mfa.enable(userId, body.code);
      // Sessions created before MFA was turned on never passed the second
      // factor: sign them out, and give this one a fresh session ID.
      await revokeOtherSessions(userId, req.session.handle);
      const csrfToken = await startSession(req, { _id: new Types.ObjectId(userId) });
      res.set('Cache-Control', 'no-store');
      res.json(ok({ recoveryCodes, csrfToken }));
    },
  );

  router.post(
    '/disable',
    requireAuth,
    ipLimiter('mfa-manage'),
    validate({ body: mfaDisableBodySchema }),
    async (req, res) => {
      const { body } = res.locals.validated as { body: MfaDisableBody };
      const { password, ...factor } = body;
      await deps.mfa.disable(req.session.userId ?? '', password, factor);
      res.status(204).end();
    },
  );

  router.post(
    '/recovery-codes',
    requireAuth,
    ipLimiter('mfa-manage'),
    validate({ body: mfaRecoveryCodesBodySchema }),
    async (req, res) => {
      const { body } = res.locals.validated as { body: MfaRecoveryCodesBody };
      const recoveryCodes = await deps.mfa.regenerateRecoveryCodes(
        req.session.userId ?? '',
        body.password,
        body.code,
      );
      res.set('Cache-Control', 'no-store');
      res.json(ok({ recoveryCodes }));
    },
  );

  return router;
}

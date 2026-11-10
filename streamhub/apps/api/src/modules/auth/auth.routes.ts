import {
  changePasswordBodySchema,
  emailOnlyBodySchema,
  loginBodySchema,
  registerBodySchema,
  resetPasswordBodySchema,
  sessionHandleParamsSchema,
  verifyEmailBodySchema,
  type ChangePasswordBody,
  type EmailOnlyBody,
  type LoginBody,
  type RegisterBody,
  type ResetPasswordBody,
  type VerifyEmailBody,
} from '@streamhub/contracts';
import { Router, type Response } from 'express';
import type { Redis } from 'ioredis';
import { notFound } from '../../common/errors.ts';
import { ok } from '../../common/http.ts';
import { requireAuth, requirePermission } from '../../middleware/authenticate.ts';
import { rateLimit } from '../../middleware/rate-limit.ts';
import { validate } from '../../middleware/validate.ts';
import { toUserDto } from '../users/user.dto.ts';
import type { AuthService } from './auth.service.ts';
import { cookieName } from './session.ts';
import { destroy, startMfaChallenge, startSession } from './session-actions.ts';
import { listSessions, revokeOtherSessions, revokeSession } from './sessions.service.ts';

const ACCEPTED_MESSAGE = 'If an account exists for this email, we have sent instructions to it.';

export function authRouter(deps: {
  auth: AuthService;
  redis: Redis;
  cookieSecure: boolean;
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
  const clearSessionCookie = (res: Response) =>
    res.clearCookie(cookieName(deps.cookieSecure), {
      path: '/',
      httpOnly: true,
      secure: deps.cookieSecure,
      sameSite: 'lax',
    });

  router.get('/session', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!req.user) {
      const pending = req.session?.mfaPending;
      res.json(ok({ authenticated: false, ...(pending ? { mfaPending: true } : {}) }));
      return;
    }
    res.json(
      ok({ authenticated: true, user: toUserDto(req.user), csrfToken: req.session.csrfToken }),
    );
  });

  router.post(
    '/register',
    ipLimiter('register'),
    validate({ body: registerBodySchema }),
    async (_req, res) => {
      const { body } = res.locals.validated as { body: RegisterBody };
      await deps.auth.register(body);
      res.status(202).json(
        ok({
          message:
            'If this email can be registered, you will receive a verification email shortly.',
        }),
      );
    },
  );

  router.post(
    '/verify-email',
    ipLimiter('verify'),
    validate({ body: verifyEmailBodySchema }),
    async (_req, res) => {
      const { body } = res.locals.validated as { body: VerifyEmailBody };
      await deps.auth.verifyEmail(body.token);
      res.json(ok({ verified: true }));
    },
  );

  router.post(
    '/resend-verification',
    ipLimiter('resend'),
    validate({ body: emailOnlyBodySchema }),
    async (_req, res) => {
      const { body } = res.locals.validated as { body: EmailOnlyBody };
      await deps.auth.resendVerification(body.email);
      res.status(202).json(ok({ message: ACCEPTED_MESSAGE }));
    },
  );

  router.post(
    '/forgot-password',
    ipLimiter('forgot'),
    validate({ body: emailOnlyBodySchema }),
    async (_req, res) => {
      const { body } = res.locals.validated as { body: EmailOnlyBody };
      await deps.auth.forgotPassword(body.email);
      res.status(202).json(ok({ message: ACCEPTED_MESSAGE }));
    },
  );

  router.post(
    '/reset-password',
    ipLimiter('reset'),
    validate({ body: resetPasswordBodySchema }),
    async (_req, res) => {
      const { body } = res.locals.validated as { body: ResetPasswordBody };
      await deps.auth.resetPassword(body);
      res.json(ok({ message: 'Your password has been changed. Please sign in.' }));
    },
  );

  router.post(
    '/login',
    ipLimiter('login'),
    validate({ body: loginBodySchema }),
    async (req, res) => {
      const { body } = res.locals.validated as { body: LoginBody };
      const { user, mfaRequired } = await deps.auth.login(body);
      res.set('Cache-Control', 'no-store');
      if (mfaRequired) {
        await startMfaChallenge(req, user._id.toString());
        res.json(ok({ mfaRequired: true }));
        return;
      }
      const csrfToken = await startSession(req, user);
      res.json(ok({ mfaRequired: false, user: toUserDto(user), csrfToken }));
    },
  );

  router.post(
    '/change-password',
    requireAuth,
    ipLimiter('change-password'),
    validate({ body: changePasswordBodySchema }),
    async (req, res) => {
      const { body } = res.locals.validated as { body: ChangePasswordBody };
      const userId = req.session.userId ?? '';
      const user = await deps.auth.changePassword(userId, body);
      // Sign out every other device, then give this one a brand-new session
      // (new ID, new CSRF token).
      await revokeOtherSessions(userId, req.session.handle);
      const csrfToken = await startSession(req, user);
      res.set('Cache-Control', 'no-store');
      res.json(ok({ csrfToken }));
    },
  );

  router.post('/logout', async (req, res) => {
    const userId = req.session?.userId;
    if (userId) {
      await destroy(req);
      req.log.info({ event: 'auth.logout', userId }, 'logged out');
    } else if (req.session?.mfaPending) {
      // Abandon a half-finished two-factor sign-in.
      await destroy(req);
    }
    clearSessionCookie(res);
    res.status(204).end();
  });

  router.get(
    '/sessions',
    requireAuth,
    requirePermission('sessions:manage-own'),
    async (req, res) => {
      const sessions = await listSessions(req.session.userId ?? '', req.session.handle);
      res.set('Cache-Control', 'no-store').json(ok(sessions));
    },
  );

  router.delete(
    '/sessions/:handle',
    requireAuth,
    requirePermission('sessions:manage-own'),
    validate({ params: sessionHandleParamsSchema }),
    async (req, res) => {
      const { params } = res.locals.validated as { params: { handle: string } };
      const removed = await revokeSession(req.session.userId ?? '', params.handle);
      // Same 404 whether the handle does not exist or belongs to someone else.
      if (!removed) throw notFound('Session not found');
      req.log.info(
        { event: 'auth.session.revoked', userId: req.session.userId },
        'session revoked',
      );
      if (params.handle === req.session.handle) clearSessionCookie(res);
      res.status(204).end();
    },
  );

  router.delete(
    '/sessions',
    requireAuth,
    requirePermission('sessions:manage-own'),
    async (req, res) => {
      const revoked = await revokeOtherSessions(req.session.userId ?? '', req.session.handle);
      req.log.info(
        { event: 'auth.session.revoked_others', userId: req.session.userId, revoked },
        'other sessions revoked',
      );
      res.json(ok({ revoked }));
    },
  );

  return router;
}

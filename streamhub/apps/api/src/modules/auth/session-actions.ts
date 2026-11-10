import type { Request } from 'express';
import type { Types } from 'mongoose';
import { randomToken } from './session.ts';

/** Promise wrappers around express-session's callback API. */
export const regenerate = (req: Request) =>
  new Promise<void>((resolve, reject) =>
    req.session.regenerate((err) => (err ? reject(err as Error) : resolve())),
  );
export const save = (req: Request) =>
  new Promise<void>((resolve, reject) =>
    req.session.save((err) => (err ? reject(err as Error) : resolve())),
  );
export const destroy = (req: Request) =>
  new Promise<void>((resolve, reject) =>
    req.session.destroy((err) => (err ? reject(err as Error) : resolve())),
  );

/**
 * Starts a fresh authenticated session. The previous session ID (if any) is
 * discarded: this is the session fixation defence, used at login and after a
 * password change.
 */
export async function startSession(req: Request, user: { _id: Types.ObjectId }): Promise<string> {
  await regenerate(req);
  const now = Date.now();
  req.session.userId = user._id.toString();
  req.session.handle = randomToken(16);
  req.session.csrfToken = randomToken(32);
  req.session.createdAt = now;
  req.session.lastSeenAt = now;
  req.session.userAgent = req.get('user-agent')?.slice(0, 256) ?? null;
  req.session.ip = req.ip ?? null;
  await save(req);
  return req.session.csrfToken;
}

/**
 * First step of a sign-in with two-factor authentication: the password was
 * right, so the session is regenerated (fixation defence) and marked as
 * waiting for the second factor. It carries no userId, so it grants nothing.
 */
export async function startMfaChallenge(req: Request, userId: string): Promise<void> {
  await regenerate(req);
  req.session.mfaPending = { userId, createdAt: Date.now(), attempts: 0 };
  await save(req);
}

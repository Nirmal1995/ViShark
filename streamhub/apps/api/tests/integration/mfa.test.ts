import type { Redis } from 'ioredis';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryMailer, type MailMessage } from '../../src/infrastructure/mailer.ts';
import { resetMfa } from '../../src/modules/admin/mfa-reset.ts';
import { base32Decode, totpAt } from '../../src/modules/auth/totp.ts';
import { UserModel } from '../../src/modules/users/user.model.ts';
import { silentLogger } from '../helpers.ts';
import {
  ORIGIN,
  PASSWORD,
  buildAuthApp,
  connectTestInfra,
  createUser,
  disconnectTestInfra,
  login,
  resetTestData,
  sessionIdFromCookies,
  testConfig,
} from './setup.ts';

let redis: Redis;
let app: ReturnType<typeof buildAuthApp>;
let sent: MailMessage[];
/** Test clock for TOTP: each test moves it forward explicitly. */
let clock = Date.UTC(2026, 10, 10, 12, 0, 0);
const STEP = 30_000;
const ADMIN = 'admin@example.com';

beforeAll(async () => {
  redis = await connectTestInfra();
});
beforeEach(async () => {
  await resetTestData();
  const memory = createMemoryMailer();
  sent = memory.sent;
  clock += 10 * STEP;
  app = buildAuthApp({
    redis,
    mailer: memory.mailer,
    now: () => clock,
    config: testConfig({ AUTH_MFA_FAILURE_LIMIT: '8' }),
  });
});
afterAll(disconnectTestInfra);

type Agent = ReturnType<typeof request.agent>;
const settle = () => new Promise((r) => setTimeout(r, 100));

/** Enrols the admin and returns the TOTP seed, recovery codes and a signed-in agent. */
async function enrolAdmin({ createAccount = true } = {}) {
  if (createAccount) await createUser({ email: ADMIN, role: 'ADMIN' });
  const session = await login(app, ADMIN);
  const setup = await session.agent
    .post('/api/v1/auth/mfa/setup')
    .set('Origin', ORIGIN)
    .set('X-CSRF-Token', session.csrfToken)
    .send({ password: PASSWORD });
  expect(setup.status).toBe(200);
  const secret = base32Decode(setup.body.data.secret as string);
  const enable = await session.agent
    .post('/api/v1/auth/mfa/enable')
    .set('Origin', ORIGIN)
    .set('X-CSRF-Token', session.csrfToken)
    .send({ code: totpAt(secret, clock) });
  expect(enable.status).toBe(200);
  clock += STEP; // the enrolment code's step is now used up
  return {
    secret,
    agent: session.agent,
    csrfToken: enable.body.data.csrfToken as string,
    recoveryCodes: enable.body.data.recoveryCodes as string[],
  };
}

/** Password step of sign-in for an MFA account: returns the pending agent. */
async function passwordStep(email = ADMIN): Promise<Agent> {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/v1/auth/login')
    .set('Origin', ORIGIN)
    .send({ email, password: PASSWORD });
  expect(res.status).toBe(200);
  expect(res.body.data).toEqual({ mfaRequired: true });
  return agent;
}

const verify = (agent: Agent, body: object) =>
  agent.post('/api/v1/auth/mfa/verify').set('Origin', ORIGIN).send(body);

describe('enrolment', () => {
  it('is admin only', async () => {
    await createUser();
    const { agent, csrfToken } = await login(app);
    const res = await agent
      .post('/api/v1/auth/mfa/setup')
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', csrfToken)
      .send({ password: PASSWORD });
    expect(res.status).toBe(403);
  });

  it('requires the current password to start', async () => {
    await createUser({ email: ADMIN, role: 'ADMIN' });
    const { agent, csrfToken } = await login(app, ADMIN);
    const res = await agent
      .post('/api/v1/auth/mfa/setup')
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', csrfToken)
      .send({ password: 'wrong password entirely' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_CURRENT_PASSWORD');
  });

  it('returns the seed once, stores it encrypted, and needs a correct first code', async () => {
    await createUser({ email: ADMIN, role: 'ADMIN' });
    const { agent, csrfToken } = await login(app, ADMIN);
    const setup = await agent
      .post('/api/v1/auth/mfa/setup')
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', csrfToken)
      .send({ password: PASSWORD });
    const { secret, otpauthUri } = setup.body.data as { secret: string; otpauthUri: string };
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(otpauthUri).toContain(`secret=${secret}`);
    expect(setup.headers['cache-control']).toBe('no-store');

    const stored = await UserModel.findOne({ email: ADMIN }).select('+mfa.pendingSecret').lean();
    expect(stored?.mfa?.pendingSecret).toMatch(/^v1\./);
    expect(JSON.stringify(stored)).not.toContain(secret);
    expect(JSON.stringify(stored)).not.toContain(base32Decode(secret).toString('base64url'));

    const wrong = await agent
      .post('/api/v1/auth/mfa/enable')
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', csrfToken)
      .send({ code: '000000' === totpAt(base32Decode(secret), clock) ? '111111' : '000000' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe('INVALID_MFA_CODE');
    expect((await UserModel.findOne({ email: ADMIN }).lean())?.mfa?.enabledAt).toBeNull();
  });

  it('turns MFA on, returns 10 recovery codes, rotates the session and signs out other devices', async () => {
    await createUser({ email: ADMIN, role: 'ADMIN' });
    const other = await login(app, ADMIN);
    const { agent, recoveryCodes } = await enrolAdmin({ createAccount: false });

    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);
    for (const code of recoveryCodes)
      expect(code).toMatch(/^[a-hjkmnp-z2-9]{5}-[a-hjkmnp-z2-9]{5}$/);

    const me = await agent.get('/api/v1/users/me');
    expect(me.body.data.mfaEnabled).toBe(true);
    expect((await other.agent.get('/api/v1/users/me')).status).toBe(401);

    const stored = await UserModel.findOne({ email: ADMIN })
      .select('+mfa.recoveryCodeHashes')
      .lean();
    const hashes = stored?.mfa?.recoveryCodeHashes ?? [];
    expect(hashes).toHaveLength(10);
    for (const code of recoveryCodes)
      expect(JSON.stringify(hashes)).not.toContain(code.replace('-', ''));

    await settle();
    expect(
      sent.some((m) => m.to === ADMIN && /Two-factor authentication is on/.test(m.subject)),
    ).toBe(true);
  });

  it('refuses a second enrolment while MFA is on', async () => {
    const { agent, csrfToken } = await enrolAdmin();
    const res = await agent
      .post('/api/v1/auth/mfa/setup')
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', csrfToken)
      .send({ password: PASSWORD });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('MFA_ALREADY_ENABLED');
  });
});

describe('sign-in with a second factor', () => {
  it('the password alone gives a pending session that grants nothing', async () => {
    await enrolAdmin();
    const pending = await passwordStep();
    const me = await pending.get('/api/v1/users/me');
    expect(me.status).toBe(401);
    expect(me.body.error.code).toBe('MFA_REQUIRED');
    const state = await pending.get('/api/v1/auth/session');
    expect(state.body.data).toEqual({ authenticated: false, mfaPending: true });
  });

  it('a correct code completes sign-in with a new session ID', async () => {
    const { secret } = await enrolAdmin();
    const agent = request.agent(app);
    const first = await agent
      .post('/api/v1/auth/login')
      .set('Origin', ORIGIN)
      .send({ email: ADMIN, password: PASSWORD });
    const pendingId = sessionIdFromCookies(first.headers['set-cookie'] as unknown as string[]);

    const res = await verify(agent, { code: totpAt(secret, clock) });
    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe(ADMIN);
    expect(res.body.data.csrfToken).toBeTypeOf('string');
    const finalId = sessionIdFromCookies(res.headers['set-cookie'] as unknown as string[]);
    expect(finalId).not.toBe(pendingId);
    expect((await agent.get('/api/v1/users/me')).status).toBe(200);
  });

  it('accepts one step of clock drift', async () => {
    const { secret } = await enrolAdmin();
    // The step right after enrolment; the enrolment step itself is used up.
    clock += STEP;
    const pending = await passwordStep();
    expect((await verify(pending, { code: totpAt(secret, clock - STEP) })).status).toBe(200);
  });

  it('never accepts the same code twice (replay)', async () => {
    const { secret } = await enrolAdmin();
    const code = totpAt(secret, clock);
    expect((await verify(await passwordStep(), { code })).status).toBe(200);
    const replay = await verify(await passwordStep(), { code });
    expect(replay.status).toBe(400);
    expect(replay.body.error.code).toBe('INVALID_MFA_CODE');
  });

  it('two parallel requests with the same code: exactly one succeeds', async () => {
    const { secret } = await enrolAdmin();
    const code = totpAt(secret, clock);
    const [a, b] = [await passwordStep(), await passwordStep()];
    const results = await Promise.all([verify(a, { code }), verify(b, { code })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
  });

  it('a recovery code works once, in any case and with or without the dash', async () => {
    const { recoveryCodes } = await enrolAdmin();
    const code = recoveryCodes[0]!;
    const res = await verify(await passwordStep(), {
      recoveryCode: code.toUpperCase().replace('-', ''),
    });
    expect(res.status).toBe(200);
    const again = await verify(await passwordStep(), { recoveryCode: code });
    expect(again.status).toBe(400);

    const stored = await UserModel.findOne({ email: ADMIN })
      .select('+mfa.recoveryCodeHashes')
      .lean();
    expect(stored?.mfa?.recoveryCodeHashes).toHaveLength(9);
    await settle();
    const notice = sent.find((m) => /recovery code was used/.test(m.subject));
    expect(notice?.text).toContain('9 unused recovery codes');
  });

  it('ends the attempt after 5 wrong codes', async () => {
    const { secret } = await enrolAdmin();
    const pending = await passwordStep();
    const wrong = String((Number(totpAt(secret, clock)) + 500_000) % 1_000_000).padStart(6, '0');
    for (let i = 0; i < 5; i++) expect((await verify(pending, { code: wrong })).status).toBe(400);
    const sixth = await verify(pending, { code: totpAt(secret, clock) });
    expect(sixth.status).toBe(401);
    expect(sixth.body.error.code).toBe('MFA_CHALLENGE_EXPIRED');
  });

  it('limits wrong codes per account across sign-in attempts, even with a right code after', async () => {
    const { secret } = await enrolAdmin();
    const wrong = String((Number(totpAt(secret, clock)) + 500_000) % 1_000_000).padStart(6, '0');
    for (let attempt = 0; attempt < 2; attempt++) {
      const pending = await passwordStep();
      for (let i = 0; i < 4; i++) await verify(pending, { code: wrong });
    }
    const blocked = await verify(await passwordStep(), { code: totpAt(secret, clock) });
    expect(blocked.status).toBe(429);
  });

  it('expires a pending sign-in after 5 minutes', async () => {
    const { secret } = await enrolAdmin();
    const pending = await passwordStep();
    await mongoose.connection
      .collection('sessions')
      .updateMany(
        { 'session.mfaPending': { $exists: true } },
        { $set: { 'session.mfaPending.createdAt': Date.now() - 6 * 60_000 } },
      );
    const res = await verify(pending, { code: totpAt(secret, clock) });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('MFA_CHALLENGE_EXPIRED');
  });

  it('refuses verify without a pending sign-in', async () => {
    const res = await request(app)
      .post('/api/v1/auth/mfa/verify')
      .set('Origin', ORIGIN)
      .send({ code: '123456' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('MFA_CHALLENGE_EXPIRED');
  });

  it('respects a deactivation between the password and the code', async () => {
    const { secret } = await enrolAdmin();
    const pending = await passwordStep();
    await UserModel.updateOne({ email: ADMIN }, { $set: { status: 'DEACTIVATED' } });
    expect((await verify(pending, { code: totpAt(secret, clock) })).status).toBe(401);
  });

  it('a seed copied onto another account does not work there', async () => {
    const { secret } = await enrolAdmin();
    const source = await UserModel.findOne({ email: ADMIN }).select('+mfa.secret').lean();
    await createUser({ email: 'other-admin@example.com', role: 'ADMIN' });
    await UserModel.updateOne(
      { email: 'other-admin@example.com' },
      { $set: { 'mfa.enabledAt': new Date(), 'mfa.secret': source?.mfa?.secret } },
    );
    const pending = await passwordStep('other-admin@example.com');
    const res = await verify(pending, { code: totpAt(secret, clock) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_MFA_CODE');
  });
});

describe('managing MFA', () => {
  it('turning it off needs the password and a second factor', async () => {
    const { secret, agent, csrfToken } = await enrolAdmin();
    const post = (body: object) =>
      agent
        .post('/api/v1/auth/mfa/disable')
        .set('Origin', ORIGIN)
        .set('X-CSRF-Token', csrfToken)
        .send(body);
    expect((await post({ code: totpAt(secret, clock) })).status).toBe(400);
    expect(
      (await post({ password: 'wrong password entirely', code: totpAt(secret, clock) })).status,
    ).toBe(400);
    const wrongCode = String((Number(totpAt(secret, clock)) + 500_000) % 1_000_000).padStart(
      6,
      '0',
    );
    const refused = await post({ password: PASSWORD, code: wrongCode });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('INVALID_MFA_CODE');
    expect((await post({ password: PASSWORD, code: totpAt(secret, clock) })).status).toBe(204);

    await settle();
    expect(sent.some((m) => /turned off/.test(m.subject))).toBe(true);
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', ORIGIN)
      .send({ email: ADMIN, password: PASSWORD });
    expect(res.body.data.mfaRequired).toBe(false);
  });

  it('new recovery codes replace the old ones', async () => {
    const { secret, agent, csrfToken, recoveryCodes } = await enrolAdmin();
    const res = await agent
      .post('/api/v1/auth/mfa/recovery-codes')
      .set('Origin', ORIGIN)
      .set('X-CSRF-Token', csrfToken)
      .send({ password: PASSWORD, code: totpAt(secret, clock) });
    expect(res.status).toBe(200);
    const fresh = res.body.data.recoveryCodes as string[];
    expect(fresh).toHaveLength(10);
    expect((await verify(await passwordStep(), { recoveryCode: recoveryCodes[1]! })).status).toBe(
      400,
    );
    expect((await verify(await passwordStep(), { recoveryCode: fresh[0]! })).status).toBe(200);
  });

  it('pnpm admin:mfa-reset removes MFA and signs the account out everywhere', async () => {
    const { agent } = await enrolAdmin();
    expect(await resetMfa(ADMIN, { logger: silentLogger })).toBe('reset');
    expect((await agent.get('/api/v1/users/me')).status).toBe(401);
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', ORIGIN)
      .send({ email: ADMIN, password: PASSWORD });
    expect(res.body.data.mfaRequired).toBe(false);
    expect(await resetMfa(ADMIN, { logger: silentLogger })).toBe('not-enabled');
  });

  it('no secrets leave the API in user responses', async () => {
    const { agent } = await enrolAdmin();
    const me = await agent.get('/api/v1/users/me');
    expect(Object.keys(me.body.data)).not.toContain('mfa');
    expect(JSON.stringify(me.body)).not.toMatch(/v1\.|recovery|secret/i);
  });
});

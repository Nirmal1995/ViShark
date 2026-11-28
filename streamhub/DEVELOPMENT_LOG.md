# Development Log

## 2026-11-09: Phase 0, environment inspection and architecture

### Completed

- Wrote read-only inspection scripts (`E:\Jenkins\ViShark\phase0\`) for the Windows host and WSL.
- Collected and analysed both reports.
- Verified current versions of Node.js and all critical dependencies against the npm registry and the Node release schedule.
- Produced `docs/architecture/phase-0-environment-and-plan.md` and ADR-001 to ADR-012.

### Decisions

- Node 26 LTS, pnpm 12.18 via npm, TypeScript pinned to 6.0.3 (ADR-003, ADR-004).
- Same-origin API, server-side Mongo sessions, own CSRF middleware (ADR-006, 007, 011).
- Proposed: repo stays on E: (ADR-002), MinIO fork `pgsty/silo` for local storage (ADR-005), merged `contracts` package (ADR-008).

### Errors encountered

1. WSL script hung at `docker version`.
   - Root cause: Docker Engine in WSL is socket activated; the first CLI call waited while dockerd started and restarted existing containers.
   - Resolution: added `timeout` to every Docker step in both scripts. Future scripts will wait for the daemon with a bounded retry.
2. `corepack` in WSL failed with `/bin/sh^M: bad interpreter`.
   - Root cause: WSL appends the Windows PATH, so the Windows Node install's CRLF shell shim was found.
   - Resolution (planned): install Node and pnpm inside WSL so Linux binaries come first.
3. `minio/minio` image no longer available.
   - Root cause: upstream discontinued the community edition and removed the images.
   - Resolution: ADR-005 proposal.

### Outcome

- Plan approved 2026-11-09 (ADR-002, ADR-005, ADR-008 accepted). Prerequisites installed by the user.

## 2026-11-09: Phase 1, project foundation

### Completed

- pnpm workspace (`apps/*`, `packages/*`), TypeScript 6.0 strict base config, ESLint 10 flat config with type-aware rules, Prettier, Vitest, EditorConfig, LF enforcement.
- `packages/shared` with the `Role` type and tests (proves typecheck, lint and test run across the workspace).
- Docker Compose: MongoDB 8.0 (auth + single-node replica set), Redis 8.4 (auth, noeviction), Silo storage + idempotent init job (private buckets, least-privilege app user), Mailpit. Health checks, named volumes, loopback-only ports, memory limits, log rotation.
- Scripts: `doctor`, `env:init`, `infra:up/down/status/logs/verify/reset`, all logging to `.logs/`.
- `scripts/verify-infra.ts`: 14 positive and negative checks.
- Docs: README, `docs/operations/local-infrastructure.md`, ADR-013 to ADR-016.

### Validation done in the assistant sandbox (before handing over)

- `pnpm install`, `pnpm check` (typecheck, lint, format, tests): pass.
- Planted type errors in `packages/shared` and `scripts/` are caught by `pnpm typecheck`.
- `docker compose config`: valid. ShellCheck: clean.
- `env:init`: generates 5 secrets, mode 600, refuses to overwrite.
- Redis checks run against a real Redis, plus two negative controls (wrong eviction policy, no password) that correctly fail.
- Not possible in the sandbox (registry blocked): pulling images and starting the stack. That is done on the user's machine.

### Errors encountered

1. `pnpm install` rejected typescript-eslint 8.72.2 and @aws-sdk/client-s3 3.1165.0.
   - Root cause: both were published less than 24 h earlier; `minimumReleaseAge` blocked them (working as intended).
   - Resolution: pinned the newest versions older than 2 days (8.72.1, 3.1164.0).
2. `ERR_PNPM_IGNORED_BUILDS` for esbuild.
   - Root cause: pnpm 12 fails the install when a dependency wants to run an install script that is not approved.
   - Resolution: approved esbuild explicitly in `allowBuilds`.
3. `init-env` reported unreplaced placeholders.
   - Root cause: the explanatory comment in `.env.example` contained the placeholder prefix.
   - Resolution: reworded the comment; the script now writes to a temp file and only moves it into place when complete.
4. Redis negative check failed with `Connection is closed`.
   - Root cause: ioredis 6 sends `HELLO` during connect, so Redis rejects an unauthenticated client at handshake time, not at the first command.
   - Resolution: the check collects errors from both the connection and the command and requires a `NOAUTH` reply.

5. `pnpm lint` appeared to hang on the user's machine.
   - Investigation: ran ESLint against the user's folder with `--debug`, a module-load trace, `strace` and per-module timing. The process was not deadlocked: it was waiting on the filesystem for each of thousands of `stat`/`open` calls (around 10 ms each) while loading typescript-eslint and the TypeScript type definitions.
   - Root cause: repo on NTFS accessed from Linux (ADR-002 trade-off). Not a configuration error.
   - Resolution: no code change; documented in the README. `pnpm check` completed and passed on the user's machine. Long-term option: clone into the WSL filesystem after the GitHub push.
6. `pnpm doctor` ran pnpm's own built-in diagnostics instead of our script.
   - Root cause: pnpm 12 has a built-in `doctor` command, which takes precedence over a package script with the same name.
   - Resolution: renamed the script to `env:check`.

### Acceptance results (user's machine, 2026-11-09)

| Criterion                                              | Result                                    |
| ------------------------------------------------------ | ----------------------------------------- |
| `pnpm install`                                         | pass                                      |
| `pnpm check` (typecheck, lint, format, 7 tests)        | pass (lint slow on `/mnt/e`, see error 6) |
| All 4 services healthy (`pnpm infra:up`)               | pass                                      |
| Connectivity and security checks (`pnpm infra:verify`) | 15/15 pass                                |
| `pnpm env:check`                                       | pending (renamed script)                  |

### Outcome

- Phase 1 approved by the user on 2026-11-10.

## 2026-11-10: Phase 2, backend foundation

### Completed

- `apps/api`: Express 5 app factory (`app.ts`) separated from process startup (`server.ts`).
- Configuration: Zod-validated environment, fail-fast with all problems listed, values never echoed.
- Logging: Pino JSON, request and correlation IDs (strictly validated when supplied by upstream), redaction list, pretty mode for local only.
- Errors: `AppError` hierarchy, single error handler, standard envelope, 400/404/413/415/500 mapping, no internals in responses.
- Validation middleware with strict Zod schemas (blocks mass assignment and operator injection).
- MongoDB: Mongoose with `sanitizeFilter`, `strictQuery`, no command buffering; credentials redacted in logs; start-before-connect with capped exponential backoff.
- Health: `/health/live` (no dependencies), `/health/ready` (MongoDB ping with timeout, not ready while draining).
- Metrics: Prometheus on internal port 4001 with bounded route labels.
- OpenAPI 3.1 from Zod, Swagger UI at `/api/docs` with its own CSP.
- Graceful shutdown on SIGTERM/SIGINT with a hard deadline; fatal exit on unhandled rejections.
- Docs: `docs/api/conventions.md`, `docs/operations/observability.md`, ADR-017 to ADR-020.

### Validation done in the assistant sandbox

- 37 unit tests (config, health service, URL redaction, full app via Supertest) pass; `pnpm check` passes.
- Mutation checks: deliberately broke error masking, request ID validation and draining logic; tests failed each time. Removing `app.disable('x-powered-by')` did not fail the test because Helmet also removes the header (two layers).
- Ran the real server without MongoDB: live 200, ready 503 with backoff retries, metrics only on the internal port, password absent from logs, SIGTERM exit 0, missing config exits 1 with a clear message.
- Compiled build (`tsc` to `dist/`) runs under plain `node`.
- Not possible in the sandbox: the MongoDB integration tests (run on the user's machine).

### Errors encountered

1. TypeScript `erasableSyntaxOnly` rejected constructor parameter properties. Root cause: that syntax generates code, which Node's built-in type stripping cannot handle. Fix: explicit fields.
2. Module augmentation of `express-serve-static-core` failed. Root cause: pnpm's strict layout does not expose transitive type packages. Fix: augment the global `Express.Request` interface; renamed our field to `requestId` to avoid clashing with pino-http's `req.id` type.
3. `pnpm install` failed on `@scarf/scarf` install script. Root cause: `swagger-ui-dist` depends on an install-time analytics package. Fix: explicitly denied in `allowBuilds`.
4. Each failed MongoDB connection attempt was logged twice (driver event plus retry loop). Fix: the retry loop logs only the retry decision.
5. `tsx watch` does not see edits made from the Windows side on `/mnt/e` (no inotify events). Fix: dev script enables chokidar polling (`CHOKIDAR_USEPOLLING=1`).

6. Found by the user on the running API: the request log `msg` showed `GET / 301` and `GET /swagger-ui.css` for requests to `/api/docs/...`, while the `path` field was correct.
   - Root cause: Express rewrites `req.url` inside routers mounted with `app.use('/api/docs', ...)`; the message template used `req.url` instead of `req.originalUrl`.
   - Resolution: one `pathOf()` helper (originalUrl, query string removed) used by the serializer, the messages and the health-probe filter. Regression tests assert on real log output through the production logger configuration; reintroducing the bug fails two tests.
7. My first fix attempt for error 6 did not apply: the scripted search-and-replace targeted text that Prettier had since reformatted, and failed silently. The new regression test exposed it.
   - Lesson: rewrite whole files (or assert the replacement happened) instead of blind string replacement, and let a test prove each fix.

### Acceptance results (user's machine, 2026-11-10)

| Criterion                                                                                                                            | Result |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| `pnpm env:check`                                                                                                                     | pass   |
| `pnpm check` (typecheck, lint, format, 49 unit tests)                                                                                | pass   |
| `pnpm test:integration` (3 tests against real MongoDB)                                                                               | pass   |
| API starts, connects, serves `/health/*`, `/api/v1`, Swagger UI, metrics on 4001                                                     | pass   |
| Real outage: `docker compose stop mongo` makes readiness `not_ready`; after `start` it returns to `ready` without restarting the API | pass   |

Observation: the integration run took 180 s, 97% of it module import time across the Windows/WSL filesystem boundary (the test itself ran in 0.6 s). Strengthens the case for cloning into the WSL filesystem after the GitHub push.

### Outcome

- Phase 2 complete on 2026-11-10.

## 2026-11-10: Phase 3a, authentication core

Decisions confirmed with the user: split Phase 3 into 3a/3b; idle timeout 30 min, absolute 12 h; admin TOTP MFA in 3b.

### Completed

- `packages/contracts` (Zod schemas shared with the future web app) and `packages/shared` permissions table.
- `users` model (unique normalised email, hidden password hash, strict schema) and DTO.
- Argon2id hashing with rehash-on-login and timing-equalised verification for unknown emails.
- Server-side sessions (express-session + connect-mongo): hashed session IDs, public handles, regeneration at login, server-enforced idle/absolute timeouts, TTL cleanup.
- CSRF: Origin / Sec-Fetch-Site check plus synchronizer token.
- Redis rate limiting per IP (IPv6 /64) and per-email failure throttling, failing closed.
- Endpoints: `GET /auth/session`, `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `GET/DELETE /auth/sessions`, `DELETE /auth/sessions/:handle`, `GET/PATCH /users/me`.
- RBAC middleware (`requireAuth`, `requirePermission`) with the user reloaded on each request.
- `admin:create` CLI; `env:sync` and `infra:test-db` scripts; Redis added to readiness.
- OpenAPI paths for all new endpoints; docs: authentication design, database collections, security events; ADR-021 to ADR-024.

### Validation done in the assistant sandbox

- Obtained MongoDB 8.3 server binaries from conda-forge (Docker Hub and MongoDB downloads are blocked in the sandbox) and configured it like the local stack (replica set, keyfile, root + least-privilege app user). The Phase 2 integration tests passed against it first, confirming parity.
- 89 API unit tests, 27 package tests, 45 integration tests (registration, login, enumeration, NoSQL injection, login CSRF, rehash, hashed session storage, fixation, CSRF token, logout replay, idle and absolute timeouts, account and IP throttling, Redis outage, RBAC, live role change, deactivation, profile mass assignment, IDOR on users and sessions, session list/revoke, MongoDB outage, admin CLI).
- Sabotage check: ten security controls disabled one at a time; every one made tests fail.
- End-to-end with curl against the running server: admin CLI, register, unverified login refused, login, cookie flags, session list, CSRF refusal and success, logout, cookie replay refused; no passwords or tokens in logs.

### Errors encountered

1. `pnpm install` blocked argon2's install script. Root cause: install scripts are denied unless approved (ADR-015). Fix: approved argon2 (it selects its prebuilt native binary).
2. Session timeout fields typed as optional by express-session. Fix: treat missing timestamps as expired.
3. Integration reset failed with "not authorized ... dropDatabase". Root cause: the app user has readWrite only, correctly without dbAdmin. Fix: empty collections instead of dropping the database. (The least-privilege setup working as intended.)
4. Fixation test failed: the second login reused an authenticated session without the CSRF token, so it was correctly rejected; the rolling cookie made the old ID reappear. Fix: test sends the token and separately asserts the rejection.
5. Phase 2 MongoDB integration test failed after `SESSION_SECRET` became required. Fix: shared test configuration helper.

6. On the user's machine, all 5 `admin:create` CLI tests timed out (40/45 integration tests passed).
   - Root cause: each test started the CLI as a fresh Node process, which re-loads TypeScript, Mongoose and argon2 across the `/mnt/e` boundary: about 45 s per launch there versus about 2 s in the sandbox. The tests also used `spawnSync`, which blocks Vitest's event loop, so even the cleanup hook timed out.
   - Resolution: logic moved to `modules/admin/admin-bootstrap.ts` and tested in-process (argument parsing as unit tests, create/idempotent/promote/policy as integration tests). One end-to-end smoke test still launches the real command, with non-blocking `spawn` and a 180 s timeout. The CLI itself was never broken: the user created their admin with it.
7. Mongoose 9 deprecation warning for the `new` option of `findByIdAndUpdate`. Fix: `returnDocument: 'after'`.

### Acceptance results (user's machine, first run)

| Criterion                                                                    | Result                                                                                                                                                              |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install` (argon2 install script approved), `env:sync`, `infra:test-db` | pass                                                                                                                                                                |
| `pnpm admin:create`                                                          | pass (admin created)                                                                                                                                                |
| `pnpm check` (typecheck, lint, format, 98 unit and package tests)            | pass                                                                                                                                                                |
| `pnpm test:integration`                                                      | 40/45 on first run; after the fix for error 6, `create-admin.test.ts` 5/5 (the real CLI launch took 56 s, confirming the diagnosis) and `admin-args.test.ts` 7/7    |
| Manual check in Swagger UI (login, CSRF token, sessions, profile)            | pass: login, wrong password (401), CSRF token flow, session list, profile update; an update after 38 idle minutes correctly returned 401 (led to `SESSION_EXPIRED`) |

### Outcome

Accepted by the user on 2026-11-10. Two usability findings from the manual check carried into 3b-1: Swagger showed placeholder examples (`"string"`), and an idle-expired session gave the same error as never having signed in.

## 2026-11-10: Phase 3b-1, account email flows

Phase 3b split into 3b-1 (email flows) and 3b-2 (admin TOTP MFA) to keep each checkpoint reviewable.

### Completed

- SMTP mailer (nodemailer to Mailpit locally) with background sending and an in-memory mailer for tests. HTML-escaped templates: verification, already-registered notice, password reset, password changed, account deactivated.
- Single-use tokens for verification and reset: 256-bit random, stored as SHA-256, atomic consumption, TTL expiry, sent in the URL fragment.
- Endpoints: `POST /auth/verify-email`, `/auth/resend-verification`, `/auth/forgot-password`, `/auth/reset-password`, `/auth/change-password`, `POST /users/me/deactivate`.
- Registration now emails a verification link, or notifies the existing owner on a duplicate.
- Per-address email cap (3 per kind per hour), applied whether or not the account exists.
- Common-password check (1,186 entries of 12+ characters from SecLists NCSC 100k, MIT, attribution in the file) and "password equals email" check, also in `admin:create`.
- `401 SESSION_EXPIRED` for a cookie the server no longer accepts, distinct from `401 UNAUTHENTICATED`.
- Swagger: realistic request examples and a per-status error example for every response.
- Mongoose safety settings moved to `database/mongoose-settings.ts` and loaded by the integration tests too (see error 4).
- Docs: authentication design (email flows, residual risks), collections, security events; ADR-025 to ADR-029.

### Validation done in the assistant sandbox

- 86 API unit tests, 27 package tests, 69 integration tests (new: 19 email-flow tests, real SMTP delivery to Mailpit, 3 Mongoose-settings tests).
- Sabotage check: ten 3b-1 controls disabled one at a time (token single use, token hashing, token expiry, session revocation on reset, current-password check, password check on deactivate, email cap, common-password list, `SESSION_EXPIRED`, HTML escaping); every one made tests fail.
- Real server with real SMTP to Mailpit, scripted with curl: register, weak password refused, unverified login refused, link read from Mailpit, verify, replay refused, login, change password, forgot for known and unknown emails, reset, old session revoked, reset replay refused, old password refused, new password accepted, deactivate, login refused, 5 emails delivered. 20/20 checks passed; no token or password in the logs.

### Errors encountered

1. Policy unit tests asserted on `message` while the reason is in `details[0].message`. Fix: assert on details.
2. Lint: an inline `import()` type and an unused `_ignored` variable. Fix: proper type import; added `varsIgnorePattern: '^_'` to match the existing args rule.
3. `pnpm install` needed again for nodemailer (lockfile change).
4. **`POST /auth/verify-email` returned 500 on the real server while all 179 tests passed.**
   - Symptom: `CastError: Cast to date failed for value "{ '$gt': ... }" at path "expiresAt"`.
   - Root cause: the global `sanitizeFilter` setting (which blocks NoSQL injection) treats every operator in a query filter as untrusted input, including the server's own `{ $gt: now }`. The integration tests connected Mongoose directly and never loaded the module that applies the setting, so they ran with weaker settings than production.
   - Fix: the operator is wrapped in `mongoose.trusted()`. The settings moved to `mongoose-settings.ts`, imported by both the connection module and the test setup, plus a test asserting each setting is active, that an injected `{ $ne: null }` is rejected and that trusted operators still work. With the old code the email-flow tests now fail (8 failures), so this class of bug cannot hide again.
   - Lesson: the real-server run is not optional; it found what 179 green tests did not.
5. The first curl run reported 6 failures. All were mistakes in the test script (wrong field name `newPassword` for reset, expected `200`/`401` where the API correctly returns `204` for deactivate and `403 ACCOUNT_DEACTIVATED` after a correct password). The API was right; the script was fixed.

### Acceptance criteria

| Criterion                                                                     | Result (sandbox) | Result (user's machine) |
| ----------------------------------------------------------------------------- | ---------------- | ----------------------- |
| `pnpm check` and `pnpm test:integration` pass                                 | pass             | pending                 |
| Verification email arrives in Mailpit; link verifies once only                | pass             | pending                 |
| Forgot password: same response for known and unknown emails; reset works once | pass             | pending                 |
| Reset revokes all sessions; change revokes other sessions                     | pass             | pending                 |
| Common passwords rejected; deactivated account cannot sign in                 | pass             | pending                 |
| No tokens, passwords or session IDs in logs                                   | pass             | pending                 |

Note: the Mailpit binary used in the sandbox was downloaded from its GitHub release without checksum verification. It is a sandbox-only test tool; the local stack uses the pinned `axllent/mailpit:v1.30.5` image.

## 2026-11-10: Phase 3b-2, admin two-factor authentication

The user asked to continue while they set up Jenkins on their side; 3b-1 acceptance on the user's machine is still pending. The project is now a git repository published by the user (root `E:\Jenkins\ViShark`); a `.gitignore` at that root keeps out `.env` files, the `.incoming` transfer folder and the Phase 0 machine reports.

### Completed

- `totp.ts`: base32, HOTP, TOTP with one step of drift, constant-time comparison, `otpauth://` URI.
- `secret-box.ts`: AES-256-GCM with HKDF-derived keys, user ID as authenticated data, keyed hash for recovery codes.
- `mfa.service.ts` and `mfa.routes.ts`: setup, enable, verify (sign-in step 2), disable, recovery-code regeneration; replay protection, per-attempt and per-account limits, notice emails.
- Login returns `mfaRequired`; pending sessions grant nothing (`401 MFA_REQUIRED`); `GET /auth/session` reports `mfaPending`; logout clears a pending sign-in.
- `users.mfa` fields (secrets `select: false`); `UserDto.mfaEnabled`; permission `mfa:manage-own` (admins).
- `pnpm admin:mfa-reset --email` CLI.
- Settings: `MFA_ENCRYPTION_KEY` (required, generated by `env:sync`), `MFA_ISSUER`, `AUTH_MFA_FAILURE_LIMIT`, `AUTH_MFA_FAILURE_WINDOW_SECONDS`.
- OpenAPI: five MFA endpoints, the two-branch login response; request bodies documented as sent (`io: 'input'`).
- Docs: authentication design (MFA section, residual risks), collections, security events, error codes; ADR-030 to ADR-032.

### Validation done in the assistant sandbox

- 124 API unit tests (RFC 4226/6238/4648 vectors, secret box tamper cases), 32 package tests, 90 integration tests (21 new for MFA).
- Independent cross-check: our TOTP and URI matched the `otpauth` library on 2,000 random seeds (sandbox only, not a project dependency).
- Sabotage check: 13 MFA controls disabled one at a time; all caught. The first run let "disable without second factor" survive: the test only sent a wrong password. Added a correct-password, wrong-code case; now caught.
- Real server: admin created with the CLI, enrol, sign out, password step, pending session refused, replayed code refused, verify on the next step, recovery-code sign-in, recovery-code reuse refused, `admin:mfa-reset`, sign-in without MFA. 19/19 checks; notice emails in Mailpit; no seed or recovery code in the logs.

### Errors encountered

1. The sandbox MongoDB, Redis and Mailpit had stopped (sandbox restart). Restarted with the same settings; not a project issue.
2. `admin:create` smoke test failed with "Cannot read properties of undefined (reading 'createCollection')".
   - Root cause: this phase made the CLIs load the production Mongoose settings (the parity fix from 3b-1). With `bufferCommands` off, Mongoose's automatic `init()` runs when the model is imported, before the CLI connects, fails, and caches that failure; the CLI then awaited `UserModel.init()` and got it.
   - Fix: `UserModel.createIndexes()` after connecting. The parity change found a latent bug in the CLI path.
3. The clock-drift test failed: it used the step right after enrolment, which replay protection correctly refused (the enrolment code used it). The test was wrong, not the code; it now moves the clock forward first.
4. ESLint flagged two unnecessary type assertions around `mongoose.trusted()`. Removed.
5. Swagger generation of the recovery-code schema needed `io: 'input'`, because the schema normalises input with a transform.

### Acceptance criteria

| Criterion                                                               | Result (sandbox) | Result (user's machine) |
| ----------------------------------------------------------------------- | ---------------- | ----------------------- |
| `pnpm check` and `pnpm test:integration` pass                           | pass             | pending                 |
| Admin can enrol with a real authenticator app (QR or manual entry)      | n/a (no phone)   | pending                 |
| Sign-in needs the code; pending session grants nothing; codes work once | pass             | pending                 |
| Recovery code works once; disable needs password and second factor      | pass             | pending                 |
| `pnpm admin:mfa-reset` restores password-only sign-in                   | pass             | pending                 |
| Seeds encrypted at rest; no seeds, codes or tokens in logs              | pass             | pending                 |

## 2026-11-10: CI pipeline (Jenkins) and API container image

The owner moved infrastructure ahead of the remaining application phases to practise Jenkins, AWS IAM and MongoDB administration (ADR-033). The owner builds AWS and Jenkins by hand from the runbook; the assistant writes code and documents only.

### Completed

- `Jenkinsfile` (Script Path `streamhub/Jenkinsfile`): Toolchain, Install, Quality, Security scans, Integration tests, API image; webhook trigger; JUnit results and reports archived; cleanup in `post`.
- `scripts/ci/`: `versions.sh` (pinned tools), `toolchain.sh`, `quality.sh`, `security-scan.sh`, `integration.sh`, `image.sh`. `pnpm ci:toolchain`, `ci:security`, `ci:image`.
- `.gitleaks.toml` (default rules plus one narrow allowlist for prefixed test values), `.trivyignore` (empty, with the rules for adding entries).
- `apps/api/Dockerfile` (multi-stage, non-root, healthcheck) and `.dockerignore`.
- Runbook `docs/operations/jenkins-on-ec2.md` (IAM role with Session Manager instead of SSH, IMDSv2, security group, pinned and checksum-verified installs, Jenkins hardening, fine-grained token, webhook with secret) and `docs/operations/ci-pipeline.md` (stages, design points, troubleshooting). ADR-033 to ADR-035.

### Bug found: API crashed when started before MongoDB

- Found by: reproducing the image's smoke test (start the container without a database; expect liveness 200 and readiness 503).
- Symptom: the process exited with `unhandled promise rejection: MongoTopologyClosedError` a few seconds after start.
- Root cause: the session store waited on `mongoose.connection.asPromise()`, which **rejects** when the first connection attempt fails. Nothing handled that rejection, so the process exited. Had it been handled, the store would have stayed broken after MongoDB came up. In ECS or Compose, where start order is not guaranteed, this is a crash loop.
- Fix: `whenConnected()` in `database/mongo.ts` resolves on the first successful connection and never rejects. Integration test added (fails with the old code). Verified on the built server: started with MongoDB stopped (liveness 200, readiness 503, login 503), then MongoDB started (readiness 200, login 200 with a working session).
- Also: deliberate 5xx `AppError`s (503 while a dependency is down) are now logged as warnings without a stack trace instead of "unhandled error".

### Validation done in the assistant sandbox

- The sandbox now runs Node 26.7.0 (from the `nodejs-wheel-binaries` PyPI package, sandbox only) instead of Node 22: `pnpm check` and all 91 integration tests pass on Node 26, matching the owner's machine. Earlier phases were validated on Node 22 in the sandbox and on Node 26 by the owner.
- The sandbox cannot pull container images, so each Dockerfile stage was reproduced by hand (frozen install with filter, build, prod install, runtime layout): 52 MB application layer; the result starts in production mode, connects, answers login with Argon2, and passes the smoke checks.
- gitleaks 8.30.1 (checksum verified) run on the owner's machine: git history clean with the allowlist; a planted AWS key and GitHub token in a test file are still reported.
- CI scripts: shellcheck clean; control flow tested with stub `docker`, `gitleaks` and `trivy` commands (toolchain pass, scan pass and fail, integration cleanup on failure removes containers, volumes and `.env`, and the script refuses to run outside CI when a `.env` exists).
- Not testable here: Trivy (its database host is blocked), a real `docker build`, Jenkins itself. These run for the first time on the CI host.
- One `pnpm test:integration` run reported a failure without a failing test; five reruns passed. If it recurs in CI, the archived JUnit report and `.logs` will show it.

### Acceptance criteria

| Criterion                                                                  | Result (sandbox)  | Result (owner's Jenkins) |
| -------------------------------------------------------------------------- | ----------------- | ------------------------ |
| Toolchain stage passes on the EC2 host                                     | stub-tested       | pending                  |
| Push to GitHub triggers a build through the webhook                        | n/a               | pending                  |
| Quality, security scans and integration tests green; JUnit visible         | pass (Node 26)    | pending                  |
| API image builds, runs as non-root, scans clean, smoke test passes         | layout reproduced | pending                  |
| Nothing left behind after a build (containers, volumes, `.env`, workspace) | stub-tested       | pending                  |

## 2026-11-17: CI/CD with GitHub Actions and a dev environment on AWS

The owner changed the approach: a practice system built the way a company would, with a complete CI/CD pipeline (build, test **and** deploy) running while the product is developed. After comparing Jenkins on EC2, CodeBuild/CodePipeline and GitHub Actions on cost and learning value, the owner chose GitHub Actions with CodeDeploy to one EC2 dev server (ADR-036). AWS resources are created by the owner from the runbook; the assistant never connects to AWS or GitHub.

### Completed

- Repository root (`ViShark/`): `.github/workflows/ci.yml` (pull requests; reusable), `.github/workflows/deploy-dev.yml` (merge to main), `.github/actions/setup-toolchain` (Node, pinned pnpm, caches, scanners). Every third-party action pinned to a commit SHA (checkout v7.0.1, setup-node v7.1.0, cache v6.1.0, upload-artifact v7.0.2, download-artifact v8.0.2, configure-aws-credentials v6.3.0).
- `scripts/ci/install-tools.sh` (gitleaks and Trivy, checksums from `versions.sh`); `image.sh` can hand the tested image to the deploy job and writes a job summary; Vitest annotates failing tests in pull requests.
- `scripts/cd/publish-image.sh` (load the tested image, verify it belongs to this commit, push to ECR, output the digest; re-runs reuse the immutable tag) and `scripts/cd/deploy-dev.sh` (revision bundle pinned to the digest, S3 upload, CodeDeploy deployment, wait, print failed hooks).
- `deploy/dev/`: `appspec.yml`, `compose.yaml` (API hardened: read-only root filesystem, no capabilities, no-new-privileges, memory limits; Redis; Mailpit; nothing on public interfaces), `api.env` (non-secret settings), hooks (`before-install`, `after-install`: secrets from SSM, image pull, migrations; `application-start`; `validate-service`: pinned image running and `/health/ready` = 200).
- `apps/api/src/cli/migrate.ts` and `pnpm db:migrate` (ADR-038).
- `infra/aws/`: IAM trust and permission policies for the three roles, ECR lifecycle policy, EC2 user data (Docker, pinned Compose plugin with checksum, swap).
- Docs: `docs/operations/cicd-github-actions.md` (design, limits, cost, troubleshooting), `docs/operations/dev-environment-on-aws.md` (step-by-step runbook). ADR-034 marked superseded; ADR-036 to ADR-038.

### Findings

1. **Production would have run without indexes.** The API skips index creation in production (correctly), but nothing created them there: no unique email index, no TTL expiry for tokens. Fixed with the migrate step, run by every deployment before the new version starts. Verified: on an empty database in production mode it created all indexes (unique email, unique token hashes, TTL on `expiresAt`, session lookup) and a second run was a no-op; an unreachable database exits with code 1.
2. **GitHub Free limits for private repositories** (checked in GitHub's documentation): no deployment environments and no enforced branch protection. The deploy role therefore trusts the `main` branch rather than an environment, and "CI green before merge" is a team rule. Making the repository public would lift both limits; that is the owner's decision.
3. **Secrets location.** The first design wrote secrets to `/run` (tmpfs). Containers restart after a reboot without a deployment, and Redis would then miss its config file. Moved to `/etc/streamhub` (root only, encrypted EBS) and documented the trade-off (ADR-037).
4. **Executable bit.** The repository lives on a Windows drive with `core.filemode=false`, so hook scripts may arrive in GitHub without the executable bit, and CodeDeploy runs hooks directly. `deploy-dev.sh` sets it when building the bundle.

### Validation done in the assistant sandbox

- `pnpm check` (156 unit tests) and 91 integration tests pass on Node 26; the Vitest GitHub reporter is accepted.
- actionlint 1.7.12 (checksum verified, run on the owner's machine): both workflows and the composite action are clean. Docker Compose 5.6.1 (checksum verified) parses `deploy/dev/compose.yaml`; single-quoted secret values stay literal.
- shellcheck: all new scripts clean. IAM and lifecycle JSON files parse.
- Deploy scripts and all four CodeDeploy hooks run against stub `aws`, `docker` and `curl` commands: happy path; missing SSM parameter; image not pinned by digest; wrong image running; health check retries; deployment failure prints the failed hook and its log; re-run of a commit reuses the existing ECR tag; an archive from another commit is refused. Secrets file mode 600 and Redis config owned by uid 999, mode 400.
- Not testable here: GitHub Actions itself, AWS (OIDC, ECR, CodeDeploy, SSM), a real `docker build`, and the API container with a read-only root filesystem. The first real run is the owner's. If the read-only filesystem breaks the API, `validate-service` fails and CodeDeploy rolls back, which is also the intended safety net.

### Acceptance criteria

| Criterion                                                                    | Result (sandbox) | Result (owner) |
| ---------------------------------------------------------------------------- | ---------------- | -------------- |
| A pull request runs CI (checks and image) and shows test annotations         | lint and stubs   | pending        |
| A merge to main deploys the tested image by digest, using OIDC (no keys)     | stub-tested      | pending        |
| The dev server runs the API with secrets from SSM; `/health/ready` is 200    | stub-tested      | pending        |
| A failing deployment rolls back and the old version keeps serving            | stub-tested      | pending        |
| No inbound ports; API and Mailpit reachable only through SSM port forwarding | by design        | pending        |

## 2026-11-21: Phase 4a, categories, video records and the audit log

Phase 4 split into 4a (metadata, lifecycle, catalogue, audit) and 4b (storage abstraction and the pre-signed multipart upload workflow).

### Completed

- `packages/shared/src/video-status.ts`: processing and publication state machines with tests. `@streamhub/contracts` now depends on `@streamhub/shared`.
- `packages/contracts/src/catalog.ts`: ids, bounded pagination (page size at most 50, page at most 200), category, video, catalogue, management and audit-log request schemas; response DTO schemas for the docs.
- Categories: list (any signed-in user, at most 200), create, rename, delete (admins); unique slug; deletion refused while videos use the category.
- Videos: create (draft, processing INITIATED), edit (explicit field list), publish, unpublish, archive, restore (atomic, state machine enforced), soft delete; catalogue `GET /videos` (published, ready, public; category filter; text search; pagination); `GET /videos/:id`; management list `GET /admin/videos`.
- Audit log: `auditLogs` collection, `audit()` for API changes, `auditCli()` for the admin CLI (`admin.created`, `admin.promoted`, `admin.mfa_reset`), `GET /admin/audit-logs`.
- New collections' indexes added to the migration step. OpenAPI: all new endpoints with query parameters generated from the request schemas.
- Docs: collections (categories, videos, auditLogs), error codes, events; ADR-039 to ADR-042.

### Errors encountered

1. Four integration tests failed with 500 as soon as a video had a category. The category lookup used `{ _id: { $in: ids } }`, which the global `sanitizeFilter` setting neutralises (it treats every operator as untrusted input). Fixed with `mongoose.trusted()`. This is exactly the class of bug the 3b-1 parity fix was for: the tests run with the production Mongoose settings, so it failed here instead of in the dev environment.
2. TypeScript rejected the shared filter objects (string literals widened to `string`); fixed with `as const`.

### Validation done in the assistant sandbox

- `pnpm check`: 124 API unit tests, 23 shared, 22 contracts. Integration: 115 (24 new for categories, videos, catalogue and audit).
- Sabotage check, 12 controls disabled one at a time: 11 caught (publish without READY, unpublish/restore from the wrong state, unlisted videos in the catalogue, drafts visible to viewers, deleted videos in the management list, processing jumps, viewers managing categories, deleting a category in use, missing audit record, storage key in responses, unbounded page size). The one that survived: removing the explicit field list in `updateVideo` is invisible through HTTP, because the strict request schema already rejects unknown fields. Kept on purpose as a second layer.

### Acceptance criteria

| Criterion                                                                   | Result (sandbox) | Result (owner) |
| --------------------------------------------------------------------------- | ---------------- | -------------- |
| Admin creates categories and draft videos; viewers cannot                   | pass             | pass           |
| Publishing requires processing READY; invalid transitions return 409        | pass             | pass           |
| Catalogue shows only published, ready, public videos; pagination is bounded | pass             | pass           |
| Every privileged change appears in `GET /admin/audit-logs`                  | pass             | pass           |
| CI green on the pull request                                                | n/a              | pass (PR #2)   |

## AWS dev environment: first deployment (2026-11-27)

The owner built the dev environment by hand from `docs/operations/dev-environment-on-aws.md`. Deployment `d-2ZL5OXFSM` (run 45930967003) was the first green end-to-end run: CI, image by digest, OIDC, ECR, S3, CodeDeploy, migration, `compose up`, readiness check.

### Problems found on the way

1. **SSM agent never registered.** The system log blamed Default Host Management ("instance management role is not configured"), but the real cause was the dev server role missing `AmazonSSMManagedInstanceCore`; CloudShell (`list-attached-role-policies`) showed it. Default Host Management was deliberately not enabled: the deploy hooks need the instance role anyway. The runbook now says to check for both policies.
2. **OIDC "Not authorized to perform sts:AssumeRoleWithWebIdentity".** Provider, audience and trust policy all looked right. The failed `AssumeRoleWithWebIdentity` event in CloudTrail showed the subject GitHub actually sent: `repo:Nirmal1995@97385213/ViShark@1452920948:ref:refs/heads/main` (owner and repository IDs included). The trust policy and docs now use that subject; it also stops a re-created repository with the same name from assuming the role.
3. **`db:migrate` failed with "not allowed to do action [createIndex] on [test.sessions]".** The Atlas connection string had no database name, so the driver used `test`, where the least-privilege user has no rights. Config validation now rejects a `MONGO_URL` without a database name.
4. The deploy logs are public (public repository); the AWS credentials step now masks the account ID.

## Phase 4b: storage abstraction and multipart uploads (2026-11-27)

### What was built

- `ObjectStorage` interface on AWS SDK v3 (`infrastructure/storage.ts`): MinIO-compatible storage locally, S3 with role credentials on AWS (no endpoint, no keys). Checksums only where required, so pre-signed URLs stay plain.
- `uploads` collection and service: start (generated key, pre-signed URL per part, video INITIATED to UPLOADING), fresh part URLs, complete (claim, multipart complete, size and file-signature checks, video to VERIFYING, or delete and FAILED), abort (video ABORTED), and an expiry sweep every 15 minutes (video ABORTED, `via: system` audit record).
- Endpoints under `/api/v1/admin/videos/{id}/upload` (start, status, part-urls, complete, abort), documented in OpenAPI; audit records for start, complete, abort, rejection and expiry.
- Config: `S3_*` (bucket required in production, keys as a pair or not at all), `UPLOAD_MAX_BYTES` (2 GiB), `UPLOAD_PART_SIZE_BYTES` (16 MiB), `UPLOAD_URL_TTL_SECONDS` (900), `UPLOAD_SESSION_TTL_HOURS` (24).
- Dev environment: `S3_BUCKET_UPLOADS` from SSM, `S3_REGION` in `api.env`, IAM statements for the uploads bucket (`videos/*` only), CORS and lifecycle steps in the runbook (step 10), hop limit 2 (ADR-045). The deploy job references an `AWS_ACCOUNT_ID` secret so the account ID is masked in every log line.
- ADR-044 (direct-to-storage uploads, S3 through roles), ADR-045 (hop limit 2 as a documented dev gap).

### Errors encountered

1. The sandbox emulator answers a part PUT after abort with 500 instead of S3's 404 `NoSuchUpload`; the test asserts "not accepted" rather than one status code.
2. Three lint errors (unnecessary type assertions) and one unused import, fixed.

### Validation done in the assistant sandbox

- `pnpm check`: 130 API unit tests (new: storage and upload config rules, file signatures), 25 contracts (new: upload schemas), 23 shared.
- Integration: 126 (11 new) against MongoDB, Redis, Mailpit and an S3 emulator (moto) standing in for MinIO: a real two-part upload with browser-style PUTs, unquoted ETags and out-of-order parts, fresh part URLs, permissions, unsupported type, size limit (413), double start (409), missing part and wrong ETag (400, upload still usable), wrong file type and short file (422, file deleted, video FAILED), abort (409 afterwards, parts refused), deadline passed (410), and the expiry sweep run twice.
- CI runs the same suite against the real MinIO-compatible storage container.

### Acceptance criteria

| Criterion                                                             | Result (sandbox) | Result (owner)                                     |
| --------------------------------------------------------------------- | ---------------- | -------------------------------------------------- |
| A real file uploads to storage end to end through the API             | pass             | pass (CI, PR #4)                                   |
| Wrong size or a non-video file is rejected and deleted                | pass             | pass (CI, PR #4)                                   |
| Invalid transitions are rejected (double start, complete after abort) | pass             | pass (CI, PR #4)                                   |
| Abort and expiry clean up storage and end the video                   | pass             | pass (CI, PR #4)                                   |
| Dev server: storage reachable through the instance role               | n/a              | pass (`storage reachable`, deployment d-71E8ZNQSM) |

## Phase 5: playback, watch history and favourites (2026-11-27)

The owner chose playback before the worker, so the worker's output can be checked in a player as soon as it exists.

### What was built

- `GET /videos/{id}/playback`: authorises and returns a signed storage URL (1 hour, `PLAYBACK_URL_TTL_SECONDS`), the resume position and `preview`. Storage serves ranges (`206`) and rejects tampered or expired URLs. Viewers: published and `READY`; administrators also preview verified uploads, which makes uploads testable before Phase 6. Everything else `404`. 60 per minute per user.
- `PUT /videos/{id}/progress` (30 per minute per user), `GET /users/me/history`, `DELETE /users/me/history/{id}`; 95% counts as finished.
- `PUT` and `DELETE /videos/{id}/favourite` (idempotent), `GET /users/me/favourites`.
- History and favourites hide videos that are no longer watchable, filtered in the database so paging stays correct.
- `watchProgress` and `favourites` collections; OpenAPI tag `library`; ADR-046.
- No AWS change: the dev server role can already read `videos/*` in the uploads bucket, which is all a signed GET needs.

### Errors encountered

1. The sandbox S3 emulator does not check signatures on pre-signed URLs at all (it answers `200` for tampered and expired URLs, and crashes when signature checks are switched on). The "storage rejects tampered and expired URLs" test therefore fails in the sandbox; it runs for real in CI, where the MinIO-compatible storage enforces SigV4.
2. Two lint findings (type-only import, unnecessary assertion) and one formatting fix.

### Validation done in the assistant sandbox

- `pnpm check`: 130 API unit, 27 contracts (new: progress body), 23 shared.
- Integration: 136 of 137 pass against MongoDB, Redis, Mailpit and the emulator: 401 when signed out; admin preview of a verified upload with real `206` range responses (middle and tail) and a full `200`; viewer `404` until published and `READY`, admin `404` after delete; no file means no playback; progress, resume, history order and paging, per-user separation; finished at 95% and clamped to the duration; invalid positions `400`; unwatchable videos `404`; history and favourites removal (idempotent) and hiding of unpublished and archived videos. The one failure is the emulator limitation above.

### Acceptance criteria

| Criterion                                                | Result (sandbox) | Result (owner) |
| -------------------------------------------------------- | ---------------- | -------------- |
| `206` with correct `Content-Range` for range requests    | pass             | pending        |
| Unauthorised requests rejected (`401`, `404` for drafts) | pass             | pending        |
| Tampered and expired URLs rejected                       | CI only          | pending        |
| Resume position saved and returned                       | pass             | pending        |

### Owner check on the dev server (2026-11-28)

The first run of `scripts/dev/upload-and-play.sh` on the dev server signed in, then got `401` on the next request. Two causes, both about the session cookie being `Secure` in production:

1. The API sat behind no trusted proxy (`API_TRUST_PROXY_HOPS=0`), so over the plain-HTTP hop to `127.0.0.1:4000` Express treated every request as insecure and `express-session` never issued the cookie. Nobody could sign in on the dev server at all; the deploy's health checks did not need a session, so nothing noticed. Fix: `API_TRUST_PROXY_HOPS=1` in `deploy/dev/api.env`. TLS will end at the edge (Cloudflare Tunnel), and only the host can reach the published port.
2. curl does not send a `Secure` cookie back over plain HTTP, even to localhost. The script now keeps the cookie by hand and sends `X-Forwarded-Proto: https`, which is what the edge proxy will send.

Reproduced and fixed in the sandbox by running the API with production settings: before, `401` after sign-in; after, a two-part upload, verification and a `206` range response.

## Phase 6a: transcoding worker and HLS playback (2026-11-28)

The owner chose ECS Fargate Spot for running the worker on AWS (6b). 6a builds and tests everything that does not depend on where it runs.

### What was built

- `apps/worker`: a separate Node service and image (Debian FFmpeg) with no database access. Consumes `video-transcode`, reports `started`, `ready` or `failed` on `video-results`. ffprobe checks (no video stream, unreadable, too small, longer than 4 hours fail at once without retries), one FFmpeg run per rendition (1080p to 360p by the short side, never above the source, H.264 `veryfast` capped CRF, AAC, 6-second segments, 2-second keyframes), a poster image, upload under a fresh prefix, cleanup of partial output, idle exit for Fargate, graceful SIGTERM.
- API: queues a job per verified upload (job id = video id), consumes results and writes them (READY with duration, size, renditions, poster; FAILED with a reason), audit records with `via: system`, and a recovery sweep every 5 minutes for lost messages.
- Playback: `kind: hls` for processed videos, the master playlist built from the database, media playlists with signed segment URLs, signed poster URL; rendition names validated against the database. Administrators preview the source until processing finishes.
- Shared, validated job messages in `@streamhub/contracts` (keys restricted to the video's own prefixes).
- Local: `pnpm worker:up` (Compose profile `worker`, read-only container, scratch volume), `pnpm dev:worker`. CI: FFmpeg on the runner for the worker tests; a worker image job step (build, Trivy, FFmpeg HLS smoke test inside the image, configuration check).
- ADR-047.

### Errors encountered

1. TypeScript `erasableSyntaxOnly` rejected a constructor parameter property; rewritten as a plain field.
2. BullMQ's optional native speed-up (`msgpackr-extract`) wanted an install script; denied in `allowBuilds` (falls back to JavaScript).
3. `ffprobe` on an MPEG-TS segment prints the size once per program and stream; the test reads the first line.
4. An encoded traversal attempt (`..%2F..%2Fsource`) is decoded by Express into the rendition parameter and rejected by validation (`400`); the test now expects that.
5. Two lint findings (an unbound method passed as a callback, an `async` function without `await`).

### Validation done in the assistant sandbox

- `pnpm check`: 130 API unit, 10 worker unit (ladder, master playlist, FFmpeg arguments, probe parsing including rotated phone videos), 30 contracts (new: job messages), 23 shared.
- Integration: 4 worker tests with real FFmpeg and the S3 emulator (720p source to 720p, 480p, 360p with the 360p segment probed at 640x360; small portrait clip kept at its own size without audio; corrupt file failed at once with nothing left in the media bucket; transient error retried, failure reported only on the last attempt). 146 of 147 API tests pass (10 new: queueing and deduplication, results and duplicates, malformed messages, the results consumer, HLS playlists and signed segments, rendition and permission checks, source preview, recovery); the one failure is the known emulator limitation from Phase 5.
- End to end in the sandbox: the API and the worker running as processes, a real 8-second 720p clip with audio uploaded with `scripts/dev/upload-and-play.sh`, transcoded in about 4 seconds, the video `READY`, the master playlist listing 720p, 480p and 360p, and a 480p segment fetched through its signed URL and probed at 854x480.

### Acceptance criteria

| Criterion                                                          | Result (sandbox) | Result (owner) |
| ------------------------------------------------------------------ | ---------------- | -------------- |
| Sample video becomes READY with the right renditions, no upscaling | pass             | pending        |
| Corrupt file ends FAILED                                           | pass             | pending        |
| Worker image builds, scans clean and transcodes inside the image   | CI               | pending        |

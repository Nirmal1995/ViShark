# Architecture Decision Records

Format: context, decision, consequences. Status is Accepted, Proposed (awaiting review) or Superseded.

## ADR-001: Modular monolith with three runnable apps

Status: Accepted (from spec)

- Context: one developer, interview-oriented project, later deployment to ECS.
- Decision: one repo, three processes: `web`, `api`, `worker`. The API is internally split into feature modules with no cross-module database access except through services.
- Consequences: simple to run and debug; the API and worker scale independently on ECS; modules can be extracted later if ever needed.

## ADR-002: Repo location on E: drive

Status: Accepted (2026-11-09)

- Context: the assistant can only read and write Windows drive folders, not the WSL filesystem (`\\wsl.localhost` paths are refused). Projects under `/mnt/e` cross the Windows/WSL boundary (9P), which is slower for `pnpm install`, and Linux file watchers do not see edits made from the Windows side.
- Decision: keep the repo at `E:\Jenkins\ViShark\streamhub`. Infrastructure data uses Docker named volumes (inside WSL), never bind mounts from E:. Vite and `tsx watch` use polling in dev.
- Consequences: slower installs and slightly higher CPU from polling; acceptable at this size. After the code is on GitHub, cloning into `~/projects` inside WSL is an easy switch.

## ADR-003: Node 26 LTS, TypeScript pinned to 6.0

Status: Accepted

- Context: spec prefers Node 26 LTS. Node 26 became Active LTS on 2026-10-28; all critical dependencies accept it (argon2 uses N-API, so no ABI rebuild issue). TypeScript 7.0 (native Go compiler) is out, but typescript-eslint 8.72 supports TypeScript `<6.1.0`.
- Decision: Node 26.x via nvm (`.nvmrc`), TypeScript 6.0.3 pinned.
- Consequences: type-aware linting works today; TypeScript 7 upgrade is a later, isolated change.

## ADR-004: pnpm installed globally via npm, not Corepack

Status: Accepted

- Context: Corepack is no longer distributed with Node 25 and later.
- Decision: `npm i -g pnpm@12.18.0`; `packageManager` field in root `package.json` documents the version; Dockerfiles install the same pinned version.
- Consequences: one less moving part; the version is still enforced in one place.

## ADR-005: Local object storage image

Status: Accepted (2026-11-09): `pgsty/silo:RELEASE.2026-10-15T00-00-00Z`

- Context: the spec names MinIO. MinIO Community Edition stopped publishing images in October 2025, was archived upstream in 2026, and the `minio/minio` image was removed from Docker Hub in September 2026 (quay.io now refuses anonymous pulls). The last official image is unpatched (for example CVE-2025-62506).
- Options:
  1. `pgsty/silo`: maintained community fork of MinIO (formerly `pgsty/minio`), same env vars and S3 API, console restored. Pin tag and digest.
  2. `cgr.dev/chainguard/minio`: free tier offers only `latest`, so it cannot be pinned.
  3. Build MinIO from archived source ourselves: reproducible but no security fixes.
  4. A different S3 server (Garage, SeaweedFS): actively developed but less S3-complete for multipart, CORS and presigning.
- Proposed decision: option 1, local development only, bound to 127.0.0.1, behind our S3 abstraction using the AWS SDK. Swapping to another S3 server or real S3 is a configuration change.
- Consequences: supply chain trust in a community fork for a dev-only service; documented and pinned by digest.

## ADR-006: Server-side sessions in MongoDB, no JWT

Status: Accepted (from spec)

- Context: a browser app talking to its own API; requirements include revocation, "logout all devices" and session listing.
- Decision: `express-session` with `connect-mongo`, `stringify: false` so session fields (userId, createdAt, lastSeenAt, user agent) are queryable and indexed. Opaque random IDs, regenerated on login and privilege change. Idle timeout via rolling expiry, absolute timeout checked in middleware, TTL index for cleanup.
- Consequences: instant revocation and a simple security model; one database read per request, acceptable at this scale. JWTs would make revocation hard and tempt localStorage storage.

## ADR-007: Same-origin API

Status: Accepted

- Context: cross-origin cookie auth brings CORS with credentials, third-party cookie restrictions and weaker SameSite options.
- Decision: the browser always calls `/api/v1` on the web origin. Locally the Vite dev server proxies to the API; on AWS CloudFront routes `/api/*` to the ALB. Cookies are `HttpOnly; SameSite=Lax; Secure` in production. Object storage gets an explicit CORS policy because uploads and hls.js requests go to it directly.
- Consequences: no API CORS surface; dev and prod behave the same way.

## ADR-008: Shared packages layout

Status: Accepted (2026-11-09). `packages/contracts` is created in the first phase that needs a schema.

- Context: the spec lists `packages/shared`, `types` and `validation`. With Zod, types are inferred from schemas, so separate `types` and `validation` packages would duplicate definitions.
- Decision: `packages/contracts` (Zod request/response schemas, inferred types, DTOs, used by API and web) and `packages/shared` (roles and permissions, video state machine, constants).
- Consequences: one source of truth for API shapes; the frontend validates forms with the same rules the API enforces.

## ADR-009: MongoDB as a single node replica set locally

Status: Accepted

- Context: completing an upload updates `uploads` and `videos` together; multi-document transactions need a replica set. Atlas is always a replica set.
- Decision: run MongoDB in Compose with `--replSet rs0` and an init healthcheck.
- Consequences: transactions available locally; local behaviour matches Atlas.

## ADR-010: Playback URL provider abstraction

Status: Accepted

- Context: private HLS needs authorization on the playlist and every segment; signing only the playlist leaves segments open.
- Decision: interface `PlaybackUrlProvider`. Local implementation: pre-signed MP4 URL (storage serves Range requests), and an API-served HLS playlist with each segment line rewritten to its own short-lived pre-signed URL. AWS implementation (later): CloudFront signed cookies scoped to the video path.
- Consequences: one call site in the API; the AWS change is a new implementation plus configuration.

## ADR-011: Own CSRF middleware (synchronizer token)

Status: Accepted

- Context: `csurf` is deprecated. Cookie sessions need CSRF protection on state-changing requests.
- Decision: a random token stored in the session, delivered via `GET /auth/session`, required in an `X-CSRF-Token` header on POST, PUT, PATCH and DELETE, compared in constant time. SameSite=Lax and an Origin check add defence in depth.
- Consequences: about 40 lines of owned, tested code instead of an unmaintained dependency.

## ADR-012: Local port plan and loopback binding

Status: Accepted

- Context: ports 3000, 5000, 5173, 5432, 8000, 8080, 8081, 9100 and 3306 are in use by another stack; Windows reserves 50000 to 50059 and 61539 to 62338.
- Decision: web 5273, API 4000, worker 4100, MongoDB 27017, Redis 6379, storage 9000/9001, Mailpit 1025/8025, all published on 127.0.0.1 and configurable via `.env`.
- Consequences: no conflicts; infrastructure is not reachable from the LAN.

## ADR-013: MongoDB auth with a replica set: keyfile and directConnection

Status: Accepted (Phase 1)

- Context: a replica set with authentication needs a keyfile for internal member auth, even with one member. Inside Docker the member advertises itself as `mongo:27017`, a name that does not resolve from WSL, so normal replica set discovery from the host would fail.
- Decision: a small entrypoint wrapper generates the keyfile once into the config volume. The healthcheck initiates the replica set and only reports healthy when the node is a writable primary. Host connections use `directConnection=true`; containers (later) use `mongodb://mongo:27017/?replicaSet=rs0`.
- Consequences: transactions and auth work locally like Atlas. `directConnection` is a local-only setting and must not appear in the Atlas connection string.

## ADR-014: Generated development secrets

Status: Accepted (Phase 1)

- Context: shared default passwords such as `minioadmin` end up copied into real environments.
- Decision: `.env.example` holds placeholders only. `pnpm env:init` creates `.env` with random hex secrets (hex needs no URL encoding inside connection strings), mode 600, and refuses to overwrite an existing `.env`. Compose uses `${VAR:?}` so a missing secret stops startup with a clear error.
- Consequences: no credential exists in the repository; every developer machine has unique values.

## ADR-015: Package supply-chain controls

Status: Accepted (Phase 1)

- Context: npm supply-chain attacks usually publish a malicious version that is detected and removed within hours, and often execute through install scripts.
- Decision: `minimumReleaseAge: 1440` (versions must be at least 24 hours old), install scripts blocked except an explicit `allowBuilds` list (currently only esbuild), exact versions, committed lockfile, `engineStrict`.
- Consequences: the newest release of a package is sometimes unavailable for a day (this happened during Phase 1 with typescript-eslint and the AWS SDK, so the previous patch versions were pinned). Each new native or script-running dependency (for example argon2) needs a deliberate approval.

## ADR-016: Redis configuration for BullMQ

Status: Accepted (Phase 1)

- Context: BullMQ stores jobs in Redis keys. With an eviction policy Redis may silently delete queue data under memory pressure. ElastiCache production setups require AUTH.
- Decision: `maxmemory-policy noeviction`, a password (`requirepass`), append-only persistence, 200 MB memory cap locally.
- Consequences: under memory pressure Redis returns errors instead of losing jobs, which is visible and alertable. `pnpm infra:verify` checks the policy.

## ADR-017: Structured logging with request and correlation IDs

Status: Accepted (Phase 2)

- Context: logs must be searchable in CloudWatch, traceable per request, and must never contain secrets.
- Decision: Pino JSON logs to stdout; one line per request via pino-http; `X-Request-Id` per request and `X-Correlation-Id` per user action (accepted from upstream only if they match a strict character set); query strings removed from logged URLs; redaction list applied at serialization; credentials removed from connection strings.
- Consequences: every error response carries a `requestId` that leads straight to its log line. Redaction is defence in depth, not a reason to log whole objects.

## ADR-018: Separate liveness, readiness and metrics endpoints

Status: Accepted (Phase 2)

- Context: an orchestrator restarts containers that fail liveness and stops routing to containers that fail readiness. Metrics must not be public.
- Decision: `/health/live` checks nothing external; `/health/ready` checks MongoDB with a 2 s timeout and reports not ready while draining; dependency errors are logged but not returned. Prometheus metrics are served on a second internal-only port with bounded route labels.
- Consequences: a database outage marks instances not ready (no traffic) without causing a restart storm. Readiness reveals only up/down per dependency.

## ADR-019: Mongoose safety defaults and start-before-connect

Status: Accepted (Phase 2)

- Context: query selector injection is the most common NoSQL vulnerability; queued queries during an outage hide failures; a starting API should not crash if the database is late.
- Decision: global `sanitizeFilter`, `strictQuery`, `bufferCommands=false`; `autoIndex` off in production. The HTTP server starts immediately and the first MongoDB connection is retried with capped exponential backoff, after which the driver reconnects automatically.
- Consequences: database calls fail fast with a 500 (or 503 via readiness) instead of hanging; operators see a clear "not ready" state during startup.

## ADR-020: OpenAPI generated from Zod

Status: Accepted (Phase 2)

- Context: hand-written API docs drift from the code.
- Decision: OpenAPI 3.1 document whose component schemas come from `z.toJSONSchema()` of the same schemas used by `validate()`. Swagger UI is served only when `API_DOCS_ENABLED` (default off in production), under a CSP that allows only same-origin scripts.
- Consequences: one definition per shape. Paths are still registered by hand per module; generating them from route definitions can be added if the manual list becomes a burden.

## ADR-021: Hashed session IDs and public session handles

Status: Accepted (Phase 3a)

- Context: the session ID is a bearer credential. Storing it as the document key means anyone with database read access (a backup, a misconfigured replica, a leaked dump) can impersonate every signed-in user. Listing sessions to the user must not hand out other devices' IDs either.
- Decision: connect-mongo `transformId` stores SHA-256(session ID) as `_id`. Each session also gets a random `handle` used by the session list and revoke endpoints.
- Consequences: a database leak does not yield usable sessions; the session list API cannot leak them. Lookups still use the unique `_id` index.

## ADR-022: Own Redis rate limiter, failing closed, plus a per-email throttle

Status: Accepted (Phase 3a)

- Context: limits must be shared by all API instances; behaviour when Redis is down must be deliberate; per-account protection must not reveal which accounts exist.
- Decision: a fixed-window limiter (`INCR` + `EXPIRE NX` in one `MULTI`) keyed by client IP, with IPv6 grouped by /64, returning standard `RateLimit` and `Retry-After` headers. A second counter per email fingerprint counts failed logins for any email. Redis errors become 503 (fail closed). No `express-rate-limit` dependency.
- Consequences: about 60 lines of owned, tested code. A Redis outage blocks login and registration until it recovers; readiness reports it. Fixed windows allow a burst at a window boundary, acceptable at these limits.

## ADR-023: Registration does not reveal existing accounts; verification required to sign in

Status: Accepted (Phase 3a)

- Context: "email already registered" lets anyone test whether a person has an account.
- Decision: `POST /auth/register` always returns the same 202 after the same work (the password is hashed in both cases). Signing in requires a verified email (`AUTH_REQUIRE_EMAIL_VERIFICATION`, default true). Phase 3b emails the existing owner instead of creating a duplicate.
- Consequences: the UI cannot say "this email is taken"; users are told to check their email.

## ADR-024: Isolated test namespaces and a real MongoDB in the assistant sandbox

Status: Accepted (Phase 3a)

- Context: auth tests write and delete data; they must never touch development data. The assistant sandbox cannot pull Docker images, and mocking MongoDB would not test sessions, TTL indexes or transactions faithfully.
- Decision: integration tests use database `<name>_test` and Redis DB 15, run files sequentially, and empty collections rather than dropping the database (the app user correctly lacks `dropDatabase`). `pnpm infra:test-db` grants the app user access to the test database on existing volumes. The sandbox runs MongoDB 8.3 server binaries from conda-forge with the same replica-set-plus-auth setup as the local stack.
- Consequences: the same tests run in the sandbox and on the developer machine; the sandbox uses 8.3 while the local stack uses 8.0 (differences irrelevant to these features).

## ADR-025: Email link tokens are hashed, single use and carried in the URL fragment

Status: Accepted (Phase 3b-1)

- Context: verification and reset links are bearer credentials. Anything that logs URLs (web servers, proxies, analytics, `Referer`) could leak them, and a database leak must not hand out working links.
- Decision: 256-bit random tokens; only SHA-256 stored; consumed by one atomic `findOneAndDelete` with an expiry condition; TTL index cleanup; a new token replaces older ones. The link is `/verify-email#token=...`: the fragment never leaves the browser, and the web page POSTs it.
- Consequences: links need JavaScript to complete (acceptable for a React app). A plain GET link would be simpler but would leak tokens and could be "used" by email scanners that prefetch links.

## ADR-026: Emails are sent in the background and capped per address

Status: Accepted (Phase 3b-1)

- Context: if a response waits for SMTP only when an account exists, response time reveals which emails are registered. Public endpoints that send email can also be abused to flood an inbox.
- Decision: the response is decided first; sending happens afterwards and failures are logged (`auth.email.<kind>.failed`). At most `AUTH_EMAIL_LIMIT_PER_HOUR` (default 3) emails per kind per address per hour, counted in Redis for any address.
- Consequences: a user is not told if delivery failed; monitoring must watch the failure event. A durable outbox or queue (BullMQ arrives in Phase 6) would add retries; for now a lost email is recovered by "resend".

## ADR-027: Offline common-password list instead of an online breach API

Status: Accepted (Phase 3b-1)

- Context: ASVS 2.1.7 and NIST 800-63B ask for checking passwords against known-breached lists. Online services (k-anonymity range APIs) need network access from the API and add a third-party dependency to registration.
- Decision: a bundled list of 1,186 common passwords that meet our 12-character minimum (SecLists NCSC top 100k, MIT, filtered), compared case-insensitively, plus a check that the password is not the email.
- Consequences: no network dependency, deterministic tests. Coverage is much smaller than a full breach corpus; an online check can be added later behind a feature flag.

## ADR-028: Distinct `SESSION_EXPIRED` error

Status: Accepted (Phase 3b-1)

- Context: during manual testing, an idle-expired session returned the same `401 UNAUTHENTICATED` as a request without a cookie, which is confusing for users and the future UI.
- Decision: if the request carries a session cookie that no longer maps to a valid session, return `401 SESSION_EXPIRED`; otherwise `401 UNAUTHENTICATED`.
- Consequences: the UI can show "your session expired". No information leak: only the cookie holder sees it.

## ADR-029: One module owns Mongoose safety settings, and tests load it

Status: Accepted (Phase 3b-1)

- Context: a real-server run found a 500 that 179 passing tests missed, because the tests did not load the global `sanitizeFilter` setting.
- Decision: `database/mongoose-settings.ts` sets `sanitizeFilter`, `strictQuery` and `bufferCommands=false`; the connection module and the integration test setup both import it, and a test asserts the settings are active. Server-built operators in filters are wrapped in `mongoose.trusted()`.
- Consequences: test and production behaviour match for queries. Every future intentional operator must be marked trusted, which makes such places easy to review.

## ADR-030: Optional TOTP for administrators, with a pending session between the two factors

Status: Accepted (Phase 3b-2)

- Context: the spec asks for optional admin MFA. Admin accounts can manage every video and user, so a stolen password alone should not be enough.
- Decision: TOTP authenticator apps (no SMS: SIM swapping, cost). Enrolment needs `mfa:manage-own`, granted to admins only. After a correct password the session is regenerated and marked `mfaPending` without a `userId`, so it grants nothing; `POST /auth/mfa/verify` regenerates it again into a normal session. Recovery for a lost device is a server-side CLI, not an endpoint.
- Consequences: two requests to sign in for admins with MFA. Not enforced yet; enforcing it for admins is a config flag to add before production. TOTP is not phishing-resistant; WebAuthn/passkeys are the long-term upgrade.

## ADR-031: TOTP implemented on node:crypto, verified against the RFCs, instead of a library

Status: Accepted (Phase 3b-2)

- Context: otplib 13 pulls in six packages plus a third-party crypto implementation; the algorithm itself is HMAC-SHA1 plus a few lines of truncation.
- Decision: about 60 lines in `totp.ts` using Node's built-in HMAC: no new dependency in the authentication path. Tests use the RFC 4226 and RFC 6238 vectors and the RFC 4648 base32 vectors; a one-off check against the independent `otpauth` library matched on 2,000 random seeds.
- Consequences: we own the code, so it is covered by tests and mutation checks. No cryptographic primitive is hand-written; if requirements grow (other algorithms, HOTP counters), revisit a library.

## ADR-032: Seeds encrypted with an HKDF-derived AES-256-GCM key; recovery codes as keyed hashes

Status: Accepted (Phase 3b-2)

- Context: a TOTP seed is a long-lived secret; anyone with it can generate valid codes forever. Database dumps and backups are the usual way such data leaks.
- Decision: `MFA_ENCRYPTION_KEY` (environment only; AWS Secrets Manager in production) feeds HKDF-SHA256 to derive one AES-256-GCM key for seeds and one HMAC key for recovery codes. Random 12-byte IV per value, 16-byte tag enforced, the user ID as authenticated data, stored as `v1.<iv>.<tag>.<ciphertext>`. A value that does not decrypt is logged and treated as a wrong code, never a 500.
- Consequences: a database dump alone yields neither usable seeds nor crackable recovery codes. Losing the key disables every enrolled authenticator (recovery: `admin:mfa-reset`). Key rotation is possible via the version prefix but not built yet.

## ADR-033: Infrastructure and CI move ahead of the remaining application phases

Status: Accepted (2026-11-10, decided by the project owner)

- Context: the original plan forbade CI/CD pipelines and any AWS work during development. The owner wants to practise Jenkins, AWS IAM and MongoDB administration for interviews now, building the infrastructure by hand, then deploy the application onto it later.
- Decision: the rule is amended. The assistant writes the Jenkinsfile, CI scripts, Dockerfiles and runbooks. The owner creates and operates all AWS resources and Jenkins, by hand. The assistant still never connects to AWS or Jenkins, never uses or stores credentials, and never pushes to GitHub. Terraform that provisions resources stays out of scope unless the owner asks for it.
- Consequences: Phase 8/9 items (the API Dockerfile, security scans) arrive early. Application phases 4 to 7 continue afterwards.

## ADR-034: Jenkins pipeline: thin Jenkinsfile, scripts in the repository, pinned scanners

Status: Superseded by ADR-036 for the active pipeline (2026-11-17). The scripts and pinning rules still apply; the Jenkinsfile stays as an alternative.

- Context: CI logic hidden in Groovy is hard to test and review; CI hosts hold credentials, so the tools that run there are a supply-chain target (Trivy's release channel and GitHub Action tags were hijacked in March 2026 to steal CI secrets).
- Decision: the Jenkinsfile orchestrates only; each stage is a script in `scripts/ci/` that also runs locally. One EC2 instance runs controller and builds, one build at a time. Stages run cheapest first: toolchain, install (frozen lockfile), quality, security scans (gitleaks on full history, pnpm audit, Trivy), integration tests on a throwaway Compose stack, image build with scan and smoke test. Tool versions are pinned in `scripts/ci/versions.sh`, adopted after a cooldown of at least a week, installed with checksum verification, and checked by the first stage. Webhook trigger with an HMAC secret.
- Consequences: builds run as a user in the `docker` group, which is root-equivalent on the host: acceptable for a single-owner lab, not for production (isolated agents). Webhooks are plain HTTP until TLS is added.

## ADR-035: API container image: workspace layout, TypeScript workspace packages, non-root

Status: Accepted (2026-11-10)

- Context: the API depends on workspace packages (`@streamhub/contracts`, `@streamhub/shared`) published as TypeScript source. `pnpm deploy` would copy them into `node_modules`, where Node refuses to strip types.
- Decision: multi-stage build (build, prod-deps, runtime) that keeps the monorepo layout: production `node_modules` from `pnpm install --prod --filter @streamhub/api...`, compiled `dist/` for the API, and the workspace packages' `src/` outside `node_modules`, run by Node's built-in type stripping. Files owned by root, process runs as the image's `node` user (uid 1000). Liveness healthcheck with Node's `fetch` (no curl in the image). Base image tag passed as a build argument so CI can pin a digest.
- Consequences: no separate build step for the shared packages. Verified by reproducing each stage by hand in the sandbox on Node 26 (the sandbox cannot pull images); the first real `docker build` runs on the CI host.

## ADR-036: GitHub Actions for CI/CD, CodeDeploy to a single EC2 dev server

Status: Accepted (2026-11-17, decided by the project owner)

- Context: the owner wants a complete CI/CD practice (build, test, deploy) while the product is developed, at minimum cost and with real AWS design work (IAM, deployment). A self-hosted Jenkins needs an always-available server of about 4 GB; CodeBuild/CodePipeline bills per build minute. The project is a practice system with no users.
- Decision:
  - CI and CD on GitHub-hosted runners (free minutes). Workflows only orchestrate the existing `scripts/ci` and new `scripts/cd` scripts.
  - Pull requests run CI; a merge to `main` runs CI again and deploys the image CI tested, by digest.
  - The deploy job assumes `streamhub-github-deploy` through GitHub OIDC, trusted only for `main` of `Nirmal1995/ViShark`. No AWS keys anywhere. CI jobs have no AWS access.
  - Target: one t3.micro (Amazon Linux 2023) running the API, Redis and Mailpit with Docker Compose, deployed in place by CodeDeploy with lifecycle hooks, health validation and automatic rollback. MongoDB Atlas M0. No inbound ports; access through Systems Manager.
  - Every third-party action pinned to a commit SHA.
- Consequences: about $10 to $14 a month for the server if never stopped, the pipeline itself is free. A few seconds of downtime per deployment. GitHub Free on a private repository has no branch protection or deployment environments: "CI green before merge" is a team rule, and the role trusts the branch instead of an environment. Moving to ECS Fargate behind a load balancer is a later, separate exercise.

## ADR-037: Non-secret config in git, secrets in SSM Parameter Store

Status: Accepted (2026-11-17)

- Context: the dev server needs a database URL, session and MFA keys and a Redis password. They must not live in git, GitHub, the revision bundle or the image.
- Decision: non-secret settings in `deploy/dev/api.env`, reviewed and deployed like code. Secrets as SecureString parameters under `/streamhub/dev/`, read by the server's instance role at deploy time and written to `/etc/streamhub` (root only, mode 600, encrypted EBS). Redis reads its password from a config file, never from its command line. Containers cannot reach the instance role (IMDSv2 hop limit 1).
- Consequences: rotating a secret is "update the parameter, redeploy". Root on the server can read the secrets (unavoidable on a single host). Not tmpfs, because containers restart after a reboot without a deployment. Secrets Manager (rotation, cost per secret) is the upgrade path.

## ADR-038: Database migrations are a deployment step

Status: Accepted (2026-11-17)

- Context: in production the API does not build indexes at start-up (index builds can lock large collections), but `indexes.ts` had no production entry point: a production deployment would have run without the unique email index and the TTL indexes.
- Decision: `apps/api/src/cli/migrate.js` (`pnpm db:migrate` locally) creates every index; it is idempotent. The CodeDeploy `after-install` hook runs it with the new image before the new version starts.
- Consequences: a failed migration stops the deployment with the old version still serving. Because the old version runs against the migrated database for a moment, migrations must be backward compatible (expand first, contract in a later release).

## ADR-039: Video lifecycle as two shared state machines, applied atomically

Status: Accepted (Phase 4a)

- Context: a video goes through upload and processing (owned by the system) and publication (owned by administrators). Invalid jumps (publishing an unprocessed video, "completing" an aborted upload) and races (two admins, a retry, a stale page) must be impossible, not merely unlikely.
- Decision: two state machines in `packages/shared/src/video-status.ts` (processing: INITIATED, UPLOADING, VERIFYING, PROCESSING, READY, FAILED, ABORTED; publication: DRAFT, PUBLISHED, ARCHIVED, with publishing requiring READY). Every change is one `findOneAndUpdate` whose filter includes the allowed previous states, so the database decides; a miss is answered with `409 INVALID_TRANSITION` and the current statuses. Visibility (PUBLIC or UNLISTED) is a separate field, not a state.
- Consequences: the web app can use the same rules to show only valid actions. Adding a state means editing one table and its tests. Concurrency is safe without locks or transactions.

## ADR-040: Soft delete for videos; viewers get 404 for anything they may not watch

Status: Accepted (Phase 4a)

- Context: deleting a video involves the database record and several storage objects (original, HLS renditions, thumbnail), which cannot be removed in one atomic step. Viewers must not learn whether a draft with a given id exists.
- Decision: `DELETE` sets `deletedAt` (and unpublishes in the same update); every query excludes deleted videos; a cleanup job removes files and purges records later (Phase 4b/6). For viewers, drafts, archived, unprocessed and deleted videos all return the same `404 NOT_FOUND` as an unknown id.
- Consequences: a crash between steps cannot leave a visible video without files or files without a record nobody knows about. Deleted records occupy space until the cleanup job runs.

## ADR-041: Audit log in MongoDB, written after the change and awaited

Status: Accepted (Phase 4a)

- Context: the spec requires an audit record for every privileged change. Logs alone are not queryable by administrators and rotate away.
- Decision: an append-only `auditLogs` collection (actor, action, target, a few explicit non-sensitive details, request id, IP), written after the change succeeds and awaited, so a failure to record shows up as an error instead of a silent gap. Server-side tools (admin CLI) write records with `via: cli`. `GET /admin/audit-logs` (permission `audit:read`) pages through it.
- Consequences: a change that succeeds but whose audit write fails returns 500 even though the change happened; acceptable, and visible in the logs. A transaction would close that gap at extra cost; not needed for this project. Records are never updated or deleted by the application.

## ADR-042: Separate management list (`GET /admin/videos`) from the catalogue (`GET /videos`)

Status: Accepted (Phase 4a; adjusts the endpoint list in the spec)

- Context: the spec lists one `GET /videos`. Administrators need drafts, failed uploads and every status; viewers must only ever see published, processed, public videos.
- Decision: `GET /videos` is the catalogue for everyone (administrators see the same thing there). `GET /admin/videos` lists all non-deleted videos with status filters and management fields. `GET /videos/:id` returns the management view to administrators and the catalogue view to everyone else.
- Consequences: one meaning per endpoint, simpler caching and tests; the catalogue can never leak a draft because of a missing role check on a query parameter.

## ADR-043: Session lifetime for viewers to be revisited with playback

Status: Proposed (decision deferred to Phase 5)

- Context: sessions expire after 30 minutes idle and 12 hours absolute (ADR on server-side sessions). That suits administrators, but a viewer watching a long film makes no API calls and would be signed out mid-film.
- Direction: media segments are fetched with short-lived signed URLs that do not depend on the session; the player saves watch progress every 30 to 60 seconds, which also counts as activity; viewer sessions get longer limits (around 7 days idle, 30 days absolute); sensitive actions (password, email, MFA changes, anything administrative) require re-authentication within the last 15 minutes; administrators keep the strict limits.
- Consequences: no change now, because there is no player yet. Implemented together with playback in Phase 5, when signed URLs and watch progress exist.

## ADR-044: Direct-to-storage multipart uploads; S3 through role credentials on AWS

Status: Accepted (Phase 4b)

- Context: video files are large (up to 2 GiB by default). Streaming them through the API would tie up a t3.micro's memory, bandwidth and request timeouts.
- Decision: the browser uploads parts straight to object storage with pre-signed `UploadPart` URLs (15 minutes, re-signable per part); the API only starts, completes, verifies and aborts. After completing it checks that the object exists, that its size equals the declared size, and that its first bytes match the declared container (ISO media for MP4/QuickTime, EBML for WebM). A wrong file is deleted and the video fails. Keys are generated (`videos/<id>/source/<uuid>`), never user-supplied. One upload per video (unique index); `COMPLETING` is a claim so two completes cannot both run. Abandoned uploads expire after 24 hours (sweep every 15 minutes, atomic per upload) with an `AbortIncompleteMultipartUpload` lifecycle rule as a safety net.
- Storage access goes through one `ObjectStorage` interface on the AWS SDK v3. Locally: MinIO-compatible storage with an endpoint and keys. On AWS: no endpoint and no keys, so the SDK uses the instance (later: task) role. Flexible checksums are limited to `WHEN_REQUIRED`, because default CRC parameters in pre-signed URLs break plain browser PUTs and S3-compatible servers.
- Raw uploads go to S3 (not R2): role credentials mean no storage secret exists to leak or rotate. Transcoded media for playback is decided in the playback phase (likely R2 behind Cloudflare, ADR to follow).
- Storage is not part of readiness: most requests never touch it. Reachability is checked and logged at startup.
- Consequences: the bucket needs CORS (PUT from the web origin, `ETag` exposed). Verification is a first gate only; ffprobe in the worker decides whether the file actually decodes.

## ADR-045: Metadata hop limit 2 on the dev server (known gap)

Status: Accepted for dev; to be replaced

- Context: the dev server enforces IMDSv2 with a hop limit of 1, so containers cannot reach the instance role's credentials. The API container now needs them for S3.
- Decision: raise the hop limit to 2 on the dev server. Simple and keeps "no S3 keys anywhere".
- Consequences: every container on the host (Redis and Mailpit too) can obtain the role's credentials. The role is narrow (one bucket prefix, one ECR repository, the `/streamhub/dev/` parameters), but this is broader than necessary. Production answer, planned as its own infrastructure phase: run the API on ECS with a task role, so only the API gets S3 access, and the host role keeps hop limit 1.

## ADR-046: Playback through signed storage URLs; the API never streams video

Status: Accepted (Phase 5)

- Context: playback needs range requests (seeking, `206 Partial Content`) and must stop unauthorised viewers. Streaming bytes through the API would tie up the t3.micro and duplicate what storage and CDNs already do well.
- Decision: `GET /videos/{id}/playback` authorises the request and returns a signed GET URL (1 hour by default, `PLAYBACK_URL_TTL_SECONDS`). Storage serves the bytes and handles ranges and expiry; a tampered or expired URL gets `403` from storage itself. Until the worker exists (Phase 6) the URL points at the uploaded source file (`kind: source`); HLS through the CDN replaces it later without changing the endpoint. Viewers may play published, `READY` videos; `video:manage` may also preview a verified upload (`preview: true`), which is how uploads are checked before publishing. Everything else is `404`.
- With role credentials a signed URL also stops working when the role's temporary credentials expire (a few hours on EC2); the player simply asks for a new URL, as it does after `expiresAt`.
- Watch progress: one document per user and video, upserted by the player every 30 to 60 seconds (rate-limited); 95% of the duration counts as finished. History and favourites list only videos the user can still watch, filtered in the database (`$lookup`), so paging stays correct.
- Consequences: no CORS change is needed for a plain `<video>` element; HLS players that fetch segments with JavaScript will need `GET` in the bucket's CORS rules (Phase 6/7). The progress heartbeat also keeps the session active, which is part of the session-lifetime work left open in ADR-043.

## ADR-047: Transcoding worker with no database access; HLS through API playlists with signed segments

Status: Accepted (Phase 6a). AWS hosting (ECS Fargate Spot) follows in Phase 6b.

- Context: verified uploads must become adaptive streams (several qualities) with a poster. FFmpeg is CPU-heavy and must not share the 1 GB API server; on AWS it will run as Fargate Spot tasks that exist only while there is work (chosen by the owner for cost: one uploader, idle most of the time).
- Separate process and image (`apps/worker`, Node plus Debian FFmpeg). Two BullMQ queues: the API adds `video-transcode` jobs (job id = video id, so one job per video; 3 attempts with exponential backoff); the worker reports `started`, `ready` or `failed` on `video-results`, which the API consumes (one at a time, in order) and writes to MongoDB. **The worker has no database access**: no MongoDB credentials, nothing to add to the Atlas IP allowlist for short-lived tasks, and only the API decides status changes. Messages are validated on both sides with shared schemas, including the storage keys they may name.
- Processing: download the source, ffprobe (no video stream, unreadable, too small or longer than 4 hours fails at once, without retries), then one FFmpeg run per rendition: H.264 `veryfast`, capped CRF, AAC 128k, 6-second segments, keyframes every 2 seconds, VOD playlists. The ladder is 1080p, 720p, 480p, 360p by the short side (portrait videos keep their quality) and **never above the source**; a source below 360p gets one rendition at its own size. Output goes to `videos/<id>/hls/<uuid>/` in the media bucket; a failed attempt deletes what it wrote, so retries never mix files. Only the last attempt reports `failed`.
- Lost messages: every 5 minutes the API re-queues VERIFYING videos older than 10 minutes that have no job, and fails videos whose job ended without a report or that stayed PROCESSING longer than `TRANSCODE_STUCK_MINUTES`. A verified upload never depends on Redis being up at that moment.
- Playback (extends ADR-046): for processed videos `GET /videos/{id}/playback` returns `kind: hls` and the API's master playlist, built from the database. Media playlists are read from storage and every segment is replaced by a signed URL, so the player downloads segments straight from storage and only people allowed to watch get working URLs; rendition names come from the database, never from the request path. Administrators still preview the source until processing finishes. Later the CDN replaces signed segment URLs (signed cookies or tokens) without changing these endpoints.
- Fargate shape (6b): the worker exits after `WORKER_IDLE_EXIT_SECONDS` with an empty queue; the API starts tasks when jobs wait (a `WorkerLauncher`, a no-op locally). SIGTERM lets the current job finish; a Spot reclaim that kills it leaves a stalled job that the next task picks up.
- Consequences: one decode per rendition (simpler failure handling, slower than one split pass; fine at this scale). HLS players in a browser need `GET` CORS on the media bucket. The worker image is large (FFmpeg) and scanned like the API image.

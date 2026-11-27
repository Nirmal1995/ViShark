# StreamHub

A video streaming platform built as a production-oriented engineering project: React, Node.js, MongoDB, S3-compatible object storage, FFmpeg/HLS, Redis/BullMQ, Docker, with AWS deployment planned for a later stage.

> **Status: Phase 4b (uploads).** Monorepo tooling, local infrastructure, the API foundation, full authentication (sessions, CSRF, RBAC, email flows, admin two-factor), categories, video records with validated status changes, the catalogue, an audit log, and direct-to-storage multipart uploads with verification and expiry, plus CI/CD with GitHub Actions to an AWS dev environment. The worker (transcoding), streaming and the web app come next. See [the roadmap](docs/architecture/phase-0-environment-and-plan.md#5-implementation-roadmap).

## Prerequisites

Run everything from **WSL Ubuntu**, not PowerShell.

| Tool                    | Version     | Install                                  |
| ----------------------- | ----------- | ---------------------------------------- |
| Node.js                 | 26.x LTS    | `nvm install 26 && nvm alias default 26` |
| pnpm                    | 12.18.x     | `npm install -g pnpm@12.18.0`            |
| Docker Engine + Compose | Compose v2+ | already installed in WSL                 |
| FFmpeg / FFprobe        | any recent  | `sudo apt install -y ffmpeg`             |
| Git                     | 2.x         | `sudo apt install -y git`                |

Check them all at once:

```bash
pnpm env:check
```

> Note: `pnpm doctor` is a built-in pnpm command (it checks pnpm itself), which is why the project check is named `env:check`.

## Quick start

```bash
cd /mnt/e/Jenkins/ViShark/streamhub

pnpm install          # install dependencies (creates node_modules)
pnpm env:init         # create .env with random local secrets (never committed)
pnpm infra:up         # start MongoDB, Redis, storage, Mailpit and wait until healthy
pnpm infra:verify     # prove every service is reachable and locked down
pnpm infra:test-db    # let the app user use the separate integration-test database
pnpm admin:create --email you@example.com --name "Your Name"   # first administrator
pnpm dev:api          # start the API with auto-reload on http://127.0.0.1:4000
```

Then open:

- http://127.0.0.1:4000/health/ready (should say `"status":"ready"`)
- http://127.0.0.1:4000/api/docs (Swagger UI)
- http://127.0.0.1:4001/metrics (Prometheus metrics, internal port)

## Everyday commands

| Command                                | What it does                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------------ |
| `pnpm infra:up`                        | Start infrastructure, wait for health checks                                               |
| `pnpm infra:status`                    | Show container status and health                                                           |
| `pnpm infra:logs [service]`            | Follow logs (`mongo`, `redis`, `storage`, `storage-init`, `mailpit`)                       |
| `pnpm infra:verify`                    | Connectivity and security checks                                                           |
| `pnpm infra:down`                      | Stop infrastructure, **keep** data                                                         |
| `pnpm infra:reset`                     | **Delete** all local data (asks for confirmation)                                          |
| `pnpm check`                           | Typecheck, lint, format check, tests                                                       |
| `pnpm format`                          | Auto-format the codebase                                                                   |
| `pnpm env:sync`                        | Add settings that are new in `.env.example` to your `.env` (never changes existing values) |
| `pnpm test:integration`                | Integration tests against the local MongoDB, Redis and Mailpit                             |
| `pnpm admin:create --email <email>`    | Create the first administrator (password prompt)                                           |
| `pnpm admin:mfa-reset --email <email>` | Remove two-factor from an account that lost its authenticator                              |

Script output is also saved to `.logs/<script>.log` (git-ignored).

## Performance note (repo on the E: drive)

The repo lives on a Windows drive (`/mnt/e`), and every file access from WSL crosses the Windows/Linux boundary (around 10 ms per lookup, measured). Tools that read thousands of files are slow here: `pnpm install` and especially `pnpm lint` (type-aware ESLint loads the TypeScript compiler and all type definitions) can take several minutes. This is expected; see ADR-002. Cloning the repo into the WSL filesystem (for example `~/projects/streamhub`) makes these commands roughly 10x faster.

pnpm keeps its package store at `E:\.pnpm-store` (same drive as the repo, so it can hardlink packages instead of copying them).

## Local services

| Service         | Address                 | Notes                                                                 |
| --------------- | ----------------------- | --------------------------------------------------------------------- |
| MongoDB 8.0     | `127.0.0.1:27017`       | single-node replica set `rs0`, auth enabled                           |
| Redis 8.4       | `127.0.0.1:6379`        | password required, `noeviction`                                       |
| Storage S3 API  | `http://127.0.0.1:9000` | Silo (MinIO fork), private buckets                                    |
| Storage console | `http://127.0.0.1:9001` | log in with `STORAGE_ROOT_USER` / `STORAGE_ROOT_PASSWORD` from `.env` |
| Mailpit UI      | `http://127.0.0.1:8025` | every email the app sends lands here                                  |

Details, credentials model and troubleshooting: [docs/operations/local-infrastructure.md](docs/operations/local-infrastructure.md).

## Repository layout

```
apps/api         Express API (modules, middleware, config, infrastructure)
apps/            worker, web (added in later phases)
packages/shared  roles, permissions and domain rules shared by all apps
packages/contracts  Zod request/response schemas shared by API and web
docker/infra     init scripts for the infrastructure containers
scripts/         doctor, env, infra lifecycle, verification
docs/            architecture, operations, security, database, aws, testing
```

## Documentation

- [Phase 0: environment and plan](docs/architecture/phase-0-environment-and-plan.md)
- [Architecture decisions](ARCHITECTURE_DECISIONS.md)
- [Development log](DEVELOPMENT_LOG.md)
- [Local infrastructure](docs/operations/local-infrastructure.md)
- [API conventions](docs/api/conventions.md)
- [Observability](docs/operations/observability.md)
- [Authentication design](docs/security/authentication-design.md)
- [Database collections](docs/database/collections.md)
- [CI/CD: GitHub Actions to the dev environment](docs/operations/cicd-github-actions.md)
- [Runbook: dev environment and deploy pipeline on AWS](docs/operations/dev-environment-on-aws.md)
- [CI stages explained](docs/operations/ci-pipeline.md) and the alternative [Jenkins on EC2](docs/operations/jenkins-on-ec2.md) setup

## Security notes

- `.env` holds local secrets and is git-ignored. Never commit it.
- The credentials generated by `pnpm env:init` are for local development only. Production secrets will live in AWS Secrets Manager.
- All infrastructure ports are bound to `127.0.0.1`, so they are not reachable from your network.
- There is no default administrator. Create one with `pnpm admin:create`; the password is never passed on the command line.
- Administrators can turn on two-factor authentication. If one loses both the authenticator and the recovery codes, `pnpm admin:mfa-reset --email <email>` removes it (confirm who is asking first).
- `MFA_ENCRYPTION_KEY` in `.env` encrypts authenticator seeds. Changing it breaks every enrolled authenticator.
- Integration tests use `streamhub_test` and Redis DB 15, never your development data.
- Emails never leave your machine locally: they go to Mailpit at http://127.0.0.1:8025.

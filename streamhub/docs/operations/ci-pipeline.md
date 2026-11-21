# CI Pipeline stages

> The active pipeline is GitHub Actions ([cicd-github-actions.md](cicd-github-actions.md), ADR-036). Both GitHub Actions and the `Jenkinsfile` call the same `scripts/ci/` stages described here; Jenkins remains a documented alternative.

`Jenkinsfile` (in `streamhub/`) runs on every push to GitHub. It only orchestrates: each stage calls a script in `scripts/ci/`, so the same checks run on a laptop and in Jenkins, and pipeline logic is reviewed like any other code (ADR-034). Host setup: [jenkins-on-ec2.md](jenkins-on-ec2.md).

```
push ──► GitHub webhook ──► Jenkins (EC2)
           Toolchain ─► Install ─► Quality ─► Security scans ─► Integration tests ─► API image
                                                                                     (build, scan, smoke)
           always: JUnit results, reports archived, containers/volumes/.env removed, workspace deleted
```

## Stages

| Stage             | Script                           | What it proves                                                                                                                        | Fails when                                                    |
| ----------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Toolchain         | `scripts/ci/toolchain.sh`        | Node 26, pnpm 12.18.0, gitleaks, Trivy, Docker, Compose and Buildx are present at the pinned versions (`scripts/ci/versions.sh`)      | a tool is missing or at another version                       |
| Install           | `pnpm install --frozen-lockfile` | dependencies exactly as in `pnpm-lock.yaml`; only approved install scripts run                                                        | the lockfile is out of date                                   |
| Quality           | `scripts/ci/quality.sh`          | typecheck, ESLint, Prettier, unit tests (JUnit in `**/reports/junit-unit.xml`)                                                        | any check fails                                               |
| Security scans    | `scripts/ci/security-scan.sh`    | no secrets in the **whole git history** (gitleaks); no high/critical advisories (pnpm audit); Trivy: lockfile, Dockerfile, secrets    | any finding not accepted in `.gitleaks.toml` / `.trivyignore` |
| Integration tests | `scripts/ci/integration.sh`      | the API against real MongoDB, Redis, storage and Mailpit, started fresh with Compose and a throwaway `.env`                           | a test fails or a service does not become healthy             |
| API image         | `scripts/ci/image.sh`            | the image builds, runs as non-root, has no fixable high/critical CVEs, and **starts**: liveness 200, readiness 503 without a database | build, scan or smoke test fails                               |

Reports (`streamhub/reports/`, `streamhub/.logs/`) are archived with each build; test results appear under **Tests** in the build page.

## Design choices worth explaining in an interview

- **Fail fast, cheapest first**: version checks and linting take seconds; Docker builds take minutes.
- **Pinned scanners with a cooldown**: tools are pinned (not `latest`) and adopted at least a week after release, with checksums verified at install. In March 2026 Trivy's release channel and GitHub Action tags were hijacked to steal CI secrets; pinning by version and verifying checksums is the defence (ADR-034).
- **History, not just HEAD**: gitleaks scans every commit. A secret deleted in a later commit is still leaked.
- **Accepting a finding is a reviewed change**: add it to `.gitleaks.toml` or `.trivyignore` with a reason and review date, never by editing the scan.
- **Throwaway integration environment**: random secrets per build, fixed project name `streamhub-ci`, `down --volumes` in a `trap`, plus a second cleanup in the Jenkinsfile's `post`. No state survives a build.
- **"It builds" is not "it works"**: the image is started and probed. This caught a real bug: the API crashed if it started before MongoDB was reachable (see DEVELOPMENT_LOG, Phase 3b-2 follow-up).
- **No push yet**: images are built and tested but not published. Pushing to Amazon ECR comes with deployment, using the instance's IAM role (no access keys on the server).

## Running the stages locally

```bash
pnpm ci:toolchain        # needs gitleaks and trivy installed
pnpm check               # same as the Quality stage
pnpm ci:security
pnpm ci:image            # needs Docker
```

`scripts/ci/integration.sh` refuses to run outside CI when a `.env` exists, because it creates and deletes its own `.env`. Locally, use `pnpm infra:up` and `pnpm test:integration`.

## Troubleshooting

| Symptom                                                        | Likely cause and fix                                                                                                                                                                         |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build never starts after a push                                | Webhook: GitHub repo **Settings > Webhooks > Recent Deliveries** shows the response. Timeout = security group does not allow GitHub's hook IP ranges on 8080; 403 = webhook secret mismatch. |
| Toolchain: "node is v22..., expected v26."                     | Node or pnpm was not linked into `/usr/local/bin` (runbook step 4), or an older Node is earlier on the `jenkins` user's PATH.                                                                |
| `permission denied ... /var/run/docker.sock`                   | `jenkins` is not in the `docker` group, or Jenkins was not restarted after adding it.                                                                                                        |
| Install: `ERR_PNPM_OUTDATED_LOCKFILE`                          | A `package.json` changed without updating `pnpm-lock.yaml`. Run `pnpm install` locally and commit the lockfile.                                                                              |
| Security: gitleaks finding in a test file                      | Test-only values must start with `integration-test-` or `unit-test-`. A real secret must be rotated first, then removed from history.                                                        |
| Security: Trivy finding                                        | Upgrade the package (or base image). Only if it does not apply: `.trivyignore` with reason and review date.                                                                                  |
| Integration: "did not become healthy" / port already allocated | A leftover container from an aborted build: `docker compose -p streamhub-ci down -v` on the host. Check memory with `free -h` (t3.medium has 4 GB; swap is configured in the runbook).       |
| Image: smoke test "readiness should be 503 ..., got 000"       | The container exited; the step prints `docker logs`. Usually a configuration error at startup.                                                                                               |
| Disk full                                                      | `docker system prune -af --filter until=72h` on the host; the runbook adds a weekly timer for this.                                                                                          |

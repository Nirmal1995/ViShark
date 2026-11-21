# CI/CD: GitHub Actions to the dev environment on AWS

How a change gets from a pull request to the running dev server, and why it is built this way. Setting it up in AWS and GitHub: [dev-environment-on-aws.md](dev-environment-on-aws.md). Decisions: ADR-036 to ADR-038.

## The flow

```
feature branch ──► pull request ──► CI (.github/workflows/ci.yml)
                                      checks: toolchain, quality, security scans, integration tests
                                      image:  build, scan, smoke test
merge to main ──► Deploy (dev) (.github/workflows/deploy-dev.yml)
                    CI again (same workflow, reused) ──► tested image saved as an artifact
                    deploy job:
                      1. assume the AWS role "streamhub-github-deploy" through OIDC
                      2. push the tested image to ECR, tagged with the commit
                      3. upload a CodeDeploy revision (deploy/dev + the image digest) to S3
                      4. CodeDeploy on the dev server:
                           after-install:    secrets from SSM, pull image, run migrations
                           application-start: docker compose up (new container)
                           validate-service:  pinned image running? /health/ready = 200?
                         failure anywhere ──► automatic rollback to the previous revision
```

```
                         GitHub                                 AWS eu-west-1
 ┌───────────────────────────────────────────┐   ┌──────────────────────────────────────────────┐
 │ Actions runner (deploy job)               │   │ IAM OIDC provider ─► role streamhub-github-   │
 │   OIDC token ─────────────────────────────┼──►│                      deploy (main branch only)│
 │   docker push ────────────────────────────┼──►│ ECR streamhub-api (immutable tags, scanned)   │
 │   s3 cp revision.zip ─────────────────────┼──►│ S3 streamhub-dev-deploy-<account>             │
 │   aws deploy create-deployment ───────────┼──►│ CodeDeploy app streamhub / group streamhub-dev│
 └───────────────────────────────────────────┘   │        │                                       │
                                                 │        ▼                                       │
                                                 │ EC2 dev server (t3.micro, no inbound ports)   │
                                                 │   CodeDeploy agent, SSM agent                 │
                                                 │   containers: api, redis, mailpit             │
                                                 │   secrets: SSM Parameter Store ─► /etc (600)  │
                                                 └───────────────────┬───────────────────────────┘
                                                                     │ TLS
                                                           MongoDB Atlas M0 (streamhub database)
```

## Design choices

| Choice                                                                | Why                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GitHub-hosted runners                                                 | No build server to run, patch or pay for when idle. The private-repo runner (2 vCPU, 8 GB) fits our build.                                                                                                                                                                                 |
| Workflows only orchestrate; logic lives in `scripts/ci`, `scripts/cd` | The same scripts run locally and in any CI system (the Jenkinsfile calls them too). Reviewed and tested like code.                                                                                                                                                                         |
| Build once, deploy the same bytes                                     | The image CI tested is handed to the deploy job as an artifact, pushed to ECR and deployed **by digest** (`repo@sha256:...`). Nothing is rebuilt between test and deploy.                                                                                                                  |
| OIDC instead of AWS keys                                              | GitHub issues a short-lived token per job; AWS exchanges it for 30-minute credentials. There is no AWS secret in GitHub to leak or rotate. The role trusts only `repo:Nirmal1995/ViShark:ref:refs/heads/main`.                                                                             |
| Only the deploy job can reach AWS                                     | CI jobs have `contents: read` and no `id-token` permission: a pull request cannot request AWS credentials at all.                                                                                                                                                                          |
| Least-privilege policies                                              | The deploy role can push to one ECR repository, write one S3 prefix and deploy to one deployment group. The server role can read one S3 prefix, pull one repository and read `/streamhub/dev/*`. Policies: `infra/aws/iam/`.                                                               |
| Actions pinned to commit SHAs                                         | A tag can be moved to malicious code (this happened to Trivy's actions in March 2026); a commit SHA cannot. The version is in a comment for humans.                                                                                                                                        |
| Scanners pinned and checksum-verified                                 | `scripts/ci/install-tools.sh` refuses a download whose SHA-256 differs from `scripts/ci/versions.sh`.                                                                                                                                                                                      |
| CodeDeploy (in-place) on one EC2 instance                             | Free for EC2, gives lifecycle hooks, health validation and automatic rollback. One instance keeps the dev environment cheap; moving to ECS later is a separate exercise.                                                                                                                   |
| Config in git, secrets in SSM                                         | `deploy/dev/api.env` (non-secret) is reviewed and deployed like code. Secrets are SecureString parameters, fetched at deploy time and written only to `/etc/streamhub` on the server (root only, encrypted EBS volume). They never appear in git, GitHub, the revision bundle or the logs. |
| Migrations as a deploy step                                           | In production the API does not build indexes at start-up. `after-install` runs `dist/cli/migrate.js` with the new image before it starts serving (ADR-038).                                                                                                                                |
| No inbound ports                                                      | The security group has no inbound rules. Admin access and API testing go through Systems Manager (shell and port forwarding), which also removes SSH keys from the picture.                                                                                                                |
| Containers cannot reach instance credentials                          | IMDSv2 with a hop limit of 1: processes on the host can use the instance role, containers (one network hop further) cannot.                                                                                                                                                                |
| API container hardened                                                | Read-only root filesystem, all Linux capabilities dropped, `no-new-privileges`, memory limit, non-root user (from the image).                                                                                                                                                              |

## Limits of the free GitHub plan (private repository)

- **No branch protection**: GitHub Free does not enforce "CI must pass before merge" on private repositories. Team rule instead: never push to `main` directly; merge a pull request only when CI is green.
- **No deployment environments**: so the AWS role trusts the `main` branch rather than an environment called `dev`. With environments (public repository or a paid plan) the trust condition would become `repo:Nirmal1995/ViShark:environment:dev`, plus required reviewers.
- **2,000 runner minutes a month**: a pull request costs about 10 to 12 minutes, a merge about 15 (CI again plus deploy).
- Making the repository public would remove all three limits. It contains no secrets (gitleaks checks every commit), but it is your decision.

## Deployment behaviour

- **Downtime**: a few seconds while Compose replaces the API container. Acceptable for dev; production would use rolling or blue/green deployments behind a load balancer.
- **Failure before `application-start`** (secrets, image pull, migration): the old version keeps running untouched.
- **Failure in `validate-service`**: CodeDeploy redeploys the previous revision, which carries its own image digest, so the previous image comes back.
- **Concurrency**: one deployment at a time; a newer merge waits.
- **Re-running a workflow** for the same commit reuses the image already in ECR (tags are immutable).

## Cost (approximate)

| Item                                    | Cost                                                                        |
| --------------------------------------- | --------------------------------------------------------------------------- |
| GitHub Actions                          | free within 2,000 minutes a month                                           |
| CodeDeploy to EC2                       | free                                                                        |
| ECR (15 images kept, about 100 MB each) | cents                                                                       |
| S3 revisions, CloudWatch                | cents                                                                       |
| EC2 t3.micro + 8 to 16 GB gp3 + IPv4    | about $10 to $14 a month if never stopped; stop it when you are not working |
| MongoDB Atlas M0                        | free                                                                        |

## Troubleshooting

| Symptom                                                                                    | Cause and fix                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Could not assume role with OIDC: Not authorized to perform sts:AssumeRoleWithWebIdentity` | Trust policy mismatch: check the repository name and branch in the `sub` condition (case-sensitive: `Nirmal1995/ViShark`), and that the OIDC provider audience is `sts.amazonaws.com`. |
| `AccessDenied` on `ecr:...`, `s3:PutObject` or `codedeploy:...`                            | The deploy role's policy names a different repository, bucket, application or group than the GitHub variables. Names must match exactly.                                               |
| Deployment stuck "In progress", then fails with `HEALTH_CONSTRAINTS` / no instances        | CodeDeploy agent not running or the instance tags do not match the deployment group. Session Manager: `sudo systemctl status codedeploy-agent`.                                        |
| `after-install` fails: `SSM parameter ... is missing`                                      | Create the parameter under `/streamhub/dev/` (exact, upper-case name), type SecureString.                                                                                              |
| `after-install` fails at the migration with a timeout                                      | Atlas does not allow the server's IP (Atlas > Network Access), or the user/password in `MONGO_URL` is wrong.                                                                           |
| `validate-service` fails: not ready                                                        | The hook prints the last 30 API log lines. `/health/ready` shows which dependency is down.                                                                                             |
| CI fails pulling `mongo`, `redis` or `node` with `toomanyrequests`                         | Docker Hub's anonymous pull limit, shared by GitHub's runner IPs. Re-run the job; if it keeps happening, add a Docker Hub read-only token and a `docker login` step.                   |
| Server logs                                                                                | Session Manager shell: `sudo docker logs streamhub-api-1`, and `/opt/codedeploy-agent/deployment-root/deployment-logs/codedeploy-agent-deployments.log`.                               |

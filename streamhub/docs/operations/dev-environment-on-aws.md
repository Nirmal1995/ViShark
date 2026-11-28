# Runbook: the dev environment and the deploy pipeline on AWS

Builds everything the pipeline in [cicd-github-actions.md](cicd-github-actions.md) deploys to. Region **eu-west-1**. You create each resource yourself in the AWS console; the reasoning for every IAM permission is in the policy's `Sid` and in the design doc.

Names used throughout (they appear in the IAM policies, so keep them or change both):

| Thing                  | Name                                                                      |
| ---------------------- | ------------------------------------------------------------------------- |
| ECR repository         | `streamhub-api`                                                           |
| S3 bucket (revisions)  | `streamhub-dev-deploy-<ACCOUNT_ID>`                                       |
| SSM parameter path     | `/streamhub/dev/`                                                         |
| CodeDeploy application | `streamhub`, deployment group `streamhub-dev`                             |
| IAM roles              | `streamhub-github-deploy`, `streamhub-dev-server`, `streamhub-codedeploy` |
| S3 bucket (uploads)    | `streamhub-dev-uploads-<ACCOUNT_ID>` (step 10)                            |
| EC2 tags               | `Application=streamhub`, `Environment=dev`                                |

Policy files are in `infra/aws/`. Before pasting one, replace `<ACCOUNT_ID>` with your 12-digit account ID (top-right menu in the console).

## 0. Budget first

Billing > Budgets > Create budget > Monthly cost budget: **$10**, email alert at 80 % actual and 100 % forecasted. The account belongs to your friend: agree the amount with them.

## 1. ECR repository

ECR > Create repository:

- Name `streamhub-api`, **Image tag mutability: Immutable** (a tag can never point to different bytes), encryption AES-256.
- After creating: **Lifecycle policy** > Edit JSON > paste `infra/aws/ecr-lifecycle-policy.json` (keeps the last 15 images for rollbacks, removes untagged ones).
- Scan on push: basic scanning is on by default and free; Trivy in CI is the gate, ECR's scan is a second opinion.

## 2. S3 bucket for deployment revisions

S3 > Create bucket `streamhub-dev-deploy-<ACCOUNT_ID>`:

- Block **all** public access, Object Ownership **Bucket owner enforced**, default encryption SSE-S3.
- Management > Lifecycle rule: prefix `streamhub-dev/`, expire current versions after **90 days**. Revisions are tiny; rollback needs the previous one, so do not make this much shorter.

## 3. Secrets in SSM Parameter Store

Systems Manager > Parameter Store > Create parameter, four times. Type **SecureString**, KMS key **alias/aws/ssm** (the default), tier Standard (free):

| Name                                | Value                                              |
| ----------------------------------- | -------------------------------------------------- |
| `/streamhub/dev/SESSION_SECRET`     | output of `openssl rand -hex 32`                   |
| `/streamhub/dev/MFA_ENCRYPTION_KEY` | output of `openssl rand -hex 32` (a different one) |
| `/streamhub/dev/REDIS_PASSWORD`     | output of `openssl rand -hex 24`                   |
| `/streamhub/dev/MONGO_URL`          | from step 7 (create it then)                       |

Generate the values in your own terminal and paste them straight into the console. Never put them in chat, files in the repo, or GitHub. Keep `MFA_ENCRYPTION_KEY` stable: changing it breaks every enrolled authenticator.

## 4. IAM

### 4a. GitHub as an identity provider

IAM > Identity providers > Add provider > **OpenID Connect**: provider URL `https://token.actions.githubusercontent.com`, audience `sts.amazonaws.com`.

### 4b. Deploy role (used by GitHub Actions)

IAM > Roles > Create role > **Custom trust policy** > paste `infra/aws/iam/github-deploy-role.trust.json`. Skip managed policies, name it `streamhub-github-deploy`. Then Add permissions > Create inline policy > JSON > paste `infra/aws/iam/github-deploy-role.permissions.json`, name `deploy-dev`.

Read the trust policy before saving: only workflow runs on the `main` branch of `Nirmal1995/ViShark` can assume this role. A fork, another branch or another repository gets "access denied". The subject contains the owner and repository IDs (`Nirmal1995@97385213/ViShark@1452920948`); if a deploy fails with "Not authorized to perform sts:AssumeRoleWithWebIdentity", look up the failed `AssumeRoleWithWebIdentity` event in CloudTrail: its `userIdentity.userName` is the exact subject GitHub sent.

### 4c. Dev server role (used by the EC2 instance)

Create role > AWS service > **EC2** (this creates the trust policy in `dev-server-role.trust.json`) > attach managed policy **AmazonSSMManagedInstanceCore** > name `streamhub-dev-server`. Then add the inline policy `infra/aws/iam/dev-server-role.permissions.json`, name `run-streamhub-dev`.

Check before moving on: the role must show **two** policies, `AmazonSSMManagedInstanceCore` (managed) and `run-streamhub-dev` (inline). Without the managed one the SSM agent never registers, and the system log shows a misleading error about Default Host Management ("instance management role is not configured"). Do not enable Default Host Management to fix it: the deploy hooks use the instance role anyway. Note that `AmazonSSMManagedInstanceCore` allows `ssm:GetParameter` on every parameter in the account; acceptable for an account used only by this project, otherwise replace it with a narrower copy.

SecureString parameters encrypted with the AWS managed key `aws/ssm` need no extra KMS permission. With your own KMS key you would add `kms:Decrypt` on that key, with the condition `kms:ViaService = ssm.eu-west-1.amazonaws.com`.

### 4d. CodeDeploy service role

Create role > AWS service > **CodeDeploy** > use case "CodeDeploy" (attaches **AWSCodeDeployRole**) > name `streamhub-codedeploy`. Optionally replace the trust policy with `infra/aws/iam/codedeploy-service-role.trust.json`, which adds an `aws:SourceAccount` condition (confused-deputy protection).

## 5. Network and the dev server

### 5a. Security group

EC2 > Security groups > Create `streamhub-dev-server` in the default VPC:

- **Inbound: none.** Access is through Systems Manager.
- Outbound: replace "all traffic" with TCP 443 to `0.0.0.0/0` (AWS APIs, ECR, GitHub, Docker Hub) and TCP 27017 to `0.0.0.0/0` (Atlas; its node IPs are not fixed).

### 5b. Launch the instance

EC2 > Launch instance:

- Name `streamhub-dev`, tags `Application=streamhub`, `Environment=dev` (CodeDeploy finds the server by these tags).
- AMI **Amazon Linux 2023** (x86_64), type **t3.micro**.
- Key pair: **Proceed without a key pair**.
- Network: default VPC, a public subnet, auto-assign public IP **on**, security group `streamhub-dev-server`.
- Storage: 16 GiB gp3, **encrypted**.
- Advanced details:
  - IAM instance profile `streamhub-dev-server`.
  - Metadata version **V2 only**, metadata response **hop limit 1** (containers cannot reach the instance's credentials). Phase 4b raises it to 2, see step 10.
  - User data: paste `infra/aws/dev-server/user-data.sh`.

After about 3 minutes: select the instance > Connect > **Session Manager** > Connect, then check:

```bash
sudo tail -3 /var/log/cloud-init-output.log   # "bootstrap complete"
docker compose version
```

### 5c. A fixed public IP

EC2 > Elastic IPs > Allocate > Associate with `streamhub-dev`. Atlas allows connections by IP, and an auto-assigned IP changes on every stop/start. Costs about the same as the auto-assigned IP while running, plus about $3.60 a month if you keep it while the instance is stopped. (Alternative exercise: no Elastic IP, and update the Atlas access list after each start.)

## 6. CodeDeploy

CodeDeploy > Applications > Create application `streamhub`, compute platform **EC2/On-premises**. Then Create deployment group:

- Name `streamhub-dev`, service role `streamhub-codedeploy`, deployment type **In-place**.
- Environment: **Amazon EC2 instances**, tags `Application=streamhub` and `Environment=dev` ("1 unique matched instance").
- Agent configuration with Systems Manager: **Now and schedule updates** (every 14 days). CodeDeploy installs the agent through SSM; no curl-to-shell on the server.
- Deployment settings **CodeDeployDefault.AllAtOnce** (one instance; the deploy role may only read this config).
- Load balancer: off.
- Advanced > Rollbacks: **Roll back when a deployment fails**.

## 7. MongoDB Atlas

In your M0 cluster (preferably in AWS eu-west-1):

1. Database Access > Add user `streamhub-dev`, password authentication with a generated password of **letters and digits only** (no URL encoding needed). Built-in role: **readWrite** on database `streamhub` only ("Specific privileges"), not "Atlas admin".
2. Network Access > Add IP address: the Elastic IP, `/32`. Nothing else, and never `0.0.0.0/0`.
3. Connect > Drivers > copy the `mongodb+srv://` string. Insert the user and password and the database name:
   `mongodb+srv://streamhub-dev:<password>@<cluster>.mongodb.net/streamhub?retryWrites=true&w=majority&appName=streamhub-dev`
4. Store it as the SecureString `/streamhub/dev/MONGO_URL` (step 3).

TLS is on by default for `mongodb+srv` connections to Atlas.

## 8. GitHub

Repository > Settings:

1. **Actions > General > Workflow permissions: Read repository contents** (the workflows ask for more only where needed).
2. **Secrets and variables > Actions > Variables** (not secrets; none of these is secret):

   | Variable                 | Value                                                    |
   | ------------------------ | -------------------------------------------------------- |
   | `AWS_REGION`             | `eu-west-1`                                              |
   | `AWS_DEPLOY_ROLE_ARN`    | `arn:aws:iam::<ACCOUNT_ID>:role/streamhub-github-deploy` |
   | `ECR_REPOSITORY`         | `streamhub-api`                                          |
   | `DEPLOY_BUCKET`          | `streamhub-dev-deploy-<ACCOUNT_ID>`                      |
   | `CODEDEPLOY_APPLICATION` | `streamhub`                                              |
   | `CODEDEPLOY_GROUP`       | `streamhub-dev`                                          |

3. **Secrets** tab: `AWS_ACCOUNT_ID` = your 12-digit account ID. It is not really a secret, but the deploy job references it so the runner masks it (`***`) in every line of the public logs, including the step headers that the AWS action's own masking cannot reach.

## 9. First deployment

1. Commit the pipeline on a branch, open a pull request to `main`. The **CI** workflow runs; wait for both jobs to be green.
2. Merge. **Deploy (dev)** runs: CI again, then the deploy job. The run summary shows the image digest and a link to the CodeDeploy deployment.
3. On the server (Session Manager):

   ```bash
   curl -s localhost:4000/health/ready; echo
   sudo docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
   ```

4. From your laptop (needs the AWS CLI and the Session Manager plugin), open Swagger and Mailpit:

   ```bash
   aws ssm start-session --region eu-west-1 --target <instance-id> \
     --document-name AWS-StartPortForwardingSession \
     --parameters '{"portNumber":["4000"],"localPortNumber":["4000"]}'
   # second terminal, for Mailpit on http://localhost:8025
   aws ssm start-session --region eu-west-1 --target <instance-id> \
     --document-name AWS-StartPortForwardingSession \
     --parameters '{"portNumber":["8025"],"localPortNumber":["8025"]}'
   ```

   Then http://localhost:4000/api/docs. Stop your local `dev:api` first: both use port 4000.

5. First admin on dev (Session Manager shell):

   ```bash
   sudo docker exec -it streamhub-api-1 node apps/api/dist/cli/create-admin.js --email you@example.com --name "Your Name"
   ```

6. Prove the rollback works once: on a branch, change the readiness URL in `deploy/dev/hooks/validate-service.sh` to a path that does not exist, merge, and watch the deployment fail and roll back while the old version keeps serving. Revert afterwards.

## 10. Uploads bucket (Phase 4b)

Do all of this **before merging Phase 4b**: until `S3_BUCKET_UPLOADS` exists in SSM the deploy stops at AfterInstall (by design), and without the IAM statements and hop limit the API cannot reach the bucket.

1. **Bucket.** S3 > Create bucket `streamhub-dev-uploads-<ACCOUNT_ID>`: Block **all** public access, Object Ownership **Bucket owner enforced**, encryption SSE-S3, versioning off.
2. **CORS** (the browser PUTs parts straight to the bucket and must read the `ETag` header): bucket > Permissions > Cross-origin resource sharing > Edit > paste `infra/aws/s3/uploads-bucket.cors.json`. The only allowed origin is the dev web origin (`WEB_ORIGIN`); update both together when the web app gets a real domain.
3. **Lifecycle** (safety net for abandoned uploads if the API's own expiry never runs): Management > Create lifecycle rule `abort-incomplete-uploads`, apply to all objects, action **Delete expired object delete markers or incomplete multipart uploads** > **Delete incomplete multipart uploads** after **1** day.
4. **IAM.** Roles > `streamhub-dev-server` > inline policy `run-streamhub-dev` > Edit > JSON: replace it with the updated `infra/aws/iam/dev-server-role.permissions.json` (account ID filled in). The new statements allow object access under `videos/` only; no `s3:CreateBucket`, `s3:PutBucketPolicy` or access to other buckets.
5. **SSM.** Create parameter `/streamhub/dev/S3_BUCKET_UPLOADS`, type **String** (not secret, but it holds the account ID and the repository is public), value: the bucket name.
6. **Metadata hop limit 2** (ADR-045). EC2 > `streamhub-dev` > Actions > Instance settings > Modify instance metadata options: IMDSv2 **Required**, hop limit **2** > Save. The API container then gets the instance role's temporary credentials; there are no S3 keys anywhere. Known gap: every container on the host can now use the role. The production design gives only the API a role (ECS task role).

Check from a Session Manager shell after the next deploy:

```bash
sudo docker logs streamhub-api-1 2>&1 | grep -E '"msg":"storage (reachable|not reachable)"'
```

## Day-to-day

**Check uploads and playback end to end** (no web app needed): from a Session Manager shell on the server, fetch `scripts/dev/upload-and-play.sh` from the repository and run it with an administrator account and any MP4. It signs in, uploads the file in parts straight to S3 with the pre-signed URLs, completes and verifies the upload, checks a range request (`206`) and prints a signed URL you can open in a browser to watch the video.

```bash
curl -fsSLo upload-and-play.sh https://raw.githubusercontent.com/Nirmal1995/ViShark/main/streamhub/scripts/dev/upload-and-play.sh
bash upload-and-play.sh admin@example.com ./clip.mp4
```

- **Stop the instance** when you are not working (EC2 > Instance state > Stop). Containers restart on boot (`restart: unless-stopped`); a merge while it is stopped fails at the deploy step: start it and re-run the workflow.
- Redeploy without a code change: Actions > Deploy (dev) > Run workflow.
- Rotate a secret: update the parameter, then redeploy (the hook rewrites `/etc/streamhub/secrets.env`).
- Tear everything down: delete the deployment group and application, terminate the instance, release the Elastic IP, delete the ECR repository, empty and delete both buckets, delete the parameters and the three roles and the OIDC provider, delete the Atlas user and access-list entry.

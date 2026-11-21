# Runbook: Jenkins on one EC2 instance

Region **eu-west-1**. You create and operate everything in AWS yourself; the assistant writes code and documents but never connects to AWS or Jenkins (ADR-033). Each step says what to do and why, so it doubles as interview material on IAM, network security and supply-chain hygiene.

Target: one EC2 instance runs the Jenkins controller and the builds (ADR-034). Fine for a lab; in production builds run on separate, disposable agents.

## Cost and housekeeping

- t3.medium (2 vCPU, 4 GiB) is about $1 to $1.20 per day while **running**. A stopped instance costs only its disk (30 GiB gp3, about $3 per month). **Stop it when you are not practising.**
- A public IPv4 address is billed per hour while attached. An Elastic IP keeps the webhook URL stable across stop/start but is also billed when the instance is stopped. Choose one; either is a few dollars a month.
- Set an **AWS Budget** with an email alert (for example $15/month) before creating anything.
- Check current prices in the AWS Pricing Calculator; the figures here are approximate.

## 1. IAM: an instance role, no access keys

Practice point: the server gets **temporary** credentials from its role through the instance metadata service. No access key is ever stored on it.

1. IAM > Roles > **Create role** > Trusted entity: AWS service > Use case: **EC2**.
2. Attach **AmazonSSMManagedInstanceCore** only. This lets you open a shell through Systems Manager Session Manager, so the instance needs **no SSH port and no key pair**.
3. Name: `streamhub-jenkins-ec2`. Tag `Project=streamhub`.

Later, for deployments, you will add a customer-managed policy scoped to one ECR repository (least privilege). Sketch to practise with, not needed yet:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "Login", "Effect": "Allow", "Action": "ecr:GetAuthorizationToken", "Resource": "*" },
    {
      "Sid": "PushStreamhubApiOnly",
      "Effect": "Allow",
      "Action": [
        "ecr:BatchCheckLayerAvailability",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "ecr:PutImage",
        "ecr:BatchGetImage"
      ],
      "Resource": "arn:aws:ecr:eu-west-1:<ACCOUNT_ID>:repository/streamhub-api"
    }
  ]
}
```

`GetAuthorizationToken` cannot be restricted to a repository (AWS design), which is why it is a separate statement.

## 2. Network: security group

Create `streamhub-jenkins-sg` in the default VPC (or your own):

| Direction | Port | Source                            | Why                                      |
| --------- | ---- | --------------------------------- | ---------------------------------------- |
| Inbound   | 8080 | your public IP `/32`              | Jenkins UI for you only                  |
| Inbound   | 8080 | GitHub webhook ranges (see below) | push notifications                       |
| Outbound  | all  | `0.0.0.0/0`                       | packages, GitHub, Docker Hub, scanner DB |

No port 22: shell access is through Session Manager. GitHub's current webhook ranges are the `hooks` list at `https://api.github.com/meta`; add each IPv4 CIDR as its own rule with the description `github-hooks`. They change occasionally: if webhooks start timing out, check them first.

## 3. Launch the instance

EC2 > Launch instance:

- Name `streamhub-jenkins`, AMI **Amazon Linux 2023** (x86_64), type **t3.medium**.
- Key pair: **Proceed without a key pair**.
- Network: security group `streamhub-jenkins-sg`, public IP enabled.
- Storage: **30 GiB gp3, encrypted**.
- Advanced: IAM instance profile `streamhub-jenkins-ec2`; **Metadata version: V2 only** (IMDSv2 blocks the SSRF-to-credentials attack that IMDSv1 allowed).

Connect: select the instance > **Connect > Session Manager**. Then `sudo -i`.

## 4. Install the toolchain

All downloads are pinned and checked against published SHA-256 checksums. Versions match `scripts/ci/versions.sh`.

```bash
# Base packages, Java 21 for Jenkins, Docker
dnf install -y git fontconfig openssl tar gzip java-21-amazon-corretto-headless docker
systemctl enable --now docker

# 2 GiB swap: Jenkins + MongoDB + Redis + builds are tight in 4 GiB
dd if=/dev/zero of=/swapfile bs=1M count=2048 && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap defaults 0 0' >> /etc/fstab

# Docker Compose v5.6.1 and Buildx v0.38.1 as CLI plugins (not in the AL2023 repos)
mkdir -p /usr/local/lib/docker/cli-plugins && cd /usr/local/lib/docker/cli-plugins
curl -fsSLo docker-compose https://github.com/docker/compose/releases/download/v5.6.1/docker-compose-linux-x86_64
echo "47737f4236e6d3ccea7291995203f8f018058783b4c3a9469119811a0b5db8c0  docker-compose" | sha256sum -c
curl -fsSLo docker-buildx https://github.com/docker/buildx/releases/download/v0.38.1/buildx-v0.38.1.linux-amd64
echo "e25d5cd675092bb5d1d03632fdc46cdf3fede7b514dc5f023a105e00d3ce5ad4  docker-buildx" | sha256sum -c
chmod 755 docker-compose docker-buildx
docker compose version && docker buildx version

# Node.js 26 (current: 26.13.0) from nodejs.org, verified against SHASUMS256.txt
cd /tmp && V=v26.13.0
curl -fsSLO https://nodejs.org/dist/$V/node-$V-linux-x64.tar.xz
curl -fsSL https://nodejs.org/dist/$V/SHASUMS256.txt | grep " node-$V-linux-x64.tar.xz$" | sha256sum -c
mkdir -p /opt/node && tar -xJf node-$V-linux-x64.tar.xz -C /opt/node --strip-components=1
ln -sf /opt/node/bin/node /usr/local/bin/node && ln -sf /opt/node/bin/npm /usr/local/bin/npm
npm install -g pnpm@12.18.0 && ln -sf /opt/node/bin/pnpm /usr/local/bin/pnpm
node --version && pnpm --version

# gitleaks 8.30.1
curl -fsSLO https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz
echo "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb  gitleaks_8.30.1_linux_x64.tar.gz" | sha256sum -c
tar -xzf gitleaks_8.30.1_linux_x64.tar.gz -C /usr/local/bin gitleaks

# Trivy 0.76.1 (never 0.69.4-0.69.6: compromised releases, March 2026)
curl -fsSLO https://github.com/aquasecurity/trivy/releases/download/v0.76.1/trivy_0.76.1_Linux-64bit.tar.gz
echo "c7cbe3137fb8a48a17574bede3dd6beb16742d1e9772929940fc90082c39d9c0  trivy_0.76.1_Linux-64bit.tar.gz" | sha256sum -c
tar -xzf trivy_0.76.1_Linux-64bit.tar.gz -C /usr/local/bin trivy
gitleaks version && trivy --version | head -1
```

If a `sha256sum -c` line does not print `OK`, stop: do not install that file.

## 5. Install Jenkins LTS

```bash
curl -fsSLo /etc/yum.repos.d/jenkins.repo https://pkg.jenkins.io/rpm-stable/jenkins.repo
rpm --import https://pkg.jenkins.io/rpm-stable/jenkins.io-2026.key
dnf install -y jenkins
usermod -aG docker jenkins          # see the warning below
systemctl enable --now jenkins
cat /var/lib/jenkins/secrets/initialAdminPassword
```

Warning, and an interview point: membership of the `docker` group is equivalent to root on the host. Anyone who can change the Jenkinsfile in the repository can run anything on this machine. Acceptable for a single-person lab with a private repo; in production, builds run on isolated agents (or rootless/Kaniko builds) and the controller runs no builds at all.

## 6. First login and hardening

Open `http://<public-ip>:8080`, paste the initial password.

1. **Install suggested plugins**, then also: **GitHub**, **Pipeline: Stage View**, **Timestamper**, **JUnit** (usually already there).
2. Create your admin user; never keep using `admin` with the initial password.
3. Manage Jenkins > Security: **Logged-in users can do anything**, **Allow users to sign up: off**. Keep CSRF protection on (default). Agents: **TCP port for inbound agents: disable**.
4. Manage Jenkins > Nodes > Built-In Node > **Number of executors: 1** (builds share the controller; one at a time).
5. Manage Jenkins > System > **Jenkins URL**: `http://<public-ip>:8080/`.

## 7. Credentials for the private repository

Least privilege: a **fine-grained personal access token** limited to the one repository.

1. GitHub > Settings > Developer settings > Fine-grained tokens > Generate: Repository access **only** your repo; permissions **Contents: Read-only** (Metadata read-only is added automatically); expiry 90 days.
2. Jenkins > Manage Jenkins > Credentials > System > Global > Add: **Username with password**, username = your GitHub user, password = the token, ID `github-streamhub-read`.

A read-only deploy key (SSH) works too; the token is simpler with the webhook setup below.

## 8. The pipeline job

New Item > `streamhub` > **Pipeline**:

- **Build Triggers**: tick **GitHub hook trigger for GITScm polling**.
- **Pipeline**: Definition **Pipeline script from SCM** > Git > Repository URL `https://github.com/<you>/<repo>.git` > Credentials `github-streamhub-read` > Branch `*/main` > **Script Path `streamhub/Jenkinsfile`**.
- Save, then **Build Now** once by hand: the first run registers the trigger.

## 9. GitHub webhook

1. Generate a secret: `openssl rand -hex 32`.
2. Jenkins > Manage Jenkins > Credentials: add **Secret text**, ID `github-webhook-secret`, value = the secret. Manage Jenkins > System > GitHub > Advanced > **Shared secrets**: select it.
3. GitHub repo > Settings > Webhooks > Add: Payload URL `http://<public-ip>:8080/github-webhook/` (trailing slash matters), content type `application/json`, secret = the same value, events: **Just the push event**.
4. Push a commit. GitHub > Webhooks > **Recent Deliveries** should show 200, and a build should start.

The secret lets Jenkins verify each webhook came from GitHub (HMAC signature). Traffic is still plain HTTP: adding TLS (a reverse proxy with a certificate, or an ALB) is a planned improvement.

## 10. Housekeeping on the host

```bash
# Weekly cleanup of old images and build cache
cat > /etc/systemd/system/docker-prune.service <<'EOF'
[Service]
Type=oneshot
ExecStart=/usr/bin/docker system prune -af --filter until=72h
EOF
cat > /etc/systemd/system/docker-prune.timer <<'EOF'
[Timer]
OnCalendar=weekly
Persistent=true
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload && systemctl enable --now docker-prune.timer
```

Back up `/var/lib/jenkins` (an EBS snapshot is enough for a lab) before upgrading Jenkins or plugins. To edit any file on the host, use `vi`.

## Upgrading pinned tools

1. Pick a release at least a week old; read its release notes.
2. Download, verify the checksum from the release page, install.
3. Update `scripts/ci/versions.sh` and this runbook in the same commit. The Toolchain stage fails until the host and the repository agree.

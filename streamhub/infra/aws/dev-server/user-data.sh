#!/bin/bash
# EC2 user data for the StreamHub dev server (Amazon Linux 2023, x86_64).
# Runs once, as root, at first boot. Paste it into "Advanced details > User
# data" when launching the instance. Output: /var/log/cloud-init-output.log.
#
# Installs only what the deployments need: Docker, the Compose plugin (pinned,
# checksum verified) and swap. The CodeDeploy agent is installed and kept up
# to date by the deployment group, through Systems Manager.
set -euo pipefail

dnf install -y docker
systemctl enable --now docker

COMPOSE_VERSION=v5.6.1
COMPOSE_SHA256=47737f4236e6d3ccea7291995203f8f018058783b4c3a9469119811a0b5db8c0
mkdir -p /usr/local/lib/docker/cli-plugins
curl -fsSLo /usr/local/lib/docker/cli-plugins/docker-compose \
  "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-x86_64"
echo "${COMPOSE_SHA256}  /usr/local/lib/docker/cli-plugins/docker-compose" | sha256sum --check
chmod 0755 /usr/local/lib/docker/cli-plugins/docker-compose
docker compose version

# 1 GiB of swap: a t3.micro has 1 GiB of memory.
if [ ! -f /swapfile ]; then
  dd if=/dev/zero of=/swapfile bs=1M count=1024
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap defaults 0 0' >> /etc/fstab
fi

mkdir -p /opt/streamhub
echo "streamhub dev server bootstrap complete"

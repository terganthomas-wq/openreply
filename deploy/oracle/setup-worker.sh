#!/usr/bin/env bash
# One-time setup of the OpenReply worker on a fresh Ubuntu 24.04 VM
# (Oracle Cloud Always Free). Safe to run again; every step checks first.
#
#   bash setup-worker.sh <git-url-of-your-fork> [branch]
#
# Afterwards the worker starts as soon as ~/openreply/.env exists
# (see deploy/README.de.md). Nothing here opens an inbound port: the worker
# only makes outbound connections (Postgres, Redis, Meta).
set -euo pipefail

REPO_URL="${1:?usage: setup-worker.sh <git-url> [branch]}"
BRANCH="${2:-main}"
APP_DIR="$HOME/openreply"

echo "==> Swap (1 GB RAM is too little for npm ci)"
if ! swapon --show | grep -q '^/swapfile'; then
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null
  sudo swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

echo "==> System packages and automatic security updates"
sudo apt-get update -y -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git curl ca-certificates gnupg unattended-upgrades
echo 'APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";' | sudo tee /etc/apt/apt.conf.d/20auto-upgrades >/dev/null

echo "==> Node.js 24 LTS (NodeSource apt repository)"
if ! node --version 2>/dev/null | grep -q '^v24\.'; then
  sudo install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | sudo gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" \
    | sudo tee /etc/apt/sources.list.d/nodesource.list >/dev/null
  sudo apt-get update -y -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs
fi
node --version

echo "==> pm2"
command -v pm2 >/dev/null || sudo npm install -g --no-fund --no-audit pm2@latest

echo "==> Code"
if [ ! -d "$APP_DIR/.git" ]; then
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
else
  git -C "$APP_DIR" fetch origin "$BRANCH"
  git -C "$APP_DIR" checkout "$BRANCH"
  git -C "$APP_DIR" pull --ff-only origin "$BRANCH"
fi
cd "$APP_DIR"
git log -1 --format='    %h %s'

echo "==> Dependencies (dev dependencies too: tsx and prisma run the worker)"
npm ci --no-fund --no-audit
npx prisma generate

echo "==> pm2 autostart and log rotation"
sudo env PATH="$PATH" pm2 startup systemd -u "$USER" --hp "$HOME" >/dev/null
pm2 describe pm2-logrotate >/dev/null 2>&1 || pm2 install pm2-logrotate >/dev/null
pm2 set pm2-logrotate:max_size 10M >/dev/null
pm2 set pm2-logrotate:retain 7 >/dev/null

if [ -f "$APP_DIR/.env" ]; then
  chmod 600 "$APP_DIR/.env"
  pm2 startOrReload deploy/oracle/ecosystem.config.cjs
  pm2 save
  echo "==> Worker running. Logs: pm2 logs openreply-worker"
else
  echo "==> Setup done. Waiting for $APP_DIR/.env, then run:"
  echo "    cd $APP_DIR && pm2 start deploy/oracle/ecosystem.config.cjs && pm2 save"
fi

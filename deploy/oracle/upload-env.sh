#!/usr/bin/env bash
# Copies worker.env to the VM as ~/openreply/.env and (re)starts the worker.
#   bash deploy/oracle/upload-env.sh <server-ip> <path/to/worker.env>
set -euo pipefail
HOST="${1:?usage: upload-env.sh <server-ip> <worker.env>}"
FILE="${2:?usage: upload-env.sh <server-ip> <worker.env>}"
scp -q "$FILE" "ubuntu@$HOST:openreply/.env"
ssh "ubuntu@$HOST" 'chmod 600 ~/openreply/.env && cd ~/openreply && pm2 startOrReload deploy/oracle/ecosystem.config.cjs >/dev/null && pm2 save >/dev/null && pm2 status openreply-worker'

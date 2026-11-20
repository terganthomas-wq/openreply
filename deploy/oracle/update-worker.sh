#!/usr/bin/env bash
# Update the worker to the latest commit of its branch.
# Order matters: deploy the web app on Vercel first (it runs the database
# migrations), then run this on the VM.
set -euo pipefail
cd "$HOME/openreply"
git pull --ff-only
npm ci --no-fund --no-audit
npx prisma generate
pm2 startOrReload deploy/oracle/ecosystem.config.cjs
pm2 save
git log -1 --format='Worker now at %h %s'

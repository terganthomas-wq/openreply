#!/usr/bin/env bash
# Update the worker to the latest commit of its branch.
# Order matters: deploy the web app on Vercel first (it runs the database
# migrations), then run this on the VM.
#
# Guard: a worker whose Prisma client knows columns the database does not
# have yet fails every comment, tap, DM, follow-up and offer job ("column
# does not exist"). So right after the pull, `prisma migrate status` has to
# find every migration of the new commit applied, before npm ci and the
# restart. If it does not, the checkout goes back to the commit the worker
# runs (its node_modules still match it: npm ci has not run), nothing is
# restarted, and the script stops. Run it again once Vercel shows success.
#
# Only migration names and Prisma's verdict are printed, never the
# datasource line: it names the database host.
#
# Plain bash 3.2 (macOS runs the test): no bash 4 features.
set -euo pipefail
cd "${OPENREPLY_DIR:-$HOME/openreply}"

previous=$(git rev-parse HEAD)
git pull --ff-only

# prisma.config.ts reads DATABASE_URL from ./.env; migrate status only reads.
set +e
status_output=$(npx prisma migrate status 2>&1)
status_code=$?
set -e

# Prisma's own lines worth showing: migration folder names on their own line,
# and its verdicts. Anything that could carry the database address is dropped.
safe_lines() {
  printf '%s\n' "$1" \
    | grep -E '^[0-9]{14}_[A-Za-z0-9_]+$|have not yet been applied|up to date|have failed|are different|last common migration|not found locally' \
    | grep -viF -e '@' -e '://' -e 'postgres' -e 'neon' -e 'datasource' -e 'database server' \
    || true
}

if [ "$status_code" -ne 0 ]; then
  if ! git reset -q --hard "$previous"; then
    echo "Stopped: the checkout could not be set back to ${previous:0:7}. Do not restart the worker; check ~/openreply by hand."
    exit 1
  fi
  shown=$(safe_lines "$status_output")
  if [ -n "$shown" ]; then
    printf '%s\n' "$shown"
    echo "Stopped: the database lacks migrations of this commit. Wait until Vercel shows success, then run this again. The worker keeps running at ${previous:0:7}."
  else
    echo "Stopped: prisma migrate status could not check the database (exit ${status_code}; details are not shown, they can contain its address). The worker keeps running at ${previous:0:7}."
  fi
  exit 1
fi
safe_lines "$status_output"

npm ci --no-fund --no-audit
npx prisma generate
pm2 startOrReload deploy/oracle/ecosystem.config.cjs
pm2 save
git log -1 --format='Worker now at %h %s'

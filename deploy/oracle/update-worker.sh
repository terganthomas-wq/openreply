#!/usr/bin/env bash
# Update the worker to the latest commit of its branch.
# Order matters: deploy the web app on Vercel first (it runs the database
# migrations), then run this on the VM.
#
# Guard: a worker whose Prisma client knows columns the database does not
# have yet fails every comment, tap, DM, follow-up and offer job ("column
# does not exist"). So `prisma migrate status` has to find every migration of
# the new commit applied before anything is installed or restarted. While it
# checks, only the new commit's prisma/migrations sits beside the code the
# worker runs: should pm2 restart the worker meanwhile, it starts that code
# with the node_modules and Prisma client that belong to it. Then that folder
# is set back to the worker's commit; nothing else in the checkout is
# touched. If a migration is missing, nothing else happens and the script
# stops; run it again once Vercel shows success. Otherwise the checkout moves
# on (fast-forward), and npm ci, prisma generate and the restart follow.
#
# The guard runs Prisma from node_modules. An npm ci that did not finish
# leaves them incomplete (it empties node_modules first), and the guard could
# never pass again: the script then stops before it touches anything and
# says how to repair them.
#
# Only migration names and Prisma's verdict are printed, never the
# datasource line: it names the database host.
#
# Plain bash 3.2 (macOS runs the test): no bash 4 features.
set -euo pipefail
cd "${OPENREPLY_DIR:-$HOME/openreply}"

# npm ci writes node_modules/.package-lock.json last, once every package is
# in place.
if [ ! -f node_modules/.package-lock.json ] || [ ! -x node_modules/.bin/prisma ]; then
  echo "Stopped: node_modules is incomplete (an earlier npm ci did not finish). Nothing was changed or restarted. Once Vercel shows success: cd ~/openreply && npm ci --no-fund --no-audit && npx prisma generate, then run this script again."
  exit 1
fi

previous=$(git rev-parse HEAD)
git fetch -q
target=$(git rev-parse '@{upstream}')

# Only the new commit's migration folders, beside the code the worker runs.
git checkout -q "$target" -- prisma/migrations

# prisma.config.ts reads DATABASE_URL from ./.env; migrate status only reads.
# --yes=false: never download a Prisma that is not installed here. (Not the
# short --no: npx 11 takes the word after it for its value.)
set +e
status_output=$(npx --yes=false prisma migrate status 2>&1)
status_code=$?
set -e

# The folder back as the worker's commit has it, whatever the check found
# (restore also removes the folders the checkout added).
if ! git restore --source="$previous" --staged --worktree -- prisma/migrations; then
  echo "Stopped: prisma/migrations could not be set back to ${previous:0:7}. Do not restart the worker; check ~/openreply by hand."
  exit 1
fi

# Prisma's own lines worth showing: migration folder names on their own line,
# and its verdicts. Anything that could carry the database address is dropped.
safe_lines() {
  printf '%s\n' "$1" \
    | grep -E '^[0-9]{14}_[A-Za-z0-9_]+$|have not yet been applied|up to date|have failed|are different|last common migration|not found locally' \
    | grep -viF -e '@' -e '://' -e 'postgres' -e 'neon' -e 'datasource' -e 'database server' \
    || true
}

if [ "$status_code" -ne 0 ]; then
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

git merge --ff-only "$target"
npm ci --no-fund --no-audit
npx prisma generate
pm2 startOrReload deploy/oracle/ecosystem.config.cjs
pm2 save
git log -1 --format='Worker now at %h %s'

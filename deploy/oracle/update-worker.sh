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
# The guard runs Prisma from node_modules, which an npm ci that did not
# finish leaves incomplete (it empties node_modules first). The commit the
# checkout is at passed the guard before it was merged, and migrations only
# ever add: a new commit that adds no migration folder needs nothing the
# database lacks, so the script then installs it without the check. That
# also brings a revert or a fix to the VM when npm ci keeps failing at the
# checkout's commit. A new commit that adds a migration cannot be checked
# without node_modules: the script stops before it changes anything and says
# how to repair them.
#
# One run at a time (with flock, where there is one): a second run while the
# first one still installs would start a second npm ci in the same folder.
#
# Only migration names and Prisma's verdict are printed, never the
# datasource line: it names the database host.
#
# Plain bash 3.2 (macOS runs the test): no bash 4 features.
set -euo pipefail
cd "${OPENREPLY_DIR:-$HOME/openreply}"

# The lock is the open descriptor 9 and ends with this run. A command that
# can leave a process behind (git's automatic maintenance, the pm2 daemon)
# runs with it closed (9>&-), or that process would hold the lock after the
# run. macOS, where the test runs, has no flock.
if command -v flock >/dev/null 2>&1; then
  exec 9>"$HOME/.update-worker.lock"
  if ! flock -n 9; then
    echo "Stopped: another update-worker.sh is still running. Nothing was changed. Wait until it has ended (pgrep -f 'update-worker|npm ci' finds nothing), then run this again."
    exit 1
  fi
fi

previous=$(git rev-parse HEAD)
git fetch -q 9>&-
target=$(git rev-parse '@{upstream}')

# npm ci writes node_modules/.package-lock.json last, once every package is
# in place.
check_database=yes
if [ ! -f node_modules/.package-lock.json ] || [ ! -x node_modules/.bin/prisma ]; then
  if ! git diff --quiet --diff-filter=A "$previous" "$target" -- prisma/migrations; then
    echo "Stopped: node_modules is incomplete (an earlier npm ci did not finish), and the new commit adds a migration, which cannot be checked without them. Nothing was changed or restarted. Once Vercel shows success: cd ~/openreply && npm ci --no-fund --no-audit && npx prisma generate, then run this script again."
    exit 1
  fi
  echo "node_modules is incomplete (an earlier npm ci did not finish). The new commit adds no migration, so it is installed without the database check."
  check_database=no
fi

if [ "$check_database" = yes ]; then
  # Only the new commit's migration folders, beside the code the worker runs.
  git checkout -q "$target" -- prisma/migrations

  # prisma.config.ts reads DATABASE_URL from ./.env; migrate status only
  # reads. --yes=false: never download a Prisma that is not installed here.
  # (Not the short --no: npx 11 takes the word after it for its value.)
  set +e
  status_output=$(npx --yes=false prisma migrate status 2>&1)
  status_code=$?
  set -e

  # The folder back as the worker's commit has it, whatever the check found
  # (restore also removes the folders the checkout added).
  if ! git restore --source="$previous" --staged --worktree -- prisma/migrations; then
    echo "Stopped: prisma/migrations could not be set back to ${previous:0:7} (git says why above). The worker is unaffected: its code, node_modules and Prisma client were not touched. Run this script again; if that keeps failing: cd ~/openreply && git restore --source=HEAD --staged --worktree -- prisma/migrations"
    exit 1
  fi

  # Prisma's own lines worth showing: migration folder names on their own
  # line, and its verdicts. Anything that could carry the database address is
  # dropped.
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
fi

git merge --ff-only "$target" 9>&-
npm ci --no-fund --no-audit
npx prisma generate
pm2 startOrReload deploy/oracle/ecosystem.config.cjs 9>&-
pm2 save 9>&-
git log -1 --format='Worker now at %h %s'

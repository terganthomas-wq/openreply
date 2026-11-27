/**
 * deploy/oracle/update-worker.sh (Meta submission plan, part B, S1a): the
 * worker update stops while the database lacks a migration of the new
 * commit, because a new Prisma client against the old schema fails every
 * comment, tap, DM, follow-up and offer job ("column does not exist"). While
 * Prisma checks, only the new commit's migration folders sit beside the code
 * the worker runs, so a pm2 restart meanwhile still starts that code. After
 * an npm ci that did not finish (an incomplete node_modules), a new commit
 * without a new migration is installed without the check, which also brings
 * a revert to the VM when npm ci keeps failing at the merged commit; one
 * with a migration stops it, with the repair. Only one run at a time.
 *
 * Runs the real script with bash on a throwaway folder in the OS temp
 * directory. npx, npm, pm2 and flock are stand-ins on PATH that only write
 * down how they were called; `npx --yes=false prisma migrate status` answers
 * with the text and exit code Prisma 7 gives in that state. git is a
 * stand-in too, except in the last suite, which runs real git on local
 * throwaway repositories.
 * Nothing is installed, restarted or contacted.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = path.join(__dirname, "..", "deploy", "oracle", "update-worker.sh");
const PREVIOUS = "1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TARGET = "2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const MIGRATION = "20261127180000_review_demo_workspace";
const STATUS = "npx --yes=false prisma migrate status";
const REPAIR =
  "Stopped: node_modules is incomplete (an earlier npm ci did not finish), and the new commit adds a migration, which cannot be checked without them. Nothing was changed or restarted. Once Vercel shows success: cd ~/openreply && npm ci --no-fund --no-audit && npx prisma generate, then run this script again.";
const WITHOUT_CHECK =
  "node_modules is incomplete (an earlier npm ci did not finish). The new commit adds no migration, so it is installed without the database check.";
const LOCKED =
  "Stopped: another update-worker.sh is still running. Nothing was changed. Wait until it has ended (pgrep -f 'update-worker|npm ci' finds nothing), then run this again.";
const INSTALL = [
  "npm ci --no-fund --no-audit",
  "npx prisma generate",
  "pm2 startOrReload deploy/oracle/ecosystem.config.cjs",
  "pm2 save",
];

// What Prisma prints before its verdict. The datasource line names the
// database host; it must never reach the output.
const HEADER = [
  "Loaded Prisma config from prisma.config.ts.",
  "",
  "Prisma schema loaded from prisma/schema.prisma.",
  'Datasource "db": PostgreSQL database "neondb", schema "public" at "ep-made-up-123456.eu-central-1.aws.neon.tech"',
  "",
  "14 migrations found in prisma/migrations",
  "",
].join("\n");

const PENDING = `${HEADER}Following migration have not yet been applied:
${MIGRATION}

To apply migrations in development run prisma migrate dev.
To apply migrations in production run prisma migrate deploy.
`;

const UP_TO_DATE = `${HEADER}
Database schema is up to date!
`;

const DIVERGED = `${HEADER}Your local migration history and the migrations table from your database are different:

The last common migration is: 20261127120000_messaging_tap_search

The migration have not yet been applied:
${MIGRATION}

The migration from the database are not found locally in prisma/migrations:
20261127170000_hotfix_elsewhere
`;

const FAILED = `${HEADER}Following migration have failed:
${MIGRATION}

During development if the failed migration(s) have not been deployed to a production database you can then fix the migration(s) and run prisma migrate dev.
The failed migration(s) can be marked as rolled back or applied:
`;

// No verdict at all: the database could not be asked. Prisma's error names
// the host and the user.
const UNREACHABLE = `${HEADER}Error: P1001: Can't reach database server at \`ep-made-up-123456.eu-central-1.aws.neon.tech:5432\`
Please make sure your database server is running at postgres://made-up@ep-made-up-123456.eu-central-1.aws.neon.tech
`;

let dir: string;

// Every stand-in writes down its call. With FD9 set it also notes there
// whether it was started with descriptor 9 (the script's lock) open.
function stand(name: string, body: string, bin = path.join(dir, "bin")) {
  const file = path.join(bin, name);
  writeFileSync(
    file,
    [
      "#!/bin/sh",
      `echo "${name} $*" >> "$CALLS"`,
      `if [ -n "$FD9" ] && [ -e /dev/fd/9 ]; then echo "${name} $*" >> "$FD9"; fi`,
      body,
      "",
    ].join("\n")
  );
  chmodSync(file, 0o755);
}

// npx answers `migrate status` with status.txt and its exit code.
function standNpx(code: number, bin?: string, before = "") {
  stand(
    "npx",
    [
      'if [ "$1 $2 $3 $4" = "--yes=false prisma migrate status" ]; then',
      before,
      // Prisma writes the datasource line to stdout and errors to stderr.
      '  head -n 4 "$STATUS_FILE"',
      '  tail -n +5 "$STATUS_FILE" >&2',
      `  exit ${code}`,
      "fi",
      "exit 0",
    ].join("\n"),
    bin
  );
}

/** What npm ci leaves behind once it finished: its lockfile and the bins. */
function completeNodeModules(checkout: string) {
  mkdirSync(path.join(checkout, "node_modules", ".bin"), { recursive: true });
  writeFileSync(path.join(checkout, "node_modules", ".package-lock.json"), "{}\n");
  writeFileSync(path.join(checkout, "node_modules", ".bin", "prisma"), "#!/bin/sh\n");
  chmodSync(path.join(checkout, "node_modules", ".bin", "prisma"), 0o755);
}

function readLines(file: string): string[] {
  try {
    return readFileSync(path.join(dir, file), "utf8").trim().split("\n").filter(Boolean);
  } catch {
    // Nothing was written.
    return [];
  }
}

function readCalls(): string[] {
  return readLines("calls.log");
}

/**
 * Runs the script with Prisma answering `status` and exiting `code`.
 * `addsMigration`: what `git diff` finds between the checkout and the new
 * commit. `flock`: a stand-in for flock that exits with this code (none:
 * no flock, as on macOS).
 */
function run(
  status: string,
  code: number,
  {
    fetchFails = false,
    addsMigration = true,
    flock,
  }: { fetchFails?: boolean; addsMigration?: boolean; flock?: number } = {}
) {
  writeFileSync(path.join(dir, "status.txt"), status);
  stand(
    "git",
    [
      'case "$1" in',
      "  rev-parse)",
      `    if [ "$2" = "HEAD" ]; then echo "${PREVIOUS}"; else echo "${TARGET}"; fi ;;`,
      `  fetch) exit ${fetchFails ? 1 : 0} ;;`,
      `  diff) exit ${addsMigration ? 1 : 0} ;;`,
      '  log) echo "Worker now at 2222222 the new commit" ;;',
      "esac",
      "exit 0",
    ].join("\n")
  );
  standNpx(code);
  stand("npm", "exit 0");
  stand("pm2", "exit 0");
  if (flock !== undefined) stand("flock", `exit ${flock}`);

  const result = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: {
      NODE_ENV: "test",
      PATH: `${path.join(dir, "bin")}:/usr/bin:/bin`,
      HOME: path.join(dir, "home"),
      OPENREPLY_DIR: path.join(dir, "openreply"),
      CALLS: path.join(dir, "calls.log"),
      FD9: path.join(dir, "fd9.log"),
      STATUS_FILE: path.join(dir, "status.txt"),
    },
  });
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
    calls: readCalls(),
    withLock: readLines("fd9.log"),
  };
}

function expectNoDatabaseAddress(output: string) {
  for (const line of output.split("\n")) {
    expect(line, line).not.toMatch(/postgres|neon|@/i);
  }
}

const FETCH = ["git rev-parse HEAD", "git fetch -q", "git rev-parse @{upstream}"];
const CHECK = [
  ...FETCH,
  `git checkout -q ${TARGET} -- prisma/migrations`,
  STATUS,
  `git restore --source=${PREVIOUS} --staged --worktree -- prisma/migrations`,
];
const ADDED_MIGRATIONS = `git diff --quiet --diff-filter=A ${PREVIOUS} ${TARGET} -- prisma/migrations`;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "openreply-update-worker-"));
  mkdirSync(path.join(dir, "bin"));
  mkdirSync(path.join(dir, "home"));
  mkdirSync(path.join(dir, "openreply"));
  completeNodeModules(path.join(dir, "openreply"));
});

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("update-worker.sh while a migration is pending", () => {
  it("checks the new commit's migrations, sets the folder back, installs and restarts nothing, and stops", () => {
    const { status, output, calls } = run(PENDING, 1);

    expect(status).toBe(1);
    expect(calls).toEqual(CHECK);
    expect(calls.some((call) => call.startsWith("npm"))).toBe(false);
    expect(calls.some((call) => call.startsWith("pm2"))).toBe(false);
    expect(calls.some((call) => call.startsWith("git merge"))).toBe(false);
    expect(calls).not.toContain("npx prisma generate");
    expect(output).toContain(MIGRATION);
    expect(output).toContain("have not yet been applied");
    expect(output).toContain(
      "Stopped: the database lacks migrations of this commit. Wait until Vercel shows success, then run this again. The worker keeps running at 1111111."
    );
    expect(output).not.toContain("Worker now at");
    expectNoDatabaseAddress(output);
  });

  it("stops the same way when the histories differ or a migration failed", () => {
    for (const status of [DIVERGED, FAILED]) {
      const result = run(status, 1);
      expect(result.status).toBe(1);
      expect(result.calls).toEqual(CHECK);
      expect(result.output).toContain(MIGRATION);
      expect(result.output).toContain("Stopped: the database lacks migrations of this commit.");
      expectNoDatabaseAddress(result.output);
      rmSync(path.join(dir, "calls.log"), { force: true });
    }
  });

  it("names neither host nor user when the database cannot be asked", () => {
    const { status, output, calls } = run(UNREACHABLE, 1);

    expect(status).toBe(1);
    expect(calls).toEqual(CHECK);
    expect(output).toContain("Stopped: prisma migrate status could not check the database (exit 1;");
    expect(output).toContain("The worker keeps running at 1111111.");
    expectNoDatabaseAddress(output);
  });
});

describe("update-worker.sh when the database is up to date", () => {
  it("moves the checkout on, installs, generates, reloads pm2 and says where the worker is now", () => {
    const { status, output, calls } = run(UP_TO_DATE, 0);

    expect(status).toBe(0);
    expect(calls).toEqual([
      ...CHECK,
      `git merge --ff-only ${TARGET}`,
      ...INSTALL,
      "git log -1 --format=Worker now at %h %s",
    ]);
    expect(output).toContain("Database schema is up to date!");
    expect(output).toContain("Worker now at 2222222 the new commit");
    expectNoDatabaseAddress(output);
  });
});

describe("update-worker.sh when the fetch fails", () => {
  it("stops before asking the database and touches nothing", () => {
    const { status, calls } = run(UP_TO_DATE, 0, { fetchFails: true });

    expect(status).not.toBe(0);
    expect(calls).toEqual(["git rev-parse HEAD", "git fetch -q"]);
  });
});

describe("update-worker.sh after an npm ci that did not finish", () => {
  const incomplete = [
    { label: "an empty node_modules", missing: ["node_modules"] },
    { label: "no npm lockfile in node_modules", missing: ["node_modules/.package-lock.json"] },
    { label: "no prisma in node_modules/.bin", missing: ["node_modules/.bin/prisma"] },
  ];

  function breakNodeModules(missing: string[]) {
    for (const entry of missing) {
      rmSync(path.join(dir, "openreply", entry), { recursive: true, force: true });
    }
  }

  it.each(incomplete)(
    "with $label, stops with the repair before Prisma, npm or pm2 when the new commit adds a migration",
    ({ missing }) => {
      breakNodeModules(missing);

      const { status, output, calls } = run(UP_TO_DATE, 0, { addsMigration: true });

      expect(status).toBe(1);
      expect(calls).toEqual([...FETCH, ADDED_MIGRATIONS]);
      expect(output.trim()).toBe(REPAIR);
    }
  );

  it.each(incomplete)(
    "with $label, installs a new commit without a new migration without the database check",
    ({ missing }) => {
      breakNodeModules(missing);

      const { status, output, calls } = run(UP_TO_DATE, 0, { addsMigration: false });

      expect(status).toBe(0);
      expect(calls).toEqual([
        ...FETCH,
        ADDED_MIGRATIONS,
        `git merge --ff-only ${TARGET}`,
        ...INSTALL,
        "git log -1 --format=Worker now at %h %s",
      ]);
      expect(calls).not.toContain(STATUS);
      expect(output).toContain(WITHOUT_CHECK);
      expect(output).toContain("Worker now at 2222222 the new commit");
    }
  );
});

describe("update-worker.sh runs once at a time", () => {
  it("stops before touching anything while another run holds the lock", () => {
    const { status, output, calls } = run(UP_TO_DATE, 0, { flock: 1 });

    expect(status).toBe(1);
    expect(output.trim()).toBe(LOCKED);
    expect(calls).toEqual(["flock -n 9"]);
    expect(existsSync(path.join(dir, "home", ".update-worker.lock"))).toBe(true);
  });

  it("holds the lock for the run, and no command that can leave a process behind inherits it", () => {
    const { status, calls, withLock } = run(UP_TO_DATE, 0, { flock: 0 });

    expect(status).toBe(0);
    expect(calls[0]).toBe("flock -n 9");
    // Every other command runs with descriptor 9 open: the lock is held.
    expect(withLock).toEqual([
      "flock -n 9",
      "git rev-parse HEAD",
      "git rev-parse @{upstream}",
      `git checkout -q ${TARGET} -- prisma/migrations`,
      STATUS,
      `git restore --source=${PREVIOUS} --staged --worktree -- prisma/migrations`,
      "npm ci --no-fund --no-audit",
      "npx prisma generate",
      "git log -1 --format=Worker now at %h %s",
    ]);
    // git's automatic maintenance and the pm2 daemon would outlive the run.
    for (const call of [
      "git fetch -q",
      `git merge --ff-only ${TARGET}`,
      "pm2 startOrReload deploy/oracle/ecosystem.config.cjs",
      "pm2 save",
    ]) {
      expect(calls).toContain(call);
      expect(withLock).not.toContain(call);
    }
  });

  // Where the system has a flock of its own (Linux), the script takes it.
  it.skipIf(existsSync("/usr/bin/flock") || existsSync("/bin/flock"))(
    "takes no lock where there is no flock (macOS)",
    () => {
      const { status, calls, withLock } = run(UP_TO_DATE, 0);

      expect(status).toBe(0);
      expect(calls[0]).toBe("git rev-parse HEAD");
      expect(withLock).toEqual([]);
      expect(existsSync(path.join(dir, "home", ".update-worker.lock"))).toBe(false);
    }
  );
});

// Real git on local throwaway repositories: a bare "origin" and the VM's
// checkout at the old commit, with a new commit (new worker code and a new
// migration) pushed to origin.
describe("update-worker.sh with a real git checkout", () => {
  const OLD_MIGRATION = "20261127120000_messaging_tap_search";
  // npm ci as the real one behaves: it empties node_modules first and writes
  // its lockfile last. It fails on a package-lock.json that names BAD_DEP.
  const NPM_CI = [
    "rm -rf node_modules",
    "mkdir node_modules",
    "if grep -q BAD_DEP package-lock.json 2>/dev/null; then exit 1; fi",
    "mkdir node_modules/.bin",
    "printf '#!/bin/sh\\n' > node_modules/.bin/prisma",
    "chmod +x node_modules/.bin/prisma",
    "echo '{}' > node_modules/.package-lock.json",
    "exit 0",
  ].join("\n");
  let gitEnv: NodeJS.ProcessEnv;
  let seed: string;
  let checkout: string;
  let rbin: string;

  function git(cwd: string, ...args: string[]) {
    const result = spawnSync("git", args, { cwd, env: gitEnv, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  }

  function write(root: string, file: string, content: string) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }

  function commitAndPush(message: string) {
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", message);
    git(seed, "push", "-q", "origin", "main");
    return git(seed, "rev-parse", "HEAD");
  }

  let oldSha: string;
  let newSha: string;

  beforeEach(() => {
    gitEnv = {
      NODE_ENV: "test",
      PATH: "/usr/bin:/bin",
      HOME: path.join(dir, "home"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.test",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.test",
    };
    const origin = path.join(dir, "origin.git");
    seed = path.join(dir, "seed");
    checkout = path.join(dir, "vm");
    git(dir, "init", "-q", "--bare", "-b", "main", origin);
    git(dir, "init", "-q", "-b", "main", seed);
    write(seed, ".gitignore", "/node_modules\n");
    write(seed, "worker/dm-worker.ts", "OLD WORKER CODE\n");
    write(seed, "deploy/oracle/ecosystem.config.cjs", "module.exports = { apps: [] };\n");
    write(seed, `prisma/migrations/${OLD_MIGRATION}/migration.sql`, "-- old\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "the old commit");
    git(seed, "remote", "add", "origin", origin);
    git(seed, "push", "-q", "origin", "main");
    git(dir, "clone", "-q", origin, checkout);
    oldSha = git(checkout, "rev-parse", "HEAD");
    completeNodeModules(checkout);

    write(seed, "worker/dm-worker.ts", "NEW WORKER CODE\n");
    write(seed, `prisma/migrations/${MIGRATION}/migration.sql`, "-- new\n");
    newSha = commitAndPush("the new commit");

    rbin = path.join(dir, "rbin");
    mkdirSync(rbin);
  });

  /**
   * Runs the script; during `migrate status` npx notes what pm2 would start,
   * then runs `duringCheck`. npm is `npm` (a stand-in that installs nothing
   * unless given NPM_CI).
   */
  function runWithGit(
    status: string,
    code: number,
    { duringCheck = "", npm = "exit 0" }: { duringCheck?: string; npm?: string } = {}
  ) {
    for (const file of ["calls.log", "seen.txt"]) rmSync(path.join(dir, file), { force: true });
    writeFileSync(path.join(dir, "status.txt"), status);
    standNpx(
      code,
      rbin,
      [
        '  cat worker/dm-worker.ts > "$SEEN"',
        '  ls prisma/migrations >> "$SEEN"',
        duringCheck,
      ].join("\n")
    );
    stand("npm", npm, rbin);
    stand("pm2", "exit 0", rbin);
    const result = spawnSync("bash", [SCRIPT], {
      encoding: "utf8",
      env: {
        ...gitEnv,
        PATH: `${rbin}:/usr/bin:/bin`,
        OPENREPLY_DIR: checkout,
        CALLS: path.join(dir, "calls.log"),
        STATUS_FILE: path.join(dir, "status.txt"),
        SEEN: path.join(dir, "seen.txt"),
      },
    });
    return {
      status: result.status,
      output: `${result.stdout}${result.stderr}`,
      calls: readCalls(),
      seen: readLines("seen.txt"),
    };
  }

  it("keeps the worker's code while Prisma checks, and leaves the old commit when a migration is pending", () => {
    const { status, output, calls, seen } = runWithGit(PENDING, 1);

    expect(status).toBe(1);
    // What a pm2 restart during the check would have started: the old code,
    // next to the new commit's migration folders.
    expect(seen).toEqual(["OLD WORKER CODE", OLD_MIGRATION, MIGRATION]);
    expect(git(checkout, "rev-parse", "HEAD")).toBe(oldSha);
    expect(readFileSync(path.join(checkout, "worker/dm-worker.ts"), "utf8")).toBe("OLD WORKER CODE\n");
    expect(readdirSync(path.join(checkout, "prisma/migrations"))).toEqual([OLD_MIGRATION]);
    expect(git(checkout, "status", "--porcelain")).toBe("");
    expect(calls).toEqual([STATUS]);
    expect(output).toContain(`The worker keeps running at ${oldSha.slice(0, 7)}.`);
  });

  it("checks the same way, then moves to the new commit and restarts when the database is up to date", () => {
    const { status, output, calls, seen } = runWithGit(UP_TO_DATE, 0);

    expect(status).toBe(0);
    expect(seen).toEqual(["OLD WORKER CODE", OLD_MIGRATION, MIGRATION]);
    expect(git(checkout, "rev-parse", "HEAD")).toBe(newSha);
    expect(readFileSync(path.join(checkout, "worker/dm-worker.ts"), "utf8")).toBe("NEW WORKER CODE\n");
    expect(git(checkout, "status", "--porcelain")).toBe("");
    expect(calls).toEqual([STATUS, ...INSTALL]);
    expect(output).toContain(`Worker now at ${newSha.slice(0, 7)} the new commit`);
  });

  it("touches nothing outside prisma/migrations: a change by hand stays, as with git pull", () => {
    write(checkout, "deploy/oracle/ecosystem.config.cjs", "// changed by hand\n");

    expect(runWithGit(PENDING, 1).status).toBe(1);
    expect(git(checkout, "rev-parse", "HEAD")).toBe(oldSha);
    expect(readdirSync(path.join(checkout, "prisma/migrations"))).toEqual([OLD_MIGRATION]);
    expect(git(checkout, "status", "--porcelain")).toBe("M deploy/oracle/ecosystem.config.cjs");

    expect(runWithGit(UP_TO_DATE, 0).status).toBe(0);
    expect(git(checkout, "rev-parse", "HEAD")).toBe(newSha);
    expect(git(checkout, "status", "--porcelain")).toBe("M deploy/oracle/ecosystem.config.cjs");
  });

  it("brings a revert to the VM when npm ci keeps failing at the merged commit", () => {
    // A commit whose packages npm ci cannot install on the VM.
    write(seed, "package-lock.json", "BAD_DEP\n");
    const broken = commitAndPush("a dependency bump");

    // It passes the check and is merged; then npm ci empties node_modules
    // and fails. The worker would keep running the old code from memory.
    const first = runWithGit(UP_TO_DATE, 0, { npm: NPM_CI });
    expect(first.status).not.toBe(0);
    expect(first.calls).toEqual([STATUS, "npm ci --no-fund --no-audit"]);
    expect(git(checkout, "rev-parse", "HEAD")).toBe(broken);
    expect(existsSync(path.join(checkout, "node_modules", ".package-lock.json"))).toBe(false);

    git(seed, "revert", "--no-edit", "HEAD");
    git(seed, "push", "-q", "origin", "main");
    const revert = git(seed, "rev-parse", "HEAD");

    // The revert adds no migration: it is installed without Prisma's check,
    // which could not run without node_modules.
    const second = runWithGit(UP_TO_DATE, 0, { npm: NPM_CI });
    expect(second.status).toBe(0);
    expect(second.seen).toEqual([]);
    expect(second.calls).toEqual(INSTALL);
    expect(second.output).toContain(WITHOUT_CHECK);
    expect(second.output).toContain(`Worker now at ${revert.slice(0, 7)}`);
    expect(git(checkout, "rev-parse", "HEAD")).toBe(revert);
    expect(git(checkout, "status", "--porcelain")).toBe("");
    expect(existsSync(path.join(checkout, "node_modules", ".package-lock.json"))).toBe(true);
  });

  it("does not install a new commit with a migration while node_modules is incomplete", () => {
    rmSync(path.join(checkout, "node_modules", ".package-lock.json"));

    const { status, output, calls, seen } = runWithGit(UP_TO_DATE, 0);

    expect(status).toBe(1);
    expect(output.trim()).toBe(REPAIR);
    expect(calls).toEqual([]);
    expect(seen).toEqual([]);
    expect(git(checkout, "rev-parse", "HEAD")).toBe(oldSha);
    expect(readdirSync(path.join(checkout, "prisma/migrations"))).toEqual([OLD_MIGRATION]);
    expect(git(checkout, "status", "--porcelain")).toBe("");
  });

  it("says how to go on when prisma/migrations cannot be set back, and the next run sets it back", () => {
    // Another git process holds the checkout's index while Prisma checks.
    const first = runWithGit(PENDING, 1, { duringCheck: "  touch .git/index.lock" });

    expect(first.status).toBe(1);
    expect(first.output).toContain(
      `Stopped: prisma/migrations could not be set back to ${oldSha.slice(0, 7)} (git says why above). The worker is unaffected: its code, node_modules and Prisma client were not touched. Run this script again; if that keeps failing: cd ~/openreply && git restore --source=HEAD --staged --worktree -- prisma/migrations`
    );
    expect(first.output).toContain("index.lock");
    expect(first.calls).toEqual([STATUS]);
    expect(git(checkout, "rev-parse", "HEAD")).toBe(oldSha);
    expect(readFileSync(path.join(checkout, "worker/dm-worker.ts"), "utf8")).toBe("OLD WORKER CODE\n");

    // The other git process is done.
    rmSync(path.join(checkout, ".git", "index.lock"));
    expect(git(checkout, "status", "--porcelain")).toBe(`A  prisma/migrations/${MIGRATION}/migration.sql`);

    const second = runWithGit(PENDING, 1);
    expect(second.status).toBe(1);
    expect(second.output).toContain("Stopped: the database lacks migrations of this commit.");
    expect(git(checkout, "status", "--porcelain")).toBe("");
    expect(readdirSync(path.join(checkout, "prisma/migrations"))).toEqual([OLD_MIGRATION]);
  });
});

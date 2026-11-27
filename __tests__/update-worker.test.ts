/**
 * deploy/oracle/update-worker.sh (Meta submission plan, part B, S1a): the
 * worker update stops while the database lacks a migration of the new
 * commit, because a new Prisma client against the old schema fails every
 * comment, tap, DM, follow-up and offer job ("column does not exist"). While
 * Prisma checks, only the new commit's migration folders sit beside the code
 * the worker runs, so a pm2 restart meanwhile still starts that code. An
 * incomplete node_modules (an npm ci that did not finish) stops it first,
 * with the repair.
 *
 * Runs the real script with bash on a throwaway folder in the OS temp
 * directory. npx, npm and pm2 are stand-ins on PATH that only write down how
 * they were called; `npx --yes=false prisma migrate status` answers with the
 * text and exit code Prisma 7 gives in that state. git is a stand-in too,
 * except in the last suite, which runs real git on local throwaway
 * repositories.
 * Nothing is installed, restarted or contacted.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
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
  "Stopped: node_modules is incomplete (an earlier npm ci did not finish). Nothing was changed or restarted. Once Vercel shows success: cd ~/openreply && npm ci --no-fund --no-audit && npx prisma generate, then run this script again.";

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

function stand(name: string, body: string, bin = path.join(dir, "bin")) {
  const file = path.join(bin, name);
  writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> "$CALLS"\n${body}\n`);
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

function readCalls(): string[] {
  try {
    return readFileSync(path.join(dir, "calls.log"), "utf8").trim().split("\n");
  } catch {
    // Nothing was called.
    return [];
  }
}

/** Runs the script with Prisma answering `status` and exiting `code`. */
function run(status: string, code: number, { fetchFails = false } = {}) {
  writeFileSync(path.join(dir, "status.txt"), status);
  stand(
    "git",
    [
      'case "$1" in',
      "  rev-parse)",
      `    if [ "$2" = "HEAD" ]; then echo "${PREVIOUS}"; else echo "${TARGET}"; fi ;;`,
      `  fetch) exit ${fetchFails ? 1 : 0} ;;`,
      '  log) echo "Worker now at 2222222 the new commit" ;;',
      "esac",
      "exit 0",
    ].join("\n")
  );
  standNpx(code);
  stand("npm", "exit 0");
  stand("pm2", "exit 0");

  const result = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: {
      NODE_ENV: "test",
      PATH: `${path.join(dir, "bin")}:/usr/bin:/bin`,
      HOME: path.join(dir, "home"),
      OPENREPLY_DIR: path.join(dir, "openreply"),
      CALLS: path.join(dir, "calls.log"),
      STATUS_FILE: path.join(dir, "status.txt"),
    },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}`, calls: readCalls() };
}

function expectNoDatabaseAddress(output: string) {
  for (const line of output.split("\n")) {
    expect(line, line).not.toMatch(/postgres|neon|@/i);
  }
}

const CHECK = [
  "git rev-parse HEAD",
  "git fetch -q",
  "git rev-parse @{upstream}",
  `git checkout -q ${TARGET} -- prisma/migrations`,
  STATUS,
  `git restore --source=${PREVIOUS} --staged --worktree -- prisma/migrations`,
];

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
      "npm ci --no-fund --no-audit",
      "npx prisma generate",
      "pm2 startOrReload deploy/oracle/ecosystem.config.cjs",
      "pm2 save",
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
  it.each([
    { label: "an empty node_modules", missing: ["node_modules"] },
    { label: "no npm lockfile in node_modules", missing: ["node_modules/.package-lock.json"] },
    { label: "no prisma in node_modules/.bin", missing: ["node_modules/.bin/prisma"] },
  ])("stops with the repair before git, Prisma, npm or pm2 with $label", ({ missing }) => {
    for (const entry of missing) {
      rmSync(path.join(dir, "openreply", entry), { recursive: true, force: true });
    }

    const { status, output, calls } = run(UP_TO_DATE, 0);

    expect(status).toBe(1);
    expect(calls).toEqual([]);
    expect(output.trim()).toBe(REPAIR);
  });
});

// Real git on local throwaway repositories: a bare "origin" and the VM's
// checkout at the old commit, with a new commit (new worker code and a new
// migration) pushed to origin.
describe("update-worker.sh with a real git checkout", () => {
  const OLD_MIGRATION = "20261127120000_messaging_tap_search";
  let gitEnv: NodeJS.ProcessEnv;
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
    const seed = path.join(dir, "seed");
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
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "the new commit");
    git(seed, "push", "-q", "origin", "main");
    newSha = git(seed, "rev-parse", "HEAD");

    rbin = path.join(dir, "rbin");
    mkdirSync(rbin);
  });

  /** Runs the script; during `migrate status` npx notes what pm2 would start. */
  function runWithGit(status: string, code: number) {
    writeFileSync(path.join(dir, "status.txt"), status);
    standNpx(
      code,
      rbin,
      [
        '  cat worker/dm-worker.ts > "$SEEN"',
        '  ls prisma/migrations >> "$SEEN"',
      ].join("\n")
    );
    stand("npm", "exit 0", rbin);
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
      seen: readFileSync(path.join(dir, "seen.txt"), "utf8").trim().split("\n"),
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
    expect(calls).toEqual([
      STATUS,
      "npm ci --no-fund --no-audit",
      "npx prisma generate",
      "pm2 startOrReload deploy/oracle/ecosystem.config.cjs",
      "pm2 save",
    ]);
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
});

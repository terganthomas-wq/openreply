/**
 * deploy/oracle/update-worker.sh (Meta submission plan, part B, S1a): the
 * worker update stops while the database lacks a migration of the new
 * commit, because a new Prisma client against the old schema fails every
 * comment, tap, DM, follow-up and offer job ("column does not exist").
 *
 * Runs the real script with bash on a throwaway folder in the OS temp
 * directory. git, npx, npm and pm2 are stand-ins on PATH that only write
 * down how they were called; `npx prisma migrate status` answers with the
 * text and exit code Prisma 7 gives in that state. Nothing is installed,
 * restarted or contacted.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = path.join(__dirname, "..", "deploy", "oracle", "update-worker.sh");
const PREVIOUS = "1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MIGRATION = "20261127180000_review_demo_workspace";

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

function stand(name: string, body: string) {
  const file = path.join(dir, "bin", name);
  writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> "$CALLS"\n${body}\n`);
  chmodSync(file, 0o755);
}

/** Runs the script with Prisma answering `status` and exiting `code`. */
function run(status: string, code: number, { pullFails = false } = {}) {
  writeFileSync(path.join(dir, "status.txt"), status);
  stand(
    "git",
    [
      'case "$1" in',
      `  rev-parse) echo "${PREVIOUS}" ;;`,
      `  pull) exit ${pullFails ? 1 : 0} ;;`,
      '  log) echo "Worker now at 2222222 the new commit" ;;',
      "esac",
      "exit 0",
    ].join("\n")
  );
  stand(
    "npx",
    [
      'if [ "$1 $2 $3" = "prisma migrate status" ]; then',
      // Prisma writes the datasource line to stdout and errors to stderr.
      '  head -n 4 "$STATUS_FILE"',
      '  tail -n +5 "$STATUS_FILE" >&2',
      `  exit ${code}`,
      "fi",
      "exit 0",
    ].join("\n")
  );
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
  let calls: string[] = [];
  try {
    calls = readFileSync(path.join(dir, "calls.log"), "utf8").trim().split("\n");
  } catch {
    // Nothing was called.
  }
  return { status: result.status, output: `${result.stdout}${result.stderr}`, calls };
}

function expectNoDatabaseAddress(output: string) {
  for (const line of output.split("\n")) {
    expect(line, line).not.toMatch(/postgres|neon|@/i);
  }
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "openreply-update-worker-"));
  mkdirSync(path.join(dir, "bin"));
  mkdirSync(path.join(dir, "home"));
  mkdirSync(path.join(dir, "openreply"));
});

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("update-worker.sh while a migration is pending", () => {
  it("sets the checkout back, installs and restarts nothing, and stops", () => {
    const { status, output, calls } = run(PENDING, 1);

    expect(status).toBe(1);
    expect(calls).toEqual([
      "git rev-parse HEAD",
      "git pull --ff-only",
      "npx prisma migrate status",
      `git reset -q --hard ${PREVIOUS}`,
    ]);
    expect(calls.some((call) => call.startsWith("npm"))).toBe(false);
    expect(calls.some((call) => call.startsWith("pm2"))).toBe(false);
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
      expect(result.calls).toContain(`git reset -q --hard ${PREVIOUS}`);
      expect(result.calls.some((call) => call.startsWith("npm") || call.startsWith("pm2"))).toBe(false);
      expect(result.output).toContain(MIGRATION);
      expect(result.output).toContain("Stopped: the database lacks migrations of this commit.");
      expectNoDatabaseAddress(result.output);
      rmSync(path.join(dir, "calls.log"), { force: true });
    }
  });

  it("names neither host nor user when the database cannot be asked", () => {
    const { status, output, calls } = run(UNREACHABLE, 1);

    expect(status).toBe(1);
    expect(calls).toContain(`git reset -q --hard ${PREVIOUS}`);
    expect(calls.some((call) => call.startsWith("npm") || call.startsWith("pm2"))).toBe(false);
    expect(output).toContain("Stopped: prisma migrate status could not check the database (exit 1;");
    expect(output).toContain("The worker keeps running at 1111111.");
    expectNoDatabaseAddress(output);
  });
});

describe("update-worker.sh when the database is up to date", () => {
  it("installs, generates, reloads pm2 and says where the worker is now", () => {
    const { status, output, calls } = run(UP_TO_DATE, 0);

    expect(status).toBe(0);
    expect(calls).toEqual([
      "git rev-parse HEAD",
      "git pull --ff-only",
      "npx prisma migrate status",
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

describe("update-worker.sh when the pull fails", () => {
  it("stops before asking the database and touches nothing", () => {
    const { status, calls } = run(UP_TO_DATE, 0, { pullFails: true });

    expect(status).not.toBe(0);
    expect(calls).toEqual(["git rev-parse HEAD", "git pull --ff-only"]);
  });
});

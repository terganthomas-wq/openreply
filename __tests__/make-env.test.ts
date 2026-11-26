/**
 * deploy/make-env.mjs (A1): worker.env carries what the worker needs to
 * e-mail the owners about a lost Instagram connection — RESEND_API_KEY,
 * EMAIL_FROM, the app's address for the link (NEXTAUTH_URL) and German
 * (DEFAULT_LOCALE) — next to everything it had before.
 *
 * Runs the script on a throwaway folder in the OS temp directory with
 * made-up values; nothing is sent anywhere.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = path.join(__dirname, "..", "deploy", "make-env.mjs");
const KEY = "re_madeUpForThisTest123";
let dir: string;
let output: string;

function readEnv(name: string): Record<string, string> {
  return Object.fromEntries(
    readFileSync(path.join(dir, name), "utf8")
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)])
  );
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "openreply-make-env-"));
  writeFileSync(
    path.join(dir, "meine-zugangsdaten.env"),
    [
      "APP_URL=https://dm.example.test",
      "LOGIN_EMAIL=owner@example.test",
      "DATABASE_URL=postgresql://user:made-up@db.example.test/app?sslmode=require",
      "REDIS_URL=redis://default:made-up@redis.example.test:6379",
      `RESEND_API_KEY=${KEY}`,
      "",
    ].join("\n")
  );
  output = execFileSync(process.execPath, [SCRIPT, dir], { encoding: "utf8" });
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("worker.env", () => {
  it("has the e-mail settings and the app's address for the alert", () => {
    const worker = readEnv("worker.env");
    expect(worker).toMatchObject({
      NEXTAUTH_URL: "https://dm.example.test",
      RESEND_API_KEY: KEY,
      EMAIL_FROM: "OpenReply <onboarding@resend.dev>",
      DEFAULT_LOCALE: "de",
    });
  });

  it("keeps everything the worker had before", () => {
    const worker = readEnv("worker.env");
    expect(worker).toMatchObject({
      NODE_ENV: "production",
      TZ: "UTC",
      COMMENT_POLL_INTERVAL_MS: "1800000",
      COMMENT_POLL_MEDIA_LIMIT: "30",
      DATABASE_URL: "postgresql://user:made-up@db.example.test/app?sslmode=require",
      REDIS_URL: "redis://default:made-up@redis.example.test:6379",
    });
    expect(worker.ENCRYPTION_KEY).toMatch(/^[0-9a-f]{64}$/);
    // The worker needs no cron secret.
    expect(worker).not.toHaveProperty("CRON_SECRET");
  });

  it("leaves the web app's sender as it was, and prints no secret", () => {
    const vercel = readEnv("vercel.env");
    expect(vercel.EMAIL_FROM).toBe("OpenReply Login <onboarding@resend.dev>");
    expect(vercel.RESEND_API_KEY).toBe(KEY);
    expect(output).not.toContain(KEY);
    expect(output).not.toContain("made-up");
  });
});

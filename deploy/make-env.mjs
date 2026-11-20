#!/usr/bin/env node
// Builds the env files for this deployment (Vercel web app + Oracle worker)
// from one file the operator fills in. Never prints a secret value.
//
//   node deploy/make-env.mjs <folder>
//
//   <folder>/meine-zugangsdaten.env  filled in by you (template on first run)
//   <folder>/.intern.env             app-internal secrets, generated ONCE.
//                                    Never delete: a new ENCRYPTION_KEY makes
//                                    every connected Instagram account unusable.
//   <folder>/vercel.env              paste into Vercel > Settings > Environment Variables
//   <folder>/worker.env              copied to the VM as ~/openreply/.env
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const dir = path.resolve(process.argv[2] ?? "zugangsdaten");
const userFile = path.join(dir, "meine-zugangsdaten.env");
const internFile = path.join(dir, ".intern.env");

const TEMPLATE = `# Deine Zugangsdaten für OpenReply. Nur du füllst diese Datei aus.
# Nie in einen Chat kopieren und nie committen. Leer lassen, was noch fehlt.

# Adresse der Web-App, ohne Schrägstrich am Ende, z. B. https://dm.deine-domain.de
APP_URL=

# E-Mail-Adresse für den Dashboard-Login (dieselbe wie bei deinem Resend-Konto)
LOGIN_EMAIL=

# Neon: Connection string mit "Connection pooling" AUS (im Host steht kein "-pooler")
DATABASE_URL=

# Redis Cloud: redis://default:PASSWORT@HOST:PORT
REDIS_URL=

# Resend: API-Key, beginnt mit re_
RESEND_API_KEY=

# Meta-App (kommt später): App-ID, ID der Login-Konfiguration, App-Geheimcode
META_APP_ID=
META_LOGIN_CONFIG_ID=
FACEBOOK_APP_SECRET=

# Optional: deine eigenen Rechtstexte. Dann leiten /privacy, /terms und
# /data-deletion der Web-App auf diese Seiten weiter.
LEGAL_PRIVACY_URL=
LEGAL_TERMS_URL=
LEGAL_DATA_DELETION_URL=
`;

const RULES = {
  APP_URL: [/^https:\/\/[^/\s]+$/, "https://… ohne Pfad und ohne / am Ende"],
  LOGIN_EMAIL: [/^[^@\s,]+@[^@\s,]+\.[^@\s,]+(,[^@\s,]+@[^@\s,]+\.[^@\s,]+)*$/, "E-Mail-Adresse"],
  DATABASE_URL: [/^postgres(ql)?:\/\/[^\s]+$/, "postgresql://…"],
  REDIS_URL: [/^rediss?:\/\/[^\s:@]*:[^\s@]+@[^\s:]+:\d+\/?$/, "redis://default:PASSWORT@HOST:PORT"],
  RESEND_API_KEY: [/^re_[A-Za-z0-9_]+$/, "beginnt mit re_"],
  META_APP_ID: [/^\d{6,20}$/, "nur Ziffern"],
  META_LOGIN_CONFIG_ID: [/^\d{6,20}$/, "nur Ziffern"],
  FACEBOOK_APP_SECRET: [/^[a-f0-9]{32}$/, "32 Zeichen 0-9/a-f"],
  LEGAL_PRIVACY_URL: [/^https:\/\/\S+$/, "https://…"],
  LEGAL_TERMS_URL: [/^https:\/\/\S+$/, "https://…"],
  LEGAL_DATA_DELETION_URL: [/^https:\/\/\S+$/, "https://…"],
};
const REQUIRED = ["APP_URL", "LOGIN_EMAIL", "DATABASE_URL", "REDIS_URL", "RESEND_API_KEY"];
const META = ["META_APP_ID", "META_LOGIN_CONFIG_ID", "FACEBOOK_APP_SECRET"];

function parse(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    let value = line.slice(eq + 1).trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (value) out[line.slice(0, eq).trim()] = value;
  }
  return out;
}

function write(file, entries) {
  const body = entries.filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `${k}=${v}`).join("\n");
  fs.writeFileSync(file, body + "\n", { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
if (!fs.existsSync(userFile)) {
  fs.writeFileSync(userFile, TEMPLATE, { mode: 0o600 });
  console.log(`Vorlage angelegt: ${userFile}`);
}

const intern = parse(internFile);
const generated = {
  NEXTAUTH_SECRET: () => randomBytes(32).toString("base64"),
  CRON_SECRET: () => randomBytes(32).toString("hex"),
  ENCRYPTION_KEY: () => randomBytes(32).toString("hex"),
  WEBHOOK_VERIFY_TOKEN: () => randomBytes(24).toString("hex"),
};
let created = 0;
for (const [key, make] of Object.entries(generated)) {
  if (!intern[key]) { intern[key] = make(); created++; }
}
if (created) write(internFile, Object.entries(intern));
if (!/^[0-9a-f]{64}$/.test(intern.ENCRYPTION_KEY)) throw new Error(".intern.env: ENCRYPTION_KEY ist beschädigt");

const u = parse(userFile);
const status = {};
for (const [key, [re, hint]] of Object.entries(RULES)) {
  if (!u[key]) status[key] = REQUIRED.includes(key) ? "fehlt" : "leer";
  else if (!re.test(u[key])) status[key] = `Format prüfen (${hint})`;
  else status[key] = "ok";
}
if (status.DATABASE_URL === "ok") {
  const host = new URL(u.DATABASE_URL).hostname;
  if (host.includes("-pooler")) status.DATABASE_URL = "Pooling ist an: in Neon \"Connection pooling\" ausschalten und neu kopieren";
  else if (!/sslmode=require/.test(u.DATABASE_URL)) status.DATABASE_URL = "ok (Hinweis: ?sslmode=require fehlt)";
}
const metaSet = META.filter((k) => status[k] === "ok").length;
const usable = (k) => status[k]?.startsWith("ok");

console.log("\nStatus (Werte werden nie angezeigt):");
for (const [key, s] of Object.entries(status)) console.log(`  ${s.startsWith("ok") ? "✓" : s === "leer" ? "·" : "✗"} ${key.padEnd(24)} ${s}`);
console.log(`  ✓ ${"interne Schlüssel".padEnd(24)} ${created ? `${created} neu erzeugt` : "vorhanden"}`);

const missing = REQUIRED.filter((k) => !usable(k));
if (missing.length) {
  console.log(`\nNoch nicht vollständig: ${missing.join(", ")}. Keine Ausgabedateien geschrieben.`);
  process.exit(2);
}
if (metaSet > 0 && metaSet < META.length) {
  console.log("\nMeta-Werte nur teilweise eingetragen: Bitte alle drei oder keinen.");
  process.exit(2);
}
const pick = (k) => (usable(k) ? u[k] : undefined);

write(path.join(dir, "vercel.env"), [
  ["NEXTAUTH_URL", u.APP_URL],
  ["NEXTAUTH_SECRET", intern.NEXTAUTH_SECRET],
  ["CRON_SECRET", intern.CRON_SECRET],
  ["ENCRYPTION_KEY", intern.ENCRYPTION_KEY],
  ["WEBHOOK_VERIFY_TOKEN", intern.WEBHOOK_VERIFY_TOKEN],
  ["DATABASE_URL", u.DATABASE_URL],
  ["REDIS_URL", u.REDIS_URL],
  ["RESEND_API_KEY", u.RESEND_API_KEY],
  ["EMAIL_FROM", "OpenReply Login <onboarding@resend.dev>"],
  ["ALLOWED_EMAILS", u.LOGIN_EMAIL],
  ["META_GRAPH_API_VERSION", "v25.0"],
  ["META_APP_ID", pick("META_APP_ID")],
  ["META_LOGIN_CONFIG_ID", pick("META_LOGIN_CONFIG_ID")],
  ["FACEBOOK_APP_SECRET", pick("FACEBOOK_APP_SECRET")],
  ["LEGAL_PRIVACY_URL", pick("LEGAL_PRIVACY_URL")],
  ["LEGAL_TERMS_URL", pick("LEGAL_TERMS_URL")],
  ["LEGAL_DATA_DELETION_URL", pick("LEGAL_DATA_DELETION_URL")],
  ["DB_POOL_MAX", "2"],
  ["HEALTH_STUCK_QUEUE_WAITING", "3"],
  ["NEXT_TELEMETRY_DISABLED", "1"],
  ["CHECKPOINT_DISABLE", "1"],
]);

write(path.join(dir, "worker.env"), [
  ["NODE_ENV", "production"],
  ["TZ", "UTC"],
  ["NEXTAUTH_URL", u.APP_URL],
  ["NEXTAUTH_SECRET", intern.NEXTAUTH_SECRET],
  ["ENCRYPTION_KEY", intern.ENCRYPTION_KEY],
  ["DATABASE_URL", u.DATABASE_URL],
  ["REDIS_URL", u.REDIS_URL],
  ["META_GRAPH_API_VERSION", "v25.0"],
  // Neon Free sleeps after 5 idle minutes and allows 100 CU-hours a month.
  // The default 5-minute sweep would keep it awake around the clock.
  ["COMMENT_POLL_INTERVAL_MS", "1800000"],
  ["DB_POOL_MAX", "3"],
  ["CHECKPOINT_DISABLE", "1"],
]);

console.log(`\nGeschrieben: vercel.env und worker.env in ${dir}`);
console.log(metaSet ? "Meta-Werte sind enthalten." : "Meta-Werte fehlen noch: Instagram lässt sich erst danach verbinden.");

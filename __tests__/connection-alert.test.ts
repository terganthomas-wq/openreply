/**
 * The alert e-mail about a lost Instagram connection (A1): when it is due
 * (at most one per 24 hours, one reminder), who gets it (owners and admins
 * only), what Resend gets (and what not), the German and the English copy,
 * the SMTP fallback, the claim before the send and what happens when no
 * e-mail is configured or a send fails.
 *
 * Resend is fetch answered here and SMTP a mocked nodemailer: nothing leaves
 * the test. The account rows are an in-memory stand-in that evaluates the
 * claim's conditions (helpers/fake-connection-db.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeConnectionDb, fakeAccount } from "./helpers/fake-connection-db";

const state = vi.hoisted(() => ({
  db: null as unknown as import("./helpers/fake-connection-db").FakeConnectionDb,
}));
const smtp = vi.hoisted(() => ({
  createTransport: vi.fn(),
  sendMail: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  get prisma() {
    return state.db.prisma;
  },
}));
vi.mock("nodemailer", () => ({
  createTransport: smtp.createTransport,
  default: { createTransport: smtp.createTransport },
}));

import {
  connectionAlertDue,
  connectionAlertIdempotencyKey,
  connectionAlertRecipients,
  resetConnectionAlertWarnings,
  sendConnectionAlert,
  type AlertAccount,
} from "../lib/ops/connection-alert";
import { buildConnectionAlertEmail } from "../lib/ops/connection-alert-email";
import {
  mailTransportFromEnv,
  RESEND_EMAILS_URL,
  resetMailWarnings,
} from "../lib/ops/mail";

const NOW = new Date("2026-11-25T18:15:00.000Z").getTime();
const LOST_AT = new Date("2026-11-25T16:45:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const FORMAL = /\b(?:Sie|Ihnen|Ihr|Ihre[mnrs]?)\b/;

let resendCalls: { url: string; init: RequestInit; body: Record<string, unknown> }[];
let resendAnswer: (call: number, to: string) => Response | Promise<Response>;

function account(): AlertAccount {
  const row = state.db.account();
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    username: row.username,
    connectionLostAt: row.connectionLostAt,
    connectionLostReason: row.connectionLostReason,
    connectionAlertSentAt: row.connectionAlertSentAt,
    connectionAlertCount: row.connectionAlertCount,
  };
}

function warnings() {
  return state.db.events.filter((event) => event.level === "WARNING");
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  state.db = new FakeConnectionDb();
  state.db.accounts.push(
    fakeAccount({
      connectionCheckFailedAt: LOST_AT,
      connectionLostAt: LOST_AT,
      connectionLostReason: "missing (Meta 100/33)",
    })
  );
  state.db.users.push(
    { id: "u_owner", email: "owner@example.test" },
    { id: "u_admin", email: "admin@example.test" },
    { id: "u_member", email: "member@example.test" },
    { id: "u_other", email: "other-admin@example.test" }
  );
  state.db.workspaces.push(
    { id: "workspace_1", ownerId: "u_owner" },
    { id: "workspace_2", ownerId: "u_other" }
  );
  state.db.members.push(
    { workspaceId: "workspace_1", userId: "u_owner", role: "OWNER", createdAt: new Date(NOW - 3 * HOUR) },
    { workspaceId: "workspace_1", userId: "u_admin", role: "ADMIN", createdAt: new Date(NOW - 2 * HOUR) },
    { workspaceId: "workspace_1", userId: "u_member", role: "MEMBER", createdAt: new Date(NOW - HOUR) },
    { workspaceId: "workspace_2", userId: "u_other", role: "OWNER", createdAt: new Date(NOW - HOUR) }
  );
  resendCalls = [];
  resendAnswer = (call) => Response.json({ id: `email_${call}` });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url !== RESEND_EMAILS_URL) throw new Error(`unexpected request to ${url}`);
      const body = JSON.parse(String(init?.body));
      resendCalls.push({ url, init: init ?? {}, body });
      return resendAnswer(resendCalls.length, (body.to as string[])[0]);
    })
  );
  vi.stubEnv("RESEND_API_KEY", "re_test_only");
  vi.stubEnv("EMAIL_FROM", "OpenReply <alerts@example.test>");
  vi.stubEnv("EMAIL_SERVER", "");
  vi.stubEnv("NEXTAUTH_URL", "https://dm.example.test");
  vi.stubEnv("DEFAULT_LOCALE", "de");
  resetMailWarnings();
  resetConnectionAlertWarnings();
  smtp.createTransport.mockReset().mockImplementation(() => ({ sendMail: smtp.sendMail }));
  smtp.sendMail.mockReset().mockResolvedValue({ messageId: "m" });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("when an e-mail is due", () => {
  const open = { connectionLostAt: LOST_AT, connectionAlertSentAt: null, connectionAlertCount: 0 };

  it("sends the alert first, the reminder 24 hours after the last e-mail, then nothing", () => {
    expect(connectionAlertDue(open, NOW)).toBe("alert");
    const alerted = { ...open, connectionAlertSentAt: new Date(NOW), connectionAlertCount: 1 };
    expect(connectionAlertDue(alerted, NOW + DAY - 1)).toBeNull();
    expect(connectionAlertDue(alerted, NOW + DAY)).toBe("reminder");
    const reminded = { ...alerted, connectionAlertSentAt: new Date(NOW + DAY), connectionAlertCount: 2 };
    expect(connectionAlertDue(reminded, NOW + 10 * DAY)).toBeNull();
  });

  it("counts the 24 hours across incidents, and sends nothing without one", () => {
    // An e-mail about the previous incident two hours ago.
    const earlier = { ...open, connectionAlertSentAt: new Date(NOW - 2 * HOUR) };
    expect(connectionAlertDue(earlier, NOW)).toBeNull();
    expect(connectionAlertDue(earlier, NOW - 2 * HOUR + DAY)).toBe("alert");
    expect(connectionAlertDue({ ...open, connectionLostAt: null }, NOW)).toBeNull();
  });
});

describe("who gets it", () => {
  it("the workspace's owners and admins, never its members or another workspace", async () => {
    expect(await connectionAlertRecipients("workspace_1")).toEqual([
      "owner@example.test",
      "admin@example.test",
    ]);
  });

  it("the workspace's owner without a membership row, but not one made a member", async () => {
    state.db.members = state.db.members.filter((member) => member.userId !== "u_owner");
    expect(await connectionAlertRecipients("workspace_1")).toEqual([
      "owner@example.test",
      "admin@example.test",
    ]);
    state.db.members.push({
      workspaceId: "workspace_1",
      userId: "u_owner",
      role: "MEMBER",
      createdAt: new Date(NOW),
    });
    expect(await connectionAlertRecipients("workspace_1")).toEqual(["admin@example.test"]);
  });

  it("each address once, and none that is empty or no address", async () => {
    state.db.users.push(
      { id: "u_twice", email: "OWNER@example.test" },
      { id: "u_none", email: null },
      { id: "u_bad", email: "not an address" }
    );
    for (const userId of ["u_twice", "u_none", "u_bad"]) {
      state.db.members.push({ workspaceId: "workspace_1", userId, role: "ADMIN", createdAt: new Date(NOW) });
    }
    expect(await connectionAlertRecipients("workspace_1")).toEqual([
      "owner@example.test",
      "admin@example.test",
    ]);
  });
});

describe("the transport", () => {
  it("is Resend with RESEND_API_KEY, SMTP with EMAIL_SERVER, and nothing without EMAIL_FROM", () => {
    expect(mailTransportFromEnv({})).toBeNull();
    expect(mailTransportFromEnv({ RESEND_API_KEY: "re_x" })).toBeNull();
    expect(mailTransportFromEnv({ EMAIL_FROM: "OpenReply <a@example.test>" })).toBeNull();
    expect(mailTransportFromEnv({ EMAIL_FROM: "a@example.test", RESEND_API_KEY: "re_x" })?.name).toBe("resend");
    // Like the sign-in e-mails: SMTP takes over when it is set.
    expect(
      mailTransportFromEnv({
        EMAIL_FROM: "a@example.test",
        RESEND_API_KEY: "re_x",
        EMAIL_SERVER: "smtps://user:pass@mail.example.test:465",
      })?.name
    ).toBe("smtp");
  });
});

describe("the e-mail through Resend", () => {
  it("goes to each owner and admin on its own, with the key only in the header", async () => {
    expect(await sendConnectionAlert(account())).toBe("sent");

    expect(resendCalls).toHaveLength(2);
    const [first, second] = resendCalls;
    expect(first.url).toBe("https://api.resend.com/emails");
    expect(first.init.method).toBe("POST");
    expect(first.init.headers).toEqual({
      Authorization: "Bearer re_test_only",
      "Content-Type": "application/json",
      "Idempotency-Key": connectionAlertIdempotencyKey({
        accountId: "account_1",
        lostAt: LOST_AT,
        number: 1,
        to: "owner@example.test",
      }),
      "User-Agent": "OpenReply-Worker",
    });
    expect(first.body).toEqual({
      from: "OpenReply <alerts@example.test>",
      to: ["owner@example.test"],
      subject: "Instagram-Verbindung unterbrochen: OpenReply sendet gerade keine DMs",
      text: expect.any(String),
      html: expect.any(String),
      headers: { "Auto-Submitted": "auto-generated" },
    });
    expect(second.body.to).toEqual(["admin@example.test"]);
    const key = (call: (typeof resendCalls)[number]) =>
      (call.init.headers as Record<string, string>)["Idempotency-Key"];
    // One key per person: Resend would take a second person's e-mail with
    // the same key for the first one's.
    expect(key(second)).not.toBe(key(first));
    // No secret and no id in what Resend gets, and no address in the key.
    for (const call of resendCalls) {
      const sent = JSON.stringify(call.body);
      for (const secret of ["re_test_only", "encrypted", "local-test-token", "ig_1", "100/33", "account_1"]) {
        expect(sent, secret).not.toContain(secret);
      }
      expect((call.init.headers as Record<string, string>)["Idempotency-Key"]).not.toContain("@");
    }

    expect(state.db.account()).toMatchObject({
      connectionAlertCount: 1,
      connectionAlertSentAt: new Date(NOW),
    });
    expect(state.db.events).toEqual([
      expect.objectContaining({
        level: "INFO",
        payload: { kind: "connection-alert", account: "thomas.tergan", recipients: 2, reminder: false },
      }),
    ]);
    expect(JSON.stringify(state.db.events)).not.toContain("example.test");
  });

  it("says since when in Berlin time, what it means, the causes and the fix, with du", async () => {
    await sendConnectionAlert(account());
    const { text, html, subject } = resendCalls[0].body as Record<string, string>;

    expect(text).toContain(
      "seit dem 25.11.2026 um 17:45 Uhr erreicht OpenReply dein Instagram-Konto @thomas.tergan nicht mehr."
    );
    for (const line of [
      "- Auf Kommentare mit deinen Keywords geht keine DM raus.",
      "- Tippt jemand in einer DM auf einen Button, passiert nichts.",
      "- Unter Kommentaren erscheinen keine öffentlichen Antworten.",
      "Meta meldet: OpenReply hat keinen Zugriff mehr auf dein Instagram-Konto.",
      "- Instagram wurde mit Facebook verknüpft oder davon getrennt.",
      "- Im Unternehmensportfolio (Meta Business Suite) hat sich etwas geändert.",
      "- Die App wurde in Instagram unter „Apps und Websites“ entfernt.",
      "- Das Passwort oder die Sicherheitseinstellungen wurden geändert.",
      "1. Öffne die Einstellungen von OpenReply: https://dm.example.test/settings",
      "2. Tippe auf „Neu verbinden“ oder „Mit eigener Meta-App verbinden“ und melde dich bei Meta an.",
      "3. Wähle dein Instagram-Konto und erlaube alle Berechtigungen.",
      "Danach holt OpenReply die Kommentare aus der Zwischenzeit von selbst nach.",
    ]) {
      expect(text).toContain(line);
    }
    for (const part of [subject, text, html]) expect(part).not.toMatch(FORMAL);

    // The HTML says the same, with one link: to the settings, as typed.
    expect(html).toContain("seit dem 25.11.2026 um 17:45 Uhr");
    expect(html).toContain("Neu verbinden");
    expect([...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1])).toEqual([
      "https://dm.example.test/settings",
    ]);
    expect(html).not.toMatch(/<img|utm_|\/r\/|pixel|track/i);
  });

  it("escapes what it puts into the HTML", () => {
    const { html, text } = buildConnectionAlertEmail({
      locale: "de",
      kind: "alert",
      username: 'shop<b>"&',
      lostAt: LOST_AT,
      reason: "token",
      settingsUrl: 'https://dm.example.test/settings?x="1"&y=<2>',
    });
    expect(html).toContain("@shop&lt;b&gt;&quot;&amp;");
    expect(html).toContain('href="https://dm.example.test/settings?x=&quot;1&quot;&amp;y=&lt;2&gt;"');
    expect(html).not.toContain("<b>");
    expect(text).toContain('@shop<b>"&');
  });

  it("is in English with UTC for every other locale", async () => {
    vi.stubEnv("DEFAULT_LOCALE", "");
    await sendConnectionAlert(account());
    const english = resendCalls[0].body as Record<string, string>;
    expect(english.subject).toBe("Instagram connection lost: OpenReply is not sending DMs right now");
    expect(english.text).toContain(
      "Since 25 November 2026, 16:45 UTC, OpenReply can no longer reach your Instagram account @thomas.tergan."
    );
    expect(english.text).toContain("1. Open OpenReply's settings: https://dm.example.test/settings");
    expect(english.text).toContain("Afterwards OpenReply catches up on the comments of the meantime by itself.");

    const zh = buildConnectionAlertEmail({
      locale: "en",
      kind: "reminder",
      username: "x",
      lostAt: LOST_AT,
      reason: "permission",
      settingsUrl: null,
    });
    expect(zh.subject).toBe("Reminder: Instagram connection still lost, OpenReply is still not sending DMs");
  });

  it("writes the reminder as one, and leaves the link out without the app's address", () => {
    const reminder = buildConnectionAlertEmail({
      locale: "de",
      kind: "reminder",
      username: "thomas.tergan",
      lostAt: LOST_AT,
      reason: "unknown",
      settingsUrl: null,
    });
    expect(reminder.subject).toBe(
      "Erinnerung: Instagram-Verbindung noch unterbrochen, OpenReply sendet weiter keine DMs"
    );
    expect(reminder.text).toContain("Das ist die Erinnerung: Die Verbindung ist seit über 24 Stunden unterbrochen.");
    expect(reminder.text).toContain("1. Öffne in OpenReply die Einstellungen.");
    expect(reminder.text).toContain("Weitere E-Mails zu dieser Unterbrechung kommen nicht");
    expect(reminder.html).not.toContain("<a ");
    for (const part of [reminder.subject, reminder.text, reminder.html]) {
      expect(part).not.toMatch(FORMAL);
    }
  });

  it("names the reason in plain words", () => {
    const words = (reason: "token" | "permission" | "missing" | "unknown") =>
      buildConnectionAlertEmail({ locale: "de", kind: "alert", username: "x", lostAt: LOST_AT, reason, settingsUrl: null })
        .text.split("\n")
        .find((line) => line.startsWith("Meta meldet:"));
    expect(words("token")).toBe(
      "Meta meldet: Der Zugang von OpenReply zu deinem Konto ist abgelaufen oder wurde widerrufen."
    );
    expect(words("permission")).toBe("Meta meldet: OpenReply fehlen Berechtigungen für dein Konto.");
    expect(words("unknown")).toBe("Meta meldet: Meta lehnt den Zugriff auf dein Konto ab.");
  });
});

describe("claiming the e-mail", () => {
  it("sends it once when two checks want it at the same moment", async () => {
    const [a, b] = await Promise.all([
      sendConnectionAlert(account()),
      sendConnectionAlert(account()),
    ]);
    expect([a, b].sort()).toEqual(["sent", "taken"]);
    expect(resendCalls).toHaveLength(2);
  });

  it("sends nothing for an incident that ended in the meantime", async () => {
    const decidedOn = account();
    state.db.account().connectionLostAt = null;
    expect(await sendConnectionAlert(decidedOn)).toBe("taken");
    expect(resendCalls).toHaveLength(0);
  });

  it("gives the claim back without an answer, and tries again with the same keys", async () => {
    resendAnswer = () => Response.json({ message: "Internal server error" }, { status: 500 });
    expect(await sendConnectionAlert(account())).toBe("failed");
    expect(state.db.account()).toMatchObject({
      connectionAlertCount: 0,
      connectionAlertSentAt: null,
    });
    expect(warnings().at(-1)?.message).toContain("the next check tries again");
    const firstKeys = resendCalls.map((call) => (call.init.headers as Record<string, string>)["Idempotency-Key"]);

    resendAnswer = () => {
      throw new TypeError("fetch failed");
    };
    vi.setSystemTime(NOW + 30 * 60_000);
    expect(await sendConnectionAlert(account())).toBe("failed");
    expect(state.db.account().connectionAlertCount).toBe(0);

    resendAnswer = (call) => Response.json({ id: `email_${call}` });
    vi.setSystemTime(NOW + 60 * 60_000);
    expect(await sendConnectionAlert(account())).toBe("sent");
    const lastKeys = resendCalls.slice(-2).map((call) => (call.init.headers as Record<string, string>)["Idempotency-Key"]);
    expect(lastKeys).toEqual(firstKeys);
    expect(state.db.account().connectionAlertCount).toBe(1);
  });

  it("keeps the claim after a refusal and does not try again every sweep", async () => {
    resendAnswer = () =>
      Response.json(
        { statusCode: 403, name: "validation_error", message: "You can only send testing emails to your own email address (owner@example.test)." },
        { status: 403 }
      );
    expect(await sendConnectionAlert(account())).toBe("failed");
    expect(state.db.account().connectionAlertCount).toBe(1);
    const warning = warnings().at(-1)!.message;
    expect(warning).toContain("Resend 403");
    expect(warning).toContain("not tried again");
    // The address in Resend's answer stays out of Diagnostics.
    expect(warning).not.toContain("owner@example.test");

    vi.setSystemTime(NOW + 30 * 60_000);
    expect(await sendConnectionAlert(account())).toBe("not-due");
    expect(resendCalls).toHaveLength(2);
  });

  it("counts it sent when one person got it, and names who did not get it", async () => {
    resendAnswer = (_call, to) =>
      to === "admin@example.test"
        ? Response.json({ message: "The `to` address is invalid" }, { status: 422 })
        : Response.json({ id: "ok" });
    expect(await sendConnectionAlert(account())).toBe("sent");
    expect(state.db.events.map((event) => event.level)).toEqual(["INFO", "WARNING"]);
    expect(state.db.events[0].payload).toMatchObject({ recipients: 1 });
    expect(state.db.events[1].message).toContain("not sent to 1 of 2");
  });

  it("takes Resend's answer for a key it already has as sent", async () => {
    resendAnswer = () => Response.json({ name: "concurrent_idempotent_requests" }, { status: 409 });
    expect(await sendConnectionAlert(account())).toBe("sent");
    expect(state.db.account().connectionAlertCount).toBe(1);
  });
});

describe("without e-mail settings or recipients", () => {
  it("records one WARNING per process and claims nothing, so the alert goes out once they are set", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    expect(await sendConnectionAlert(account())).toBe("no-mail");
    vi.setSystemTime(NOW + 30 * 60_000);
    expect(await sendConnectionAlert(account())).toBe("no-mail");

    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toMatchObject({
      workspaceId: null,
      payload: { kind: "mail-unconfigured" },
    });
    expect(warnings()[0].message).toContain("RESEND_API_KEY and EMAIL_FROM");
    expect(state.db.account()).toMatchObject({ connectionAlertCount: 0, connectionAlertSentAt: null });
    expect(resendCalls).toHaveLength(0);

    vi.stubEnv("RESEND_API_KEY", "re_test_only");
    expect(await sendConnectionAlert(account())).toBe("sent");
    expect(resendCalls).toHaveLength(2);
  });

  it("claims nothing when the workspace has nobody to e-mail, and says so once", async () => {
    state.db.members = [];
    state.db.users = state.db.users.map((user) => ({ ...user, email: null }));
    expect(await sendConnectionAlert(account())).toBe("no-recipients");
    expect(await sendConnectionAlert(account())).toBe("no-recipients");
    expect(warnings()).toHaveLength(1);
    expect(state.db.account().connectionAlertCount).toBe(0);
  });
});

describe("the e-mail through SMTP", () => {
  const SERVER = "smtps://login%40example.test:s3cret-pass@mail.example.test:465";

  beforeEach(() => {
    vi.stubEnv("EMAIL_SERVER", SERVER);
  });

  it("goes through the deployment's own mail server when it signs in with one", async () => {
    expect(await sendConnectionAlert(account())).toBe("sent");
    expect(resendCalls).toHaveLength(0);
    expect(smtp.createTransport).toHaveBeenCalledWith(SERVER);
    expect(smtp.sendMail).toHaveBeenCalledTimes(2);
    expect(smtp.sendMail).toHaveBeenNthCalledWith(1, {
      from: "OpenReply <alerts@example.test>",
      to: "owner@example.test",
      subject: "Instagram-Verbindung unterbrochen: OpenReply sendet gerade keine DMs",
      text: expect.stringContaining("Neu verbinden"),
      html: expect.stringContaining("Neu verbinden"),
      headers: { "Auto-Submitted": "auto-generated" },
    });
  });

  it("keeps the claim after the server refuses, and never logs the password", async () => {
    smtp.sendMail.mockRejectedValue(
      Object.assign(new Error(`Mailbox unavailable for ${SERVER} (s3cret-pass)`), { responseCode: 550 })
    );
    expect(await sendConnectionAlert(account())).toBe("failed");
    expect(state.db.account().connectionAlertCount).toBe(1);
    const warning = warnings().at(-1)!.message;
    expect(warning).toContain("SMTP");
    expect(warning).not.toContain("s3cret-pass");
    expect(warning).not.toContain("mail.example.test:465");
  });

  it("gives the claim back when the server cannot be reached", async () => {
    smtp.sendMail.mockRejectedValue(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
    expect(await sendConnectionAlert(account())).toBe("failed");
    expect(state.db.account().connectionAlertCount).toBe(0);
  });
});

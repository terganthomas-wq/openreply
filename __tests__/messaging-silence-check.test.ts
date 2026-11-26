/**
 * The messaging silence check (A2) in the worker: the two strikes, no
 * judgment during an A1 incident, an R1 pause or without a campaign whose DM
 * has a button, which DMs and events count, the end with one inbound event
 * (at the webhook route, or with the next check), and the e-mails by A1's
 * rules: the alert, one reminder after 24 hours, the alert at once after an
 * all-clear, the all-clear itself, the claim before the send.
 *
 * The rows are an in-memory stand-in that evaluates the conditional updates
 * (helpers/fake-connection-db.ts), Redis (the R1 pause) one too, and the mail
 * transport records what it is given: nothing leaves the test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeConnectionDb, fakeAccount, fakeCampaign } from "./helpers/fake-connection-db";
import { FakeRedis } from "./helpers/fake-redis";

const state = vi.hoisted(() => ({
  db: null as unknown as import("./helpers/fake-connection-db").FakeConnectionDb,
  redis: null as unknown,
}));

vi.mock("@/lib/db/client", () => ({
  get prisma() {
    return state.db.prisma;
  },
}));
vi.mock("@/lib/queue/client", () => ({
  getRedisConnection: () => state.redis,
  getDMQueue: () => ({ add: vi.fn() }),
  CATCH_UP_JOB_NAME: "process-catch-up",
}));

import {
  checkMessagingSilences,
  resetMessagingSilenceWarnings,
} from "../lib/instagram/messaging-silence-check";
import { endMessagingSilencesFor } from "../lib/instagram/messaging-silence-state";
import { connectionAlertDue } from "../lib/ops/connection-alert";
import type { MailMessage, MailResult, MailTransport } from "../lib/ops/mail";
import { resetMailWarnings } from "../lib/ops/mail";
import {
  messagingAlertDue,
  resetMessagingSilenceMailWarnings,
  sendMessagingSilenceAllClear,
} from "../lib/ops/messaging-silence-alert";

const IG = "ig_1";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const INTERVAL = 30 * MINUTE;
const at = (iso: string) => new Date(iso);
// 2026-11-25/26: the last DM from a person, then opening DMs to three people
// after the A1 reconnect, and the first silent check twelve hours later.
const LAST_INBOUND = at("2026-11-25T13:15:16.000Z");
const FIRST_CHECK = Date.parse("2026-11-26T09:00:00.000Z");
const SECOND_CHECK = FIRST_CHECK + INTERVAL;
const FORMAL = /\b(?:Sie|Ihnen|Ihr|Ihre[mnrs]?)\b/;
const ENV = { DEFAULT_LOCALE: "de", NEXTAUTH_URL: "https://dm.example.test" };

let sequence = 0;
let sent: MailMessage[];
let mailAnswer: (to: string) => MailResult;
const transport: MailTransport = {
  name: "resend",
  async send(message) {
    sent.push(message);
    return mailAnswer(message.to);
  },
};

type Kind = "postback" | "message" | "read" | "reaction" | "echo" | "comment" | "standby";

// A webhook as the route stores it, for the account or another one.
function payload(kind: Kind, person = "p0", account = IG) {
  const mid = `mid_${++sequence}`;
  const from = { sender: { id: person }, recipient: { id: account }, timestamp: 1 };
  const item =
    kind === "postback"
      ? { ...from, postback: { mid, title: "Ja, schick ihn mir", payload: "reveal:campaign_1:open" } }
      : kind === "message"
        ? { ...from, message: { mid, text: "Danke!" } }
        : kind === "read" || kind === "standby"
          ? { ...from, read: { mid } }
          : kind === "reaction"
            ? { ...from, reaction: { mid, action: "react", emoji: "❤️" } }
            : kind === "echo"
              ? { sender: { id: account }, recipient: { id: person }, timestamp: 1, message: { mid, text: "Hier ist dein Guide", is_echo: true } }
              : null;
  return {
    object: "instagram",
    entry: [
      kind === "comment"
        ? {
            id: account,
            time: 1,
            changes: [
              {
                field: "comments",
                value: { id: `c_${sequence}`, text: "Guide", from: { id: person }, media: { id: "m_1" } },
              },
            ],
          }
        : kind === "standby"
          ? { id: account, time: 1, standby: [item] }
          : { id: account, time: 1, messaging: [item] },
    ],
  };
}

function inbound(when: Date, kind: Kind, person = "p0", account = IG) {
  state.db.webhookEvents.push({
    id: `we_${String(++sequence).padStart(4, "0")}`,
    createdAt: when,
    payload: payload(kind, person, account),
  });
}

function openingDm(person: string, iso: string, overrides: Record<string, unknown> = {}) {
  state.db.dmLogs.push({
    instagramAccountId: "account_1",
    automationId: "campaign_1",
    commentId: `comment_${++sequence}`,
    commenterId: person,
    status: "SENT",
    dmSentAt: at(iso),
    ...overrides,
  });
}

async function check(now: number, options: { env?: Record<string, string>; transport?: MailTransport | null } = {}) {
  vi.setSystemTime(now);
  return checkMessagingSilences({
    intervalMs: INTERVAL,
    clock: () => now,
    env: options.env ?? ENV,
    transport: options.transport === undefined ? transport : options.transport,
  });
}

function account() {
  return state.db.account();
}

function events(kind: string) {
  return state.db.events.filter((event) => event.payload?.kind === kind);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIRST_CHECK);
  state.redis = new FakeRedis();
  state.db = new FakeConnectionDb();
  state.db.accounts.push(fakeAccount());
  state.db.users.push(
    { id: "u_owner", email: "owner@example.test" },
    { id: "u_admin", email: "admin@example.test" },
    { id: "u_member", email: "member@example.test" }
  );
  state.db.workspaces.push({ id: "workspace_1", ownerId: "u_owner" });
  state.db.members.push(
    { workspaceId: "workspace_1", userId: "u_owner", role: "OWNER", createdAt: at("2026-11-01T00:00:00Z") },
    { workspaceId: "workspace_1", userId: "u_admin", role: "ADMIN", createdAt: at("2026-11-02T00:00:00Z") },
    { workspaceId: "workspace_1", userId: "u_member", role: "MEMBER", createdAt: at("2026-11-03T00:00:00Z") }
  );
  state.db.campaigns.push(
    fakeCampaign({
      openingDmEnabled: true,
      openingDmMessage: "Hey, willst du den Guide?",
      openingDmButtonLabel: "Ja, schick ihn mir",
    })
  );
  inbound(LAST_INBOUND, "message", "p0");
  openingDm("p1", "2026-11-25T20:49:23Z");
  openingDm("p2", "2026-11-25T20:49:24Z");
  openingDm("p3", "2026-11-25T20:51:36Z");
  sent = [];
  mailAnswer = () => ({ ok: true });
  resetMailWarnings();
  resetMessagingSilenceMailWarnings();
  resetMessagingSilenceWarnings();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("two silent checks", () => {
  it("open an incident since the last inbound event and e-mail the owners and admins", async () => {
    expect((await check(FIRST_CHECK)).outcomes).toEqual({ strike: 1 });
    expect(account()).toMatchObject({
      messagingSilenceCheckAt: new Date(FIRST_CHECK),
      messagingSilentSince: null,
    });
    expect(sent).toHaveLength(0);

    expect((await check(SECOND_CHECK)).outcomes).toEqual({ opened: 1 });
    expect(account()).toMatchObject({
      messagingSilentSince: LAST_INBOUND,
      messagingAlertCount: 1,
      messagingAlertSentAt: new Date(SECOND_CHECK),
    });
    expect(sent.map((message) => message.to).sort()).toEqual([
      "admin@example.test",
      "owner@example.test",
    ]);
    const [opened] = events("messaging-silent");
    expect(opened).toMatchObject({ level: "WARNING", workspaceId: "workspace_1" });
    expect(opened.payload).toMatchObject({
      account: "thomas.tergan",
      since: LAST_INBOUND.toISOString(),
      firstDmAt: "2026-11-25T20:49:23.000Z",
      people: 3,
    });
    expect(events("messaging-alert")[0].payload).toMatchObject({ recipients: 2, reminder: false });

    // The next sweep sends nothing more.
    expect((await check(SECOND_CHECK + INTERVAL)).outcomes).toEqual({ silent: 1 });
    expect(sent).toHaveLength(2);
  });

  it("are at least one interval apart: a sweep right after a restart does not open it", async () => {
    await check(FIRST_CHECK);
    expect((await check(FIRST_CHECK + 10 * MINUTE)).outcomes).toEqual({ strike: 1 });
    expect(account().messagingSilentSince).toBeNull();
    // A tenth of the interval early still counts, as for A1.
    expect((await check(FIRST_CHECK + 27 * MINUTE)).outcomes).toEqual({ opened: 1 });
  });

  it("are in a row: a check that is not silent in between starts over", async () => {
    await check(FIRST_CHECK);
    inbound(at("2026-11-26T09:10:00Z"), "read", "p2");
    expect((await check(SECOND_CHECK)).outcomes).toEqual({ quiet: 1 });
    expect(account().messagingSilenceCheckAt).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it("need three different people, each with an opening DM at least 12 hours old", async () => {
    expect((await check(Date.parse("2026-11-26T08:51:00Z"))).outcomes).toEqual({ quiet: 1 });
    state.db.dmLogs.pop();
    openingDm("p1", "2026-11-25T20:51:36Z");
    expect((await check(FIRST_CHECK)).outcomes).toEqual({ quiet: 1 });
    expect(account().messagingSilenceCheckAt).toBeNull();
  });

  it("follow the thresholds the environment sets", async () => {
    state.db.dmLogs.pop();
    const env = { ...ENV, MESSAGING_SILENCE_MIN_PEOPLE: "2" };
    expect((await check(FIRST_CHECK, { env })).outcomes).toEqual({ strike: 1 });
    expect((await check(SECOND_CHECK, { env })).outcomes).toEqual({ opened: 1 });
  });

  it("say once per process which threshold was not taken as written", async () => {
    const env = { ...ENV, MESSAGING_SILENCE_MIN_PEOPLE: "1" };
    await check(FIRST_CHECK, { env });
    await check(SECOND_CHECK, { env });
    const warnings = state.db.events.filter((event) => event.message.startsWith("Messaging silence check:"));
    expect(warnings).toEqual([
      expect.objectContaining({
        workspaceId: null,
        level: "WARNING",
        message: "Messaging silence check: MESSAGING_SILENCE_MIN_PEOPLE=1 is outside 2 to 10: using 2",
      }),
    ]);
  });
});

describe("no judgment", () => {
  it("while the connection is lost (A1): no webhook arrives at all then", async () => {
    Object.assign(account(), { connectionLostAt: at("2026-11-26T08:30:00Z") });
    expect((await check(FIRST_CHECK)).outcomes).toEqual({ "connection-lost": 1 });
    expect((await check(SECOND_CHECK)).outcomes).toEqual({ "connection-lost": 1 });
    expect(account()).toMatchObject({ messagingSilenceCheckAt: null, messagingSilentSince: null });
  });

  it("while A1's check has seen the connection refused once and the next one decides", async () => {
    Object.assign(account(), { connectionCheckFailedAt: at("2026-11-26T08:55:00Z") });
    expect((await check(FIRST_CHECK)).outcomes).toEqual({ "connection-lost": 1 });
    expect(account().messagingSilenceCheckAt).toBeNull();
    Object.assign(account(), { connectionCheckFailedAt: null });
    expect((await check(SECOND_CHECK)).outcomes).toEqual({ strike: 1 });
  });

  it("for opening DMs sent before the lost connection was back", async () => {
    Object.assign(account(), { connectionRecoveredAt: at("2026-11-25T20:50:00Z") });
    expect((await check(FIRST_CHECK)).outcomes).toEqual({ quiet: 1 });
    Object.assign(account(), { connectionRecoveredAt: at("2026-11-25T20:39:00Z") });
    expect((await check(SECOND_CHECK)).outcomes).toEqual({ strike: 1 });
  });

  it("while the account is paused for a Meta limit (R1), keeping a first silent check", async () => {
    const redis = state.redis as FakeRedis;
    const pause = (until: number) =>
      redis.set(`meta:pause:${IG}`, String(until), "PX", until - Date.now());
    vi.setSystemTime(FIRST_CHECK);
    await pause(FIRST_CHECK + 20 * MINUTE);
    expect((await check(FIRST_CHECK)).outcomes).toEqual({ paused: 1 });
    expect(account().messagingSilenceCheckAt).toBeNull();

    await redis.del(`meta:pause:${IG}`);
    expect((await check(SECOND_CHECK)).outcomes).toEqual({ strike: 1 });
    await pause(SECOND_CHECK + 2 * HOUR);
    expect((await check(SECOND_CHECK + INTERVAL)).outcomes).toEqual({ paused: 1 });
    expect(account()).toMatchObject({
      messagingSilenceCheckAt: new Date(SECOND_CHECK),
      messagingSilentSince: null,
    });
    await redis.del(`meta:pause:${IG}`);
    expect((await check(SECOND_CHECK + 3 * HOUR)).outcomes).toEqual({ opened: 1 });
  });

  it("without an active campaign whose DM has a button", async () => {
    const campaign = state.db.campaigns[0];
    for (const change of [
      { isActive: false },
      { openingDmEnabled: false },
      { openingDmButtonLabel: "" },
      { openingDmMessage: null },
    ]) {
      Object.assign(campaign, {
        isActive: true,
        openingDmEnabled: true,
        openingDmMessage: "Hey, willst du den Guide?",
        openingDmButtonLabel: "Ja, schick ihn mir",
        ...change,
      });
      expect((await check(FIRST_CHECK)).outcomes, JSON.stringify(change)).toEqual({ "no-campaign": 1 });
    }
    expect(account().messagingSilenceCheckAt).toBeNull();
  });

  it("but a paused campaign's opening DMs count while another one with a button is active", async () => {
    state.db.campaigns[0].isActive = false;
    state.db.campaigns.push(
      fakeCampaign({
        id: "campaign_2",
        openingDmEnabled: true,
        openingDmMessage: "Magst du die Checkliste?",
        openingDmButtonLabel: "Ja, bitte",
      })
    );
    expect((await check(FIRST_CHECK)).outcomes).toEqual({ strike: 1 });
  });

  it("for accounts connected through Zernio", async () => {
    Object.assign(account(), { provider: "ZERNIO" });
    expect(await check(FIRST_CHECK)).toEqual({ accounts: 0, outcomes: {}, mailed: 0 });
  });
});

describe("what counts", () => {
  it("echoes and comment changes are no answer, an event in standby is", async () => {
    inbound(at("2026-11-26T06:00:00Z"), "echo", "p1");
    inbound(at("2026-11-26T07:00:00Z"), "comment", "p9");
    expect((await check(FIRST_CHECK)).outcomes).toEqual({ strike: 1 });
    inbound(at("2026-11-26T09:15:00Z"), "standby", "p1");
    expect((await check(SECOND_CHECK)).outcomes).toEqual({ quiet: 1 });
  });

  it("a reaction and a button tap are answers too, another account's events are not", async () => {
    inbound(at("2026-11-26T06:00:00Z"), "read", "p1", "ig_other");
    expect((await check(FIRST_CHECK)).outcomes).toEqual({ strike: 1 });
    inbound(at("2026-11-26T09:15:00Z"), "reaction", "p1");
    expect((await check(SECOND_CHECK)).outcomes).toEqual({ quiet: 1 });
    await check(SECOND_CHECK + 12 * HOUR);
    inbound(at("2026-11-26T22:00:00Z"), "postback", "p4");
  });

  it("only opening DMs: not the link a tap delivered, a DM keyword's answer or a DM that may not have arrived", async () => {
    state.db.dmLogs.length = 0;
    openingDm("p1", "2026-11-25T20:49:23Z", { commentId: "reveal:p1" });
    openingDm("p2", "2026-11-25T20:49:24Z", { commentId: "dm:mid_2" });
    openingDm("p3", "2026-11-25T20:50:00Z", { dmDeliveryUnconfirmed: true });
    openingDm("p4", "2026-11-25T20:50:30Z", { status: "FAILED" });
    openingDm("p5", "2026-11-25T20:51:00Z");
    openingDm("p6", "2026-11-25T20:51:30Z", { automationId: "campaign_without_button" });
    openingDm("p7", "2026-11-25T20:51:36Z");
    expect((await check(FIRST_CHECK)).outcomes).toEqual({ quiet: 1 });
    openingDm("p8", "2026-11-25T20:52:00Z");
    expect((await check(Date.parse("2026-11-26T09:10:00Z"))).outcomes).toEqual({ strike: 1 });
  });

  it("reads no webhook while too few people got an opening DM", async () => {
    state.db.dmLogs.pop();
    await check(FIRST_CHECK);
    expect(state.db.webhookReads).toHaveLength(0);
    openingDm("p3", "2026-11-25T20:51:36Z");
    await check(SECOND_CHECK);
    expect(state.db.webhookReads).toHaveLength(1);
  });
});

describe("the end of a silence", () => {
  async function open() {
    await check(FIRST_CHECK);
    await check(SECOND_CHECK);
    expect(account().messagingSilentSince).toEqual(LAST_INBOUND);
    sent = [];
  }

  it("comes with the next check once anything arrived, and the all-clear goes out with it", async () => {
    await open();
    inbound(at("2026-11-26T10:30:57Z"), "postback", "p1");
    const summary = await check(Date.parse("2026-11-26T11:00:00Z"));
    expect(summary).toMatchObject({ outcomes: { ended: 1 }, mailed: 1 });
    expect(account()).toMatchObject({
      messagingSilentSince: null,
      messagingSilenceCheckAt: null,
      messagingAlertCount: 0,
      messagingAllClearDueAt: null,
      messagingAllClearSentAt: at("2026-11-26T11:00:00Z"),
      messagingSilenceResult: {
        v: 1,
        since: LAST_INBOUND.toISOString(),
        endedAt: "2026-11-26T10:30:57.000Z",
        via: "check",
      },
    });
    expect(events("messaging-back")[0]).toMatchObject({ source: "WORKER", level: "INFO" });
    expect(sent.map((message) => message.subject)).toEqual([
      "Entwarnung: Instagram gibt wieder Button-Tipps an OpenReply weiter",
      "Entwarnung: Instagram gibt wieder Button-Tipps an OpenReply weiter",
    ]);
    expect(sent[0].text).toContain(
      "Die Störung dauerte etwa 21 Stunden und 15 Minuten: vom 25.11.2026 um 14:15 Uhr bis zum 26.11.2026 um 11:30 Uhr."
    );
    expect(sent[0].text).not.toMatch(FORMAL);
  });

  it("comes with the next check even while the account is paused or its connection is lost", async () => {
    await open();
    inbound(at("2026-11-26T10:30:57Z"), "read", "p2");
    Object.assign(account(), { connectionLostAt: at("2026-11-26T10:40:00Z") });
    expect((await check(Date.parse("2026-11-26T11:00:00Z"))).outcomes).toEqual({ ended: 1 });
    // Its all-clear would say something that is not true while the
    // connection is lost: dropped.
    expect(account().messagingAllClearDueAt).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it("never comes from DMs growing too old to count: the incident stays until something arrives", async () => {
    await open();
    expect((await check(Date.parse("2026-11-26T16:00:00Z"))).outcomes).toEqual({ silent: 1 });
    expect(account().messagingSilentSince).toEqual(LAST_INBOUND);
  });

  it("comes at once at the webhook route, which costs no query while nothing is open", async () => {
    await open();
    const row = { ...account() };
    const reads = () => state.db.updates.length;
    const before = reads();
    // An echo of the account's own DM is no answer.
    expect(await endMessagingSilencesFor(payload("echo") as never, [row], { at: at("2026-11-26T10:00:00Z") })).toBe(0);
    expect(reads()).toBe(before);
    expect(
      await endMessagingSilencesFor(payload("postback", "p1") as never, [row], { at: at("2026-11-26T10:30:57Z") })
    ).toBe(1);
    expect(account()).toMatchObject({
      messagingSilentSince: null,
      messagingAllClearDueAt: at("2026-11-26T10:30:57Z"),
      messagingSilenceResult: { via: "webhook", endedAt: "2026-11-26T10:30:57.000Z" },
    });
    expect(events("messaging-back")[0]).toMatchObject({ source: "SYSTEM" });
    // Nothing open any more: no write at all.
    const quiet = { ...account() };
    const after = reads();
    expect(await endMessagingSilencesFor(payload("read", "p2") as never, [quiet])).toBe(0);
    expect(reads()).toBe(after);
    // The next sweep sends the all-clear.
    expect((await check(Date.parse("2026-11-26T11:00:00Z"))).mailed).toBe(1);
  });

  it("forgets a first silent check at the webhook route too", async () => {
    await check(FIRST_CHECK);
    await endMessagingSilencesFor(payload("read", "p1") as never, [{ ...account() }]);
    expect(account().messagingSilenceCheckAt).toBeNull();
    expect(events("messaging-back")).toHaveLength(0);
  });
});

describe("the e-mails, by A1's rules", () => {
  it("follow the same warning rule as A1's", () => {
    const now = SECOND_CHECK;
    const states = [
      { since: null, sentAt: null, count: 0 },
      { since: LAST_INBOUND, sentAt: null, count: 0 },
      { since: LAST_INBOUND, sentAt: new Date(now - HOUR), count: 1 },
      { since: LAST_INBOUND, sentAt: new Date(now - 25 * HOUR), count: 1 },
      { since: LAST_INBOUND, sentAt: new Date(now - 25 * HOUR), count: 2 },
      { since: LAST_INBOUND, sentAt: new Date(now - HOUR), count: 0 },
      { since: LAST_INBOUND, sentAt: new Date(now - 2 * HOUR), count: 0, allClearAt: new Date(now - HOUR) },
      {
        since: LAST_INBOUND,
        sentAt: new Date(now - 2 * HOUR),
        count: 0,
        allClearAt: new Date(now - HOUR),
        rearmedAt: new Date(now - 3 * HOUR),
      },
    ];
    const expected = [null, "alert", null, "reminder", null, null, "alert", null];
    states.forEach((s, index) => {
      const silence = messagingAlertDue(
        {
          id: "a",
          workspaceId: "w",
          username: "u",
          messagingSilentSince: s.since,
          messagingAlertSentAt: s.sentAt,
          messagingAlertCount: s.count,
          messagingAllClearSentAt: s.allClearAt ?? null,
          messagingAlertRearmedAt: s.rearmedAt ?? null,
        },
        now
      );
      const connection = connectionAlertDue(
        {
          connectionLostAt: s.since,
          connectionAlertSentAt: s.sentAt,
          connectionAlertCount: s.count,
          connectionAllClearSentAt: s.allClearAt ?? null,
          connectionAlertRearmedAt: s.rearmedAt ?? null,
        },
        now
      );
      expect(silence, `state ${index}`).toBe(expected[index]);
      expect(silence, `state ${index}`).toBe(connection);
    });
  });

  it("send the reminder 24 hours after the alert, and nothing after it", async () => {
    await check(FIRST_CHECK);
    await check(SECOND_CHECK);
    await check(SECOND_CHECK + 12 * HOUR);
    expect(sent).toHaveLength(2);
    await check(SECOND_CHECK + 24 * HOUR);
    expect(sent).toHaveLength(4);
    expect(sent[2].subject).toBe(
      "Erinnerung: Instagram gibt noch immer keine Button-Tipps an OpenReply weiter"
    );
    expect(sent[2].text).toContain("Das ist die Erinnerung: Seit über 24 Stunden ist nichts davon angekommen.");
    expect(events("messaging-alert").at(-1)?.payload).toMatchObject({ reminder: true });
    await check(SECOND_CHECK + 72 * HOUR);
    expect(sent).toHaveLength(4);
  });

  it("alert at once for a silence after an all-clear, once in 24 hours", async () => {
    Object.assign(account(), {
      messagingAlertSentAt: new Date(FIRST_CHECK - 3 * HOUR),
      messagingAllClearSentAt: new Date(FIRST_CHECK - HOUR),
    });
    await check(FIRST_CHECK);
    await check(SECOND_CHECK);
    expect(sent).toHaveLength(2);
    expect(account()).toMatchObject({
      messagingAlertRearmedAt: new Date(SECOND_CHECK),
      messagingAlertSentAt: new Date(SECOND_CHECK),
    });
  });

  it("are not held up by a warning about the lost connection: each kind has its 24 hours", async () => {
    Object.assign(account(), { connectionAlertSentAt: new Date(FIRST_CHECK - HOUR), connectionAlertCount: 0 });
    await check(FIRST_CHECK);
    await check(SECOND_CHECK);
    expect(sent).toHaveLength(2);
  });

  it("go out once per person when two checks open the incident at the same moment", async () => {
    await check(FIRST_CHECK);
    vi.setSystemTime(SECOND_CHECK);
    const options = { intervalMs: INTERVAL, clock: () => SECOND_CHECK, env: ENV, transport };
    const results = await Promise.all([checkMessagingSilences(options), checkMessagingSilences(options)]);
    expect(results.map((result) => Object.keys(result.outcomes)[0]).sort()).toEqual(["inconclusive", "opened"]);
    expect(sent).toHaveLength(2);
    expect(events("messaging-silent")).toHaveLength(1);
  });

  it("are given back when nobody got an answer, and the next check sends them with the same keys", async () => {
    mailAnswer = () => ({ ok: false, transient: true, error: "Resend 503: unavailable" });
    await check(FIRST_CHECK);
    await check(SECOND_CHECK);
    expect(account()).toMatchObject({ messagingAlertCount: 0, messagingAlertSentAt: null });
    const keys = sent.map((message) => message.idempotencyKey);
    mailAnswer = () => ({ ok: true });
    await check(SECOND_CHECK + INTERVAL);
    expect(sent.slice(2).map((message) => message.idempotencyKey)).toEqual(keys);
    expect(account().messagingAlertCount).toBe(1);
  });

  it("without e-mail settings: one warning per process, nothing claimed, sent once they are there", async () => {
    await check(FIRST_CHECK, { transport: null });
    await check(SECOND_CHECK, { transport: null });
    await check(SECOND_CHECK + INTERVAL, { transport: null });
    expect(events("mail-unconfigured")).toHaveLength(1);
    expect(account()).toMatchObject({ messagingSilentSince: LAST_INBOUND, messagingAlertCount: 0 });
    await check(SECOND_CHECK + 2 * INTERVAL);
    expect(sent).toHaveLength(2);
  });

  it("say what is wrong, the likely causes and the fix with the link, in German with du", async () => {
    await check(FIRST_CHECK);
    await check(SECOND_CHECK);
    const { subject, text, html } = sent[0];
    expect(subject).toBe("Instagram gibt keine Button-Tipps weiter: Nach der ersten DM passiert nichts");
    for (const line of [
      "Instagram gibt gerade keine Button-Tipps, DMs und Lesebestätigungen an OpenReply weiter. Kommentare kommen an, aber nach der ersten DM passiert nichts.",
      "Seit dem 25.11.2026 um 14:15 Uhr ist für dein Instagram-Konto @thomas.tergan nichts davon angekommen, obwohl seitdem mehrere Leute deine erste DM bekommen haben.",
      "- Instagram wurde mit einer Facebook-Seite verknüpft oder davon getrennt. Dann beim Neu verbinden die Seite mit auswählen.",
      "- In Instagram ist „Zugriff auf Nachrichten erlauben“ ausgeschaltet.",
      "- In der Meta Business Suite ist unter „Weiterleiten von Unterhaltungen“ eine andere App als Standard für Instagram eingetragen.",
      "1. Öffne die Einstellungen von OpenReply: https://dm.example.test/settings",
      "2. Tippe auf „Neu verbinden“ und melde dich bei Meta an.",
    ]) {
      expect(text).toContain(line);
    }
    expect(html).toContain('href="https://dm.example.test/settings"');
    expect(`${subject}\n${text}`).not.toMatch(FORMAL);
    // No id, no tracking.
    expect(text).not.toContain("account_1");
    expect(html).not.toContain("<img");
  });

  it("are in English with UTC for every other locale", async () => {
    await check(FIRST_CHECK, { env: { NEXTAUTH_URL: "https://dm.example.test" } });
    await check(SECOND_CHECK, { env: { NEXTAUTH_URL: "https://dm.example.test" } });
    expect(sent[0].subject).toBe("Instagram is not passing on button taps: nothing happens after the first DM");
    expect(sent[0].text).toContain(
      "Since 25 November 2026, 13:15 UTC none of them has arrived for your Instagram account @thomas.tergan"
    );
    expect(sent[0].text).toContain("under “Conversation routing”");
  });

  it("drop an all-clear when the silence is back, the connection is lost, or after 24 hours", async () => {
    const result = {
      v: 1,
      since: LAST_INBOUND.toISOString(),
      endedAt: "2026-11-26T10:30:57.000Z",
      via: "webhook",
    };
    const due = at("2026-11-26T10:30:57Z");
    for (const [change, now] of [
      [{ messagingSilentSince: at("2026-11-26T11:00:00Z") }, Date.parse("2026-11-26T11:00:00Z")],
      [{ connectionLostAt: at("2026-11-26T10:45:00Z") }, Date.parse("2026-11-26T11:00:00Z")],
      [{}, due.getTime() + 25 * HOUR],
      [{ messagingSilenceResult: { v: 2 } }, Date.parse("2026-11-26T11:00:00Z")],
    ] as const) {
      Object.assign(
        account(),
        {
          messagingSilentSince: null,
          connectionLostAt: null,
          messagingSilenceResult: result,
          messagingAllClearDueAt: due,
        },
        change
      );
      expect(await sendMessagingSilenceAllClear("account_1", { now, transport, env: ENV })).toBe("dropped");
      expect(account().messagingAllClearDueAt).toBeNull();
    }
    expect(sent).toHaveLength(0);
  });
});

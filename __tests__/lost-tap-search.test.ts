/**
 * The search for lost taps after a messaging silence (A2 requirement 4):
 * whom it looks at (an opening DM in the silence, no tap or link on record
 * since, at most 50, the newest first), how it finds their conversations
 * (the list, newest first, by participant id) and reads them (only those that
 * changed after the opening DM), what it continues (exactly the postback job
 * the tap would have produced, the oldest tap first, paced, while the 24-hour
 * window leaves an hour) and lists, Meta's limits with saved progress, once
 * per silence also across restarts and runs at once, and the end with the
 * all-clear e-mail. Also the stand-back of a lost tap's job
 * (lib/instagram/lost-tap-records.ts), and the production silence of
 * 2026-11-25/26 from the calibration timeline.
 *
 * Meta and the mail transport are answered here, never called; Redis (the
 * R1 pause, the pace) is an in-memory stand-in, the queue takes each job id
 * once as BullMQ does, and the account rows evaluate their conditional
 * updates (helpers/fake-connection-db.ts).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeConnectionDb, fakeAccount, fakeCampaign } from "./helpers/fake-connection-db";
import { FakeRedis } from "./helpers/fake-redis";

const state = vi.hoisted(() => ({
  db: null as unknown as import("./helpers/fake-connection-db").FakeConnectionDb,
  redis: null as unknown,
}));
const queue = vi.hoisted(() => ({
  adds: [] as { name: string; data: Record<string, unknown>; opts: Record<string, unknown> }[],
  ids: new Set<string>(),
}));

vi.mock("@/lib/db/client", () => ({
  get prisma() {
    return state.db.prisma;
  },
}));
vi.mock("@/lib/queue/client", () => ({
  getRedisConnection: () => state.redis,
  getDMQueue: () => ({
    // BullMQ takes a job id once while it holds the job.
    add: async (name: string, data: Record<string, unknown>, opts: Record<string, unknown> = {}) => {
      queue.adds.push({ name, data, opts });
      const id = opts.jobId as string | undefined;
      if (id && queue.ids.has(id)) return { id, duplicate: true };
      if (id) queue.ids.add(id);
      return { id };
    },
  }),
  CATCH_UP_JOB_NAME: "process-catch-up",
  COMMENT_JOB_NAME: "process-comment",
  POSTBACK_JOB_NAME: "process-postback",
  LOST_TAP_SEARCH_JOB_NAME: "process-lost-taps",
}));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: () => "local-test-token" }));

import { lostTapAnswered } from "../lib/instagram/lost-tap-records";
import {
  lostTapJobId,
  resetLostTapSearches,
  resumeLostTapSearches,
  runLostTapSearch,
  stopLostTapSearches,
} from "../lib/instagram/lost-tap-search";
import {
  LOST_TAP_READ_GAP_MS,
  LOST_TAP_SPACING_MS,
  lostTapSearchJobId,
  readLostTapProgress,
  readLostTapResult,
} from "../lib/instagram/lost-tap-state";
import { readMessagingSilenceResult } from "../lib/instagram/messaging-silence-incident";
import { resetLatestMetaUsage } from "../lib/meta/usage";
import type { MailMessage, MailTransport } from "../lib/ops/mail";
import { resetMailWarnings } from "../lib/ops/mail";
import { resetMessagingSilenceMailWarnings } from "../lib/ops/messaging-silence-alert";
import { pausedRunAt } from "../lib/queue/account-pause";

const IG = "ig_1";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const FROM = new Date("2026-11-25T13:15:16.000Z");
const UNTIL = new Date("2026-11-26T10:30:57.000Z");
const NOW = Date.parse("2026-11-26T10:31:30.000Z");
const SEARCH_JOB = lostTapSearchJobId("account_1", FROM, UNTIL);
const ENV = { DEFAULT_LOCALE: "de", NEXTAUTH_URL: "https://dm.example.test" };
const FORMAL = /\b(?:Sie|Ihnen|Ihr|Ihre[mnrs]?)\b/;
const LABEL = "Ja, schick ihn mir";

interface FakeMessage {
  id: string;
  text: string;
  at: string;
  from: string;
}
interface FakeConversation {
  id: string;
  person: string;
  username: string;
  updated: string;
  /** Newest first, as Meta answers. */
  messages: FakeMessage[];
  /** Meta cannot give this entry with its participants (code 1). */
  broken?: boolean;
}

let conversations: FakeConversation[];
let metaCalls: { url: URL; at: number }[];
// Answers a Meta request first when it returns a Response.
let metaHook: (url: URL) => Response | null;
let metaHeaders: Record<string, string>;
let sent: MailMessage[];
let sequence: number;

const transport: MailTransport = {
  name: "resend",
  async send(message) {
    sent.push(message);
    return { ok: true };
  },
};

const metaTime = (iso: string) => new Date(iso).toISOString().replace(".000Z", "+0000");

function graphError(code: number, message = "Something went wrong", subcode?: number) {
  return new Response(
    JSON.stringify({
      error: { code, error_subcode: subcode, type: "OAuthException", message, fbtrace_id: "trace" },
    }),
    { status: 400, headers: { "Content-Type": "application/json" } }
  );
}

function answerMeta(url: URL): Response {
  const [, node, edge] = url.pathname.split("/").filter(Boolean);
  const headers = { "Content-Type": "application/json", ...metaHeaders };
  if (edge === "conversations") {
    expect(node).toBe(IG);
    expect(url.searchParams.get("platform")).toBe("instagram");
    const limit = Number(url.searchParams.get("limit"));
    const after = Number(url.searchParams.get("after") ?? 0);
    const withPeople = url.searchParams.get("fields")!.includes("participants");
    const sorted = [...conversations].sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated));
    const page = sorted.slice(after, after + limit);
    if (withPeople && page.some((conversation) => conversation.broken)) {
      return graphError(1, "Please reduce the amount of data you're asking for");
    }
    const next = after + limit < sorted.length ? String(after + limit) : null;
    return new Response(
      JSON.stringify({
        data: page.map((conversation) => ({
          id: conversation.id,
          updated_time: metaTime(conversation.updated),
          ...(withPeople
            ? {
                participants: {
                  data: [
                    { id: IG, username: "thomas.tergan" },
                    { id: conversation.person, username: conversation.username },
                  ],
                },
              }
            : {}),
        })),
        ...(next
          ? { paging: { cursors: { after: next }, next: `https://evil.example/${IG}/conversations?after=${next}` } }
          : {}),
      }),
      { headers }
    );
  }
  if (!edge) {
    const conversation = conversations.find((item) => item.id === node);
    if (!conversation) return graphError(100, "Object does not exist", 33);
    expect(url.searchParams.get("fields")).toBe("messages{id,created_time,from,to,message}");
    return new Response(
      JSON.stringify({
        id: conversation.id,
        messages: {
          data: conversation.messages.slice(0, 20).map((message) => ({
            id: message.id,
            created_time: metaTime(message.at),
            from: { id: message.from, username: message.from === IG ? "thomas.tergan" : conversation.username },
            to: { data: [{ id: message.from === IG ? conversation.person : IG }] },
            message: message.text,
          })),
        },
      }),
      { headers }
    );
  }
  throw new Error(`unexpected Meta request ${url.pathname}`);
}

function listReads() {
  return metaCalls.filter((call) => call.url.pathname.endsWith("/conversations"));
}
function messageReads() {
  return metaCalls.filter((call) => !call.url.pathname.endsWith("/conversations"));
}
/** The conversations whose messages were read, in order. */
function readConversations() {
  return messageReads().map((call) => call.url.pathname.split("/").at(-1));
}
function tapJobs() {
  return queue.adds.filter((add) => add.name === "process-postback");
}
function searchJobs() {
  return queue.adds.filter((add) => add.name === "process-lost-taps");
}
function account() {
  return state.db.account();
}
function progress() {
  return readLostTapProgress(account().messagingTapSearchProgress);
}
function taps() {
  return readLostTapResult(
    (account().messagingSilenceResult as Record<string, unknown> | null)?.taps
  );
}

/** An opening DM the account sent to the person in the silence. */
function openingDm(person: string, iso: string, overrides: Record<string, unknown> = {}) {
  state.db.dmLogs.push({
    instagramAccountId: "account_1",
    automationId: "c_guide",
    commentId: `comment_${++sequence}`,
    commenterId: person,
    commenterName: person.replace(/^p_/, ""),
    status: "SENT",
    dmSentAt: new Date(iso),
    ...overrides,
  });
}

/**
 * The person's conversation: the opening DM, and what they sent after it,
 * oldest first here; it changed last with the newest message.
 */
function conversation(
  person: string,
  openingAt: string,
  after: { text: string; at: string }[] = [],
  extra: Partial<FakeConversation> = {}
) {
  const messages: FakeMessage[] = [
    { id: `m_${++sequence}`, text: "Hey! Magst du den Guide?", at: openingAt, from: IG },
    ...after.map((message) => ({ id: `m_${++sequence}`, text: message.text, at: message.at, from: person })),
  ].reverse();
  conversations.push({
    id: `conv_${person}`,
    person,
    username: person.replace(/^p_/, ""),
    updated: messages[0].at,
    messages,
    ...extra,
  });
}

/** A tap that reached OpenReply: the webhook the route stored. */
function storedTap(person: string, iso: string, payload = "followcheck:c_guide:open", mid = `mid_${++sequence}`) {
  state.db.webhookEvents.push({
    id: `we_${String(++sequence).padStart(4, "0")}`,
    createdAt: new Date(iso),
    payload: {
      object: "instagram",
      entry: [
        {
          id: IG,
          time: 1,
          messaging: [
            { sender: { id: person }, recipient: { id: IG }, timestamp: 1, postback: { mid, title: LABEL, payload } },
          ],
        },
      ],
    },
  });
  return mid;
}

// Every sleep moves the clock on, as a real one would.
const sleeps: number[] = [];
async function sleep(ms: number) {
  sleeps.push(ms);
  vi.setSystemTime(Date.now() + ms);
}

function run(at: number = Date.now(), env: Record<string, string> = ENV) {
  vi.setSystemTime(at);
  return runLostTapSearch("account_1", { sleep, transport, env });
}

/** The four people of the silence and the one who tapped again after it. */
function silencePeople() {
  // Tapped in the silence: lost.
  openingDm("p_anna", "2026-11-25T20:49:23.000Z");
  conversation("p_anna", "2026-11-25T20:49:23.000Z", [{ text: LABEL, at: "2026-11-25T20:51:10.000Z" }]);
  // Got it, nothing else.
  openingDm("p_ben", "2026-11-25T20:49:24.000Z");
  conversation("p_ben", "2026-11-25T20:49:24.000Z");
  // Wrote something, did not tap.
  openingDm("p_cleo", "2026-11-25T20:51:36.000Z");
  conversation("p_cleo", "2026-11-25T20:51:36.000Z", [{ text: "Hallo?", at: "2026-11-25T21:30:00.000Z" }]);
  // Tapped at night: lost.
  openingDm("p_dora", "2026-11-26T04:51:55.000Z");
  conversation("p_dora", "2026-11-26T04:51:55.000Z", [{ text: LABEL, at: "2026-11-26T04:53:00.000Z" }]);
  // Tapped again once Instagram passed taps on: answered the ordinary way.
  openingDm("p_emil", "2026-11-26T10:04:10.000Z");
  conversation("p_emil", "2026-11-26T10:04:10.000Z", [
    { text: LABEL, at: "2026-11-26T10:10:00.000Z" },
    { text: LABEL, at: "2026-11-26T10:30:57.000Z" },
  ]);
  storedTap("p_emil", "2026-11-26T10:30:57.000Z");
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  state.redis = new FakeRedis();
  state.db = new FakeConnectionDb();
  // As the end of the silence leaves the row (lib/instagram/messaging-silence-state.ts).
  state.db.accounts.push(
    fakeAccount({
      instagramId: IG,
      messagingSilenceResult: {
        v: 1,
        since: FROM.toISOString(),
        endedAt: UNTIL.toISOString(),
        via: "webhook",
      },
      messagingTapSearchFrom: FROM,
      messagingTapSearchUntil: UNTIL,
    })
  );
  state.db.campaigns.push(
    fakeCampaign({
      id: "c_guide",
      name: "Guide Schimmel",
      openingDmEnabled: true,
      openingDmMessage: "Hey! Magst du den Guide?",
      openingDmButtonLabel: LABEL,
      requireFollow: true,
    })
  );
  state.db.users.push(
    { id: "u_owner", email: "owner@example.test" },
    { id: "u_admin", email: "admin@example.test" }
  );
  state.db.workspaces.push({ id: "workspace_1", ownerId: "u_owner" });
  state.db.members.push(
    { workspaceId: "workspace_1", userId: "u_owner", role: "OWNER", createdAt: new Date("2026-11-01T00:00:00Z") },
    { workspaceId: "workspace_1", userId: "u_admin", role: "ADMIN", createdAt: new Date("2026-11-02T00:00:00Z") }
  );
  conversations = [];
  metaCalls = [];
  metaHook = () => null;
  metaHeaders = {};
  sent = [];
  sequence = 0;
  sleeps.length = 0;
  queue.adds = [];
  queue.ids = new Set();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://graph.facebook.com");
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      expect(auth === "Bearer local-test-token" || url.searchParams.get("access_token") === "local-test-token").toBe(true);
      metaCalls.push({ url, at: Date.now() });
      return metaHook(url) ?? answerMeta(url);
    })
  );
  vi.stubEnv("META_GRAPH_API_VERSION", "v25.0");
  vi.stubEnv("META_THROTTLE_PAUSE_MINUTES", "");
  resetMailWarnings();
  resetMessagingSilenceMailWarnings();
  resetLatestMetaUsage();
  resetLostTapSearches();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("whom the search looks at", () => {
  it("everyone with an opening DM in the silence and no tap or link on record since, the newest first", async () => {
    silencePeople();
    expect(await run()).toBe("done");

    // One page of the list found everybody; Ben's conversation did not
    // change after his opening DM and is not read; Emil tapped again and
    // is left alone.
    expect(listReads()).toHaveLength(1);
    expect(readConversations()).toEqual(["conv_p_dora", "conv_p_cleo", "conv_p_anna"]);
    expect(taps()).toMatchObject({
      people: 5,
      continued: 2,
      listed: [],
      noTap: 2,
      answered: 1,
      notChecked: 0,
      reads: 4,
      complete: true,
    });
  });

  it("not opening DMs before the silence or after its end, the links a tap delivered, DM answers, or campaigns without a button", async () => {
    state.db.campaigns.push(fakeCampaign({ id: "c_plain", name: "Ohne Button" }));
    openingDm("p_before", "2026-11-25T13:15:16.000Z");
    openingDm("p_after", "2026-11-26T10:30:58.000Z");
    openingDm("p_reveal", "2026-11-25T21:00:00.000Z", { commentId: "reveal:p_reveal" });
    openingDm("p_dm", "2026-11-25T21:00:00.000Z", { commentId: "dm:mid_1" });
    openingDm("p_failed", "2026-11-25T21:00:00.000Z", { status: "FAILED" });
    openingDm("p_plain", "2026-11-25T21:00:00.000Z", { automationId: "c_plain" });
    openingDm("p_self", "2026-11-25T21:00:00.000Z", { commenterId: IG });
    openingDm("p_in", "2026-11-25T21:00:00.000Z");
    conversation("p_in", "2026-11-25T21:00:00.000Z");

    expect(await run()).toBe("done");
    expect(taps()).toMatchObject({ people: 1, noTap: 1, continued: 0, notChecked: 0 });
  });

  it("not a paused campaign's, unless the owner sent that person its DM by hand (M1)", async () => {
    state.db.campaigns[0].isActive = false;
    openingDm("p_auto", "2026-11-25T21:00:00.000Z");
    openingDm("p_manual", "2026-11-25T21:10:00.000Z", { matchedKeyword: "(manuell)" });
    conversation("p_manual", "2026-11-25T21:10:00.000Z", [{ text: LABEL, at: "2026-11-25T21:12:00.000Z" }]);

    expect(await run()).toBe("done");
    expect(readConversations()).toEqual(["conv_p_manual"]);
    expect(tapJobs().map((job) => job.data.userId)).toEqual(["p_manual"]);
    expect(taps()).toMatchObject({ people: 1, continued: 1 });
  });

  it("leaves alone whoever got a link, an answer to a DM keyword or a tap through after their opening DM", async () => {
    // A link that went out after the opening DM (here: a read fallback).
    openingDm("p_link", "2026-11-25T21:00:00.000Z");
    state.db.dmLogs.push({
      instagramAccountId: "account_1",
      automationId: "c_guide",
      commentId: "reveal:p_link",
      commenterId: "p_link",
      status: "SENT",
      dmSentAt: new Date("2026-11-26T10:35:00.000Z"),
    });
    // The campaign answered a DM keyword of theirs.
    openingDm("p_keyword", "2026-11-25T21:01:00.000Z");
    state.db.dmLogs.push({
      instagramAccountId: "account_1",
      automationId: "c_guide",
      commentId: "dm:mid_kw",
      commenterId: "p_keyword",
      status: "PENDING",
      updatedAt: new Date("2026-11-26T10:31:00.000Z"),
    });
    // A tap that arrived (a follow request leaves no row, only the webhook).
    openingDm("p_tap", "2026-11-25T21:02:00.000Z");
    storedTap("p_tap", "2026-11-26T10:31:05.000Z", "followcheck:c_guide:open");
    // Neither counts: a link from before the opening DM, another
    // campaign's tap, an offer's button.
    openingDm("p_old", "2026-11-25T21:03:00.000Z");
    state.db.dmLogs.push({
      instagramAccountId: "account_1",
      automationId: "c_guide",
      commentId: "reveal:p_old",
      commenterId: "p_old",
      status: "SENT",
      dmSentAt: new Date("2026-11-20T10:00:00.000Z"),
    });
    storedTap("p_old", "2026-11-26T10:31:10.000Z", "reveal:c_other:open");
    storedTap("p_old", "2026-11-26T10:31:11.000Z", "offer:o1:yes");
    conversation("p_old", "2026-11-25T21:03:00.000Z");

    expect(await run()).toBe("done");
    expect(taps()).toMatchObject({ people: 4, answered: 3, noTap: 1 });
    expect(readConversations()).toEqual([]);
  });

  it("is at most 50 people, the newest opening DMs first; the others are not checked", async () => {
    for (let n = 0; n < 60; n += 1) {
      const at = new Date(Date.parse("2026-11-25T21:00:00.000Z") + n * MINUTE).toISOString();
      openingDm(`p_${String(n).padStart(2, "0")}`, at);
      conversation(`p_${String(n).padStart(2, "0")}`, at, [{ text: "Hi", at: new Date(Date.parse(at) + 30_000).toISOString() }]);
    }
    expect(await run()).toBe("done");
    expect(readConversations()).toHaveLength(50);
    expect(readConversations()[0]).toBe("conv_p_59");
    expect(readConversations().at(-1)).toBe("conv_p_10");
    expect(taps()).toMatchObject({ people: 60, noTap: 50, notChecked: 10, complete: false });
  });
});

describe("their conversations", () => {
  it("are found in the list by participant id, newest first, a page at a time until everybody is", async () => {
    openingDm("p_old", "2026-11-25T14:00:00.000Z");
    conversation("p_old", "2026-11-25T14:00:00.000Z", [{ text: LABEL, at: "2026-11-25T14:01:00.000Z" }]);
    // 60 newer conversations of other people, which nobody looks for.
    for (let n = 0; n < 60; n += 1) {
      conversation(`p_x${n}`, new Date(Date.parse("2026-11-26T09:00:00.000Z") + n * MINUTE).toISOString());
    }
    expect(await run()).toBe("done");
    expect(listReads().map((call) => call.url.searchParams.get("after"))).toEqual([null, "50"]);
    // Our own host, never Meta's next link.
    expect(listReads().every((call) => call.url.origin === "https://graph.facebook.com")).toBe(true);
    expect(readConversations()).toEqual(["conv_p_old"]);
    expect(taps()).toMatchObject({ continued: 1 });
  });

  it("stop once the list reaches back before the oldest opening DM still wanted: whoever is not in it did not tap", async () => {
    // No conversation of Fritz changed after his opening DM: not in the
    // newest part of the list.
    openingDm("p_fritz", "2026-11-25T20:00:00.000Z");
    for (let n = 0; n < 60; n += 1) {
      conversation(`p_x${n}`, new Date(Date.parse("2026-11-25T19:59:00.000Z") - n * MINUTE).toISOString());
    }
    expect(await run()).toBe("done");
    expect(listReads()).toHaveLength(1);
    expect(taps()).toMatchObject({ noTap: 1, notChecked: 0, complete: true });
  });

  it("are not read when they did not change after the opening DM", async () => {
    openingDm("p_quiet", "2026-11-25T21:00:00.000Z");
    // The opening DM's own message is a second older than the time its row
    // was written.
    conversation("p_quiet", "2026-11-25T20:59:59.000Z");
    expect(await run()).toBe("done");
    expect(messageReads()).toHaveLength(0);
    expect(taps()).toMatchObject({ noTap: 1 });
  });

  it("are read in at most 10 pages of the list; whoever is not found is not checked", async () => {
    openingDm("p_far", "2026-11-25T14:00:00.000Z");
    for (let n = 0; n < 600; n += 1) {
      conversation(`p_x${n}`, new Date(Date.parse("2026-11-26T10:30:00.000Z") - n * 1_000).toISOString());
    }
    expect(await run()).toBe("done");
    expect(listReads()).toHaveLength(10);
    expect(taps()).toMatchObject({ notChecked: 1, complete: false });
  });

  it("step over an entry Meta cannot give with its participants (code 1), and then count whoever is not found as not checked", async () => {
    openingDm("p_found", "2026-11-25T21:00:00.000Z");
    conversation("p_found", "2026-11-25T21:00:00.000Z", [{ text: LABEL, at: "2026-11-25T21:01:00.000Z" }]);
    openingDm("p_hidden", "2026-11-25T21:05:00.000Z");
    conversation("p_hidden", "2026-11-25T21:05:00.000Z", [{ text: "Hi", at: "2026-11-25T21:20:00.000Z" }], {
      broken: true,
    });
    expect(await run()).toBe("done");
    const limits = listReads().map((call) => [
      call.url.searchParams.get("limit"),
      call.url.searchParams.get("fields"),
    ]);
    // Halved until the broken entry is alone, then read without its
    // participants and stepped over.
    expect(limits.slice(0, 7)).toEqual([
      ["50", "id,updated_time,participants"],
      ["25", "id,updated_time,participants"],
      ["12", "id,updated_time,participants"],
      ["6", "id,updated_time,participants"],
      ["3", "id,updated_time,participants"],
      ["1", "id,updated_time,participants"],
      ["1", "id,updated_time"],
    ]);
    expect(readConversations()).toEqual(["conv_p_found"]);
    expect(taps()).toMatchObject({ continued: 1, notChecked: 1, complete: false });
  });

  it("that cannot be read are not checked; three refusals in a row stop the run, and those people are read later", async () => {
    for (const [person, at] of [
      ["p_a", "2026-11-25T21:04:00.000Z"],
      ["p_b", "2026-11-25T21:03:00.000Z"],
      ["p_c", "2026-11-25T21:02:00.000Z"],
      ["p_d", "2026-11-25T21:01:00.000Z"],
    ] as const) {
      openingDm(person, at);
      conversation(person, at, [{ text: LABEL, at: new Date(Date.parse(at) + MINUTE).toISOString() }]);
    }
    // A 5xx for one conversation: that one only.
    metaHook = (url) => (url.pathname.endsWith("/conv_p_a") ? new Response("upstream", { status: 502 }) : null);
    expect(await run()).toBe("done");
    expect(taps()).toMatchObject({ continued: 3, notChecked: 1 });

    // Three refusals in a row: the account, not a conversation.
    Object.assign(account(), {
      messagingTapSearchFrom: FROM,
      messagingTapSearchUntil: UNTIL,
      messagingTapSearchProgress: null,
      messagingAllClearDueAt: null,
    });
    queue.ids = new Set();
    metaHook = (url) =>
      ["/conv_p_a", "/conv_p_b", "/conv_p_c"].some((end) => url.pathname.endsWith(end))
        ? graphError(10, "Application does not have permission for this action")
        : null;
    expect(await run()).toBe("stopped");
    expect(progress()?.people?.filter((person) => !person.done).map((person) => person.userId)).toEqual([
      "p_a",
      "p_b",
      "p_c",
      "p_d",
    ]);
    expect(progress()?.resumeAt).toBe(new Date(Date.now() + 30 * MINUTE).toISOString());
  });
});

describe("a lost tap", () => {
  it("is continued with exactly the postback job the tap would have produced", async () => {
    openingDm("p_anna", "2026-11-25T20:49:23.000Z");
    conversation("p_anna", "2026-11-25T20:49:23.000Z", [{ text: LABEL, at: "2026-11-25T20:51:10.000Z" }]);
    expect(await run()).toBe("done");
    const tapId = conversations[0].messages[0].id;
    expect(tapJobs()).toEqual([
      {
        name: "process-postback",
        data: {
          instagramAccountId: IG,
          accountConnectionId: "account_1",
          userId: "p_anna",
          // The opening DM's button of a campaign with the follow gate.
          payload: "followcheck:c_guide:open",
          mid: tapId,
          tappedAt: Date.parse("2026-11-25T20:51:10.000Z"),
          lostTap: true,
        },
        opts: { jobId: lostTapJobId(IG, "p_anna", tapId), delay: 0 },
      },
    ]);
    expect(lostTapJobId(IG, "p_anna", tapId)).toMatch(/^losttap_[0-9a-f]{40}$/);
    expect(lostTapJobId(IG, "p_anna", tapId)).toBe(lostTapJobId(IG, "p_anna", tapId));
    expect(lostTapJobId(IG, "p_anna", tapId)).not.toBe(lostTapJobId(IG, "p_ben", tapId));
  });

  it("without the follow gate brings the link, and a tap on a follow prompt's button its own postback", async () => {
    state.db.campaigns[0].requireFollow = false;
    state.db.campaigns.push(
      fakeCampaign({
        id: "c_gate",
        name: "Checkliste",
        openingDmEnabled: true,
        openingDmMessage: "Magst du die Checkliste?",
        openingDmButtonLabel: "Klar",
        requireFollow: true,
        followPromptButtonLabel: "Ich folge dir",
      })
    );
    openingDm("p_open", "2026-11-25T21:00:00.000Z");
    conversation("p_open", "2026-11-25T21:00:00.000Z", [{ text: LABEL, at: "2026-11-25T21:01:00.000Z" }]);
    openingDm("p_prompt", "2026-11-25T21:10:00.000Z", { automationId: "c_gate" });
    conversation("p_prompt", "2026-11-25T21:10:00.000Z", [{ text: "Ich folge dir", at: "2026-11-25T21:30:00.000Z" }]);
    expect(await run()).toBe("done");
    expect(tapJobs().map((job) => [job.data.userId, job.data.payload])).toEqual([
      ["p_open", "reveal:c_guide:open"],
      ["p_prompt", "followcheck:c_gate"],
    ]);
  });

  it("goes out the oldest first, the first right away and then one every 2.5 minutes in a pace of its own", async () => {
    silencePeople();
    expect(await run()).toBe("done");
    const finishedAt = Date.now();
    expect(tapJobs().map((job) => [job.data.userId, job.opts.delay])).toEqual([
      ["p_anna", 0],
      ["p_dora", LOST_TAP_SPACING_MS],
    ]);
    expect(taps()).toMatchObject({
      firstJobAt: new Date(finishedAt).toISOString(),
      lastJobAt: new Date(finishedAt + LOST_TAP_SPACING_MS).toISOString(),
    });
    expect(Number(await (state.redis as FakeRedis).get(`pace:taps:${IG}`))).toBe(finishedAt + LOST_TAP_SPACING_MS);
    // Not the catch-up's pace: a tap never waits behind hours of comments.
    expect(await (state.redis as FakeRedis).get(`pace:recovery:${IG}`)).toBeNull();
  });

  it("waits two minutes after a tap that fresh: its webhook may still be on its way", async () => {
    openingDm("p_late", "2026-11-26T10:00:00.000Z");
    conversation("p_late", "2026-11-26T10:00:00.000Z", [{ text: LABEL, at: "2026-11-26T10:30:50.000Z" }]);
    expect(await run()).toBe("done");
    const ranAt = Date.now();
    expect(tapJobs()[0].opts.delay).toBe(Date.parse("2026-11-26T10:32:50.000Z") - ranAt);
  });

  it("is listed, not continued, when Instagram's 24 hours from it leave less than an hour when its job runs", async () => {
    // A search that runs late (Meta's limits held it up): an hour and half a
    // minute are left for the first tap when its job runs right away; the
    // second came a minute later, but its slot is 2.5 minutes later, with
    // 59 minutes left. The third tap's window is closed.
    const runAt = Date.parse("2026-11-26T14:00:00.000Z");
    const first = runAt - 22 * HOUR - 59 * MINUTE - 30_000;
    const second = first + MINUTE;
    openingDm("p_first", new Date(first - MINUTE).toISOString(), { commenterName: "fine" });
    conversation("p_first", new Date(first - MINUTE).toISOString(), [{ text: LABEL, at: new Date(first).toISOString() }]);
    openingDm("p_second", new Date(second - MINUTE).toISOString(), { commenterName: "too_late" });
    conversation("p_second", new Date(second - MINUTE).toISOString(), [{ text: LABEL, at: new Date(second).toISOString() }]);
    openingDm("p_closed", "2026-11-25T13:20:00.000Z", { commenterName: "closed" });
    conversation("p_closed", "2026-11-25T13:20:00.000Z", [{ text: LABEL, at: "2026-11-25T13:21:00.000Z" }]);
    vi.setSystemTime(runAt);
    await runLostTapSearch("account_1", { sleep: async () => {}, transport, env: ENV });
    expect(Date.now()).toBe(runAt);
    // The oldest tap first: the closed one is listed and takes no slot,
    // the one with time left goes right away, the next would come too late.
    expect(tapJobs().map((job) => [job.data.userId, job.opts.delay])).toEqual([["p_first", 0]]);
    expect(taps()?.listed).toEqual([
      { username: "closed", campaign: "Guide Schimmel", tappedAt: "2026-11-25T13:21:00.000Z", reason: "window" },
      { username: "too_late", campaign: "Guide Schimmel", tappedAt: new Date(second).toISOString(), reason: "window" },
    ]);
  });

  it("is listed when its campaign stopped answering taps while the search ran", async () => {
    // A run that stopped after it found the tap, then the campaign was paused.
    Object.assign(account(), {
      messagingTapSearchProgress: {
        v: 1,
        from: FROM.toISOString(),
        until: UNTIL.toISOString(),
        startedAt: new Date(NOW - 20 * MINUTE).toISOString(),
        people: [
          {
            userId: "p_anna",
            username: "anna",
            campaigns: [{ automationId: "c_guide", openingDmAt: "2026-11-25T20:49:23.000Z" }],
            conversationId: "conv_p_anna",
            conversationUpdatedAt: "2026-11-25T20:51:10.000Z",
            done: true,
          },
        ],
        total: 1,
        answered: 0,
        list: { after: null, pageSize: 50, pages: 1, done: true, blind: false },
        reads: 2,
        found: [
          {
            userId: "p_anna",
            username: "anna",
            automationId: "c_guide",
            campaignName: "Guide Schimmel",
            openingDmAt: "2026-11-25T20:49:23.000Z",
            messageId: "m_anna",
            tappedAt: "2026-11-25T20:51:10.000Z",
            payload: "followcheck:c_guide:open",
          },
        ],
        continued: [],
        listed: [],
        noTap: 0,
        notChecked: 0,
        stops: 1,
        resumeAt: new Date(NOW - MINUTE).toISOString(),
        gaveUp: false,
      },
    });
    state.db.campaigns[0].isActive = false;
    expect(await run()).toBe("done");
    expect(metaCalls).toHaveLength(0);
    expect(tapJobs()).toHaveLength(0);
    expect(taps()?.listed).toEqual([
      { username: "anna", campaign: "Guide Schimmel", tappedAt: "2026-11-25T20:51:10.000Z", reason: "campaign" },
    ]);
  });

  it("is left to the ordinary way when the person's tap arrived while the search read", async () => {
    openingDm("p_anna", "2026-11-25T20:49:23.000Z");
    conversation("p_anna", "2026-11-25T20:49:23.000Z", [{ text: LABEL, at: "2026-11-25T20:51:10.000Z" }]);
    metaHook = (url) => {
      if (url.pathname.endsWith("/conv_p_anna")) storedTap("p_anna", new Date(Date.now()).toISOString());
      return null;
    };
    expect(await run()).toBe("done");
    expect(tapJobs()).toHaveLength(0);
    expect(taps()).toMatchObject({ continued: 0, answered: 1 });
  });
});

describe("Meta's limits and saved progress", () => {
  it("reads nothing while the account is paused (R1), and goes on after the pause", async () => {
    silencePeople();
    const resumeAt = NOW + 20 * MINUTE;
    await (state.redis as FakeRedis).set(`meta:pause:${IG}`, String(resumeAt), "PX", 20 * MINUTE);
    expect(await run()).toBe("paused");
    expect(metaCalls).toHaveLength(0);
    const wakeUp = pausedRunAt(resumeAt, SEARCH_JOB);
    expect(searchJobs().map((job) => job.opts.jobId)).toEqual([`${SEARCH_JOB}_${Math.floor(wakeUp)}`]);
    expect(progress()).toMatchObject({ resumeAt: new Date(wakeUp).toISOString(), stops: 1 });
    expect(progress()?.people).toHaveLength(4);
    expect(account().messagingTapSearchClaimedAt).toBeNull();
    // Too early: nothing happens.
    expect(await run(NOW + 5 * MINUTE)).toBe("waiting");
    // After the pause it goes on and ends.
    expect(await run(wakeUp)).toBe("done");
    expect(taps()).toMatchObject({ continued: 2, noTap: 2, answered: 1 });
  });

  it("stops while Meta reports 60 % of a limit and goes on 15 minutes later where it stopped, reading nobody twice", async () => {
    silencePeople();
    // The answers report 60 % of the app's limit from the second read on.
    metaHook = (url) => {
      if (url.pathname.endsWith("/conv_p_dora")) metaHeaders = { "x-app-usage": JSON.stringify({ call_count: 60 }) };
      return null;
    };
    expect(await run()).toBe("stopped");
    expect(readConversations()).toEqual(["conv_p_dora"]);
    const resumeAt = Date.now() + 15 * MINUTE;
    expect(progress()?.resumeAt).toBe(new Date(resumeAt).toISOString());
    expect(progress()?.found.map((tap) => tap.userId)).toEqual(["p_dora"]);
    expect(tapJobs()).toHaveLength(0);

    metaHeaders = {};
    metaHook = () => null;
    resetLatestMetaUsage();
    expect(await run(resumeAt)).toBe("done");
    expect(readConversations()).toEqual(["conv_p_dora", "conv_p_cleo", "conv_p_anna"]);
    expect(listReads()).toHaveLength(1);
    expect(tapJobs().map((job) => job.data.userId)).toEqual(["p_anna", "p_dora"]);
    expect(taps()).toMatchObject({ continued: 2, noTap: 2, reads: 4 });
  });

  it("stops for a request limit on a read and reads that person again after it", async () => {
    silencePeople();
    let limited = true;
    metaHook = (url) =>
      limited && url.pathname.endsWith("/conv_p_cleo")
        ? graphError(4, "Application request limit reached")
        : null;
    expect(await run()).toBe("stopped");
    const resumeAt = Date.parse(progress()!.resumeAt!);
    expect(resumeAt - Date.now()).toBe(20 * MINUTE);
    limited = false;
    expect(await run(resumeAt)).toBe("done");
    expect(readConversations()).toEqual(["conv_p_dora", "conv_p_cleo", "conv_p_cleo", "conv_p_anna"]);
    expect(taps()).toMatchObject({ continued: 2, noTap: 2 });
  });

  it("stops before its next read when the worker shuts down, and goes on a minute later", async () => {
    silencePeople();
    metaHook = (url) => {
      if (url.pathname.endsWith("/conversations")) stopLostTapSearches();
      return null;
    };
    expect(await run()).toBe("stopped");
    expect(messageReads()).toHaveLength(0);
    expect(progress()?.resumeAt).toBe(new Date(Date.now() + MINUTE).toISOString());
    resetLostTapSearches();
    metaHook = () => null;
    expect(await run(Date.now() + MINUTE)).toBe("done");
    expect(listReads()).toHaveLength(1);
  });

  it("keeps every read at least 2 seconds after the one before", async () => {
    silencePeople();
    expect(await run()).toBe("done");
    const times = metaCalls.map((call) => call.at);
    expect(times).toHaveLength(4);
    for (let n = 1; n < times.length; n += 1) {
      expect(times[n] - times[n - 1]).toBeGreaterThanOrEqual(2_000);
      expect(times[n] - times[n - 1]).toBe(LOST_TAP_READ_GAP_MS);
    }
  });
});

describe("once per silence", () => {
  it("a finished search does nothing more", async () => {
    silencePeople();
    expect(await run()).toBe("done");
    expect(account()).toMatchObject({
      messagingTapSearchFrom: null,
      messagingTapSearchUntil: null,
      messagingTapSearchClaimedAt: null,
      messagingTapSearchProgress: null,
    });
    const calls = metaCalls.length;
    expect(await run()).toBe("none");
    expect(metaCalls).toHaveLength(calls);
    expect(tapJobs()).toHaveLength(2);
  });

  it("two runs at once: one reads, the other stands back and looks again when the lease would run out", async () => {
    silencePeople();
    const [first, second] = await Promise.all([run(), runLostTapSearch("account_1", { sleep, transport, env: ENV })]);
    expect([first, second].sort()).toEqual(["busy", "done"]);
    expect(listReads()).toHaveLength(1);
    expect(tapJobs()).toHaveLength(2);
    expect(searchJobs()).toHaveLength(1);
  });

  it("takes over a run that died after 10 minutes, and continues no tap twice", async () => {
    // A run had read everybody and found Anna's and Dora's taps, and had
    // queued Anna's job when its worker died: its last checkpoint knows
    // both taps, neither continued, and its lease.
    const found = (person: string, tappedAt: string) => ({
      userId: person,
      username: person.replace(/^p_/, ""),
      automationId: "c_guide",
      campaignName: "Guide Schimmel",
      openingDmAt: "2026-11-25T20:49:23.000Z",
      messageId: `m_${person}`,
      tappedAt,
      payload: "followcheck:c_guide:open",
    });
    const leaseAt = NOW - 5 * MINUTE;
    Object.assign(account(), {
      messagingTapSearchClaimedAt: new Date(leaseAt),
      messagingTapSearchProgress: {
        v: 1,
        from: FROM.toISOString(),
        until: UNTIL.toISOString(),
        startedAt: new Date(NOW - 8 * MINUTE).toISOString(),
        people: [],
        total: 2,
        answered: 0,
        list: { after: null, pageSize: 50, pages: 1, done: true, blind: false },
        reads: 3,
        found: [found("p_dora", "2026-11-26T04:53:00.000Z"), found("p_anna", "2026-11-25T20:51:10.000Z")],
        continued: [],
        listed: [],
        noTap: 0,
        notChecked: 0,
        stops: 0,
        resumeAt: null,
        gaveUp: false,
      },
    });
    queue.ids.add(lostTapJobId(IG, "p_anna", "m_p_anna"));

    // Its lease still holds: this run stands back until it runs out.
    expect(await run()).toBe("busy");
    expect(searchJobs().map((job) => job.opts.jobId)).toEqual([
      `${SEARCH_JOB}_${leaseAt + 10 * MINUTE + 1_000}`,
    ]);
    expect(await run(leaseAt + 10 * MINUTE + 1_000)).toBe("done");
    expect(metaCalls).toHaveLength(0);
    // Anna's job again under its id, which BullMQ holds once; then Dora's.
    expect(tapJobs().map((job) => job.data.userId)).toEqual(["p_anna", "p_dora"]);
    expect(queue.ids.has(lostTapJobId(IG, "p_anna", "m_p_anna"))).toBe(true);
    expect([...queue.ids].filter((id) => id.startsWith("losttap_"))).toHaveLength(2);
    expect(taps()).toMatchObject({ continued: 2 });
  });

  it("searches one more silence that ends meanwhile with this one, from the earlier start", async () => {
    silencePeople();
    const later = new Date("2026-11-27T12:00:00.000Z");
    metaHook = (url) => {
      // While it reads, one more silence ends (lib/instagram/messaging-silence-state.ts).
      if (url.pathname.endsWith("/conv_p_cleo")) {
        Object.assign(account(), {
          messagingTapSearchUntil: later,
          messagingSilenceResult: {
            v: 1,
            since: "2026-11-27T00:00:00.000Z",
            endedAt: later.toISOString(),
            via: "check",
          },
        });
      }
      return null;
    };
    expect(await run()).toBe("superseded");
    // It gives the lease back and asks for the search of both silences.
    expect(account().messagingTapSearchClaimedAt).toBeNull();
    // Not before the gap after its last read.
    expect(searchJobs().map((job) => job.opts.jobId)).toEqual([
      `${lostTapSearchJobId("account_1", FROM, later)}_${Date.now() + LOST_TAP_READ_GAP_MS}`,
    ]);
    metaHook = () => null;
    expect(await run(Date.now() + LOST_TAP_READ_GAP_MS)).toBe("done");
    expect(taps()).toMatchObject({ continued: 2 });
    expect(new Set(tapJobs().map((job) => job.opts.jobId)).size).toBe(2);
    expect(readMessagingSilenceResult(account().messagingSilenceResult)).toMatchObject({
      since: "2026-11-27T00:00:00.000Z",
      endedAt: later.toISOString(),
    });
  });

  it("ends with what it has after 24 hours of trying", async () => {
    silencePeople();
    const resumeAt = NOW + 20 * MINUTE;
    await (state.redis as FakeRedis).set(`meta:pause:${IG}`, String(resumeAt), "PX", 25 * HOUR);
    expect(await run()).toBe("paused");
    await (state.redis as FakeRedis).del(`meta:pause:${IG}`);
    expect(await run(NOW + 24 * HOUR + MINUTE)).toBe("done");
    expect(metaCalls).toHaveLength(0);
    expect(taps()).toMatchObject({ gaveUp: true, notChecked: 4, complete: false });
  });

  it("reads nothing while the account's connection is lost (A1)", async () => {
    silencePeople();
    Object.assign(account(), { connectionLostAt: new Date(NOW - MINUTE) });
    expect(await run()).toBe("lost");
    expect(metaCalls).toHaveLength(0);
    expect(account().messagingTapSearchFrom).toEqual(FROM);
  });
});

describe("the end", () => {
  it("keeps the result with the silence, makes the all-clear due and sends it, in German with du", async () => {
    silencePeople();
    // One more, whose window is closed by the time the search runs: Meta's
    // limits held it up until 14:00 UTC.
    openingDm("p_gerd", "2026-11-25T13:20:00.000Z");
    conversation("p_gerd", "2026-11-25T13:20:00.000Z", [{ text: LABEL, at: "2026-11-25T13:21:00.000Z" }]);
    expect(await run(Date.parse("2026-11-26T14:00:00.000Z"))).toBe("done");
    const finishedAt = new Date(Date.now());
    expect(readMessagingSilenceResult(account().messagingSilenceResult)).toMatchObject({
      since: FROM.toISOString(),
      endedAt: UNTIL.toISOString(),
      via: "webhook",
      taps: { continued: 2, noTap: 2, answered: 1, people: 6 },
    });
    // Sent at once: claimed, then recorded as sent.
    expect(account()).toMatchObject({
      messagingAllClearDueAt: null,
      messagingAllClearSentAt: finishedAt,
    });
    expect(sent.map((message) => message.to).sort()).toEqual(["admin@example.test", "owner@example.test"]);
    const { subject, text, html } = sent[0];
    expect(subject).toBe("Entwarnung: Instagram gibt wieder Button-Tipps an OpenReply weiter");
    for (const line of [
      "Die Störung dauerte etwa 21 Stunden und 15 Minuten: vom 25.11.2026 um 14:15 Uhr bis zum 26.11.2026 um 11:30 Uhr.",
      "2 Leute haben in dieser Zeit auf den Button in deiner ersten DM getippt, ohne dass der Tipp ankam. OpenReply hat das in den Unterhaltungen gefunden und macht bei ihnen jetzt nach und nach weiter, als wäre der Tipp gleich angekommen, etwa bei einer Person alle 2,5 Minuten.",
      "Bei 1 Person ging das nicht mehr:",
      "- @gerd, Kampagne „Guide Schimmel“, getippt am 25.11.2026 um 14:21 Uhr: Instagram erlaubt eine Antwort nur bis 24 Stunden nach dem Tipp.",
      "Schreib ihnen am besten selbst in Instagram, damit sie bekommen, worum sie gebeten haben.",
      "Bei 1 Person ging es nach der Störung von selbst weiter, zum Beispiel weil sie noch einmal getippt hat.",
      "2 Leute haben in dieser Zeit deine erste DM bekommen, aber nicht auf den Button getippt.",
    ]) {
      expect(text).toContain(line);
    }
    expect(text).not.toContain("konnte OpenReply nicht nachsehen");
    expect(`${subject}\n${text}`).not.toMatch(FORMAL);
    expect(html).toContain("@gerd, Kampagne „Guide Schimmel“");
    // No id, no tracking.
    for (const id of ["account_1", "p_anna", "conv_", IG]) expect(text).not.toContain(id);
    expect(html).not.toContain("<img");

    const event = state.db.events.find((item) => item.payload?.kind === "messaging-tap-search");
    expect(event).toMatchObject({
      level: "INFO",
      payload: { account: "thomas.tergan", continued: 2, listed: 1, noTap: 2, notChecked: 0, reads: 5 },
    });
  });

  it("in English with UTC for every other locale, and says whom it could not look at", async () => {
    for (let n = 0; n < 52; n += 1) {
      const at = new Date(Date.parse("2026-11-25T21:00:00.000Z") + n * MINUTE).toISOString();
      openingDm(`p_${n}`, at);
      conversation(`p_${n}`, at);
    }
    expect(await run(NOW, { NEXTAUTH_URL: "https://dm.example.test" })).toBe("done");
    expect(sent[0].subject).toBe("All-clear: Instagram passes button taps on to OpenReply again");
    expect(sent[0].text).toContain("In the conversations OpenReply could look at, no button tap got lost in that time.");
    expect(sent[0].text).toContain("50 people got your first DM in that time but did not tap the button.");
    expect(sent[0].text).toContain("OpenReply could not look at the conversations of 2 people. Check them yourself in Instagram.");
    expect(state.db.events.find((item) => item.payload?.kind === "messaging-tap-search")?.level).toBe("WARNING");
  });
});

describe("the worker's sweep", () => {
  it("asks again for a search that is owed and neither running, waiting nor blocked by a lost connection", async () => {
    vi.setSystemTime(NOW);
    expect(await resumeLostTapSearches({ clock: () => NOW })).toEqual({ requested: 1 });
    expect(searchJobs().map((job) => job.opts.jobId)).toEqual([SEARCH_JOB]);

    // Running: a fresh lease.
    queue.adds = [];
    queue.ids = new Set();
    Object.assign(account(), { messagingTapSearchClaimedAt: new Date(NOW - MINUTE) });
    expect(await resumeLostTapSearches({ clock: () => NOW })).toEqual({ requested: 0 });
    // A lease 10 minutes old belongs to a worker that died.
    expect(await resumeLostTapSearches({ clock: () => NOW + 10 * MINUTE })).toEqual({ requested: 1 });

    // Waiting for its time, and five minutes past it.
    queue.adds = [];
    queue.ids = new Set();
    const resumeAt = NOW + 15 * MINUTE;
    Object.assign(account(), {
      messagingTapSearchClaimedAt: null,
      messagingTapSearchProgress: {
        v: 1,
        from: FROM.toISOString(),
        until: UNTIL.toISOString(),
        startedAt: new Date(NOW).toISOString(),
        resumeAt: new Date(resumeAt).toISOString(),
      },
    });
    expect(await resumeLostTapSearches({ clock: () => resumeAt + MINUTE })).toEqual({ requested: 0 });
    expect(await resumeLostTapSearches({ clock: () => resumeAt + 5 * MINUTE })).toEqual({ requested: 1 });

    // Not while the connection is lost, nor when nothing is owed.
    Object.assign(account(), { connectionLostAt: new Date(NOW) });
    expect(await resumeLostTapSearches({ clock: () => resumeAt + HOUR })).toEqual({ requested: 0 });
    Object.assign(account(), { connectionLostAt: null, messagingTapSearchFrom: null });
    expect(await resumeLostTapSearches({ clock: () => resumeAt + HOUR })).toEqual({ requested: 0 });
  });
});

describe("a lost tap's job stands back", () => {
  const TAPPED = Date.parse("2026-11-25T20:51:10.000Z");
  const ask = (mid: string | null = "m_lost") =>
    lostTapAnswered({ instagramId: IG, automationId: "c_guide", userId: "p_anna", tappedAt: TAPPED, mid });
  const reveal = (overrides: Record<string, unknown>) =>
    state.db.dmLogs.push({
      instagramAccountId: "account_1",
      automationId: "c_guide",
      commentId: "reveal:p_anna",
      commenterId: "p_anna",
      status: "SENT",
      ...overrides,
    });

  it("for the campaign's link sent after the tap, one that may have gone out or waits; not a failed one or an old one", async () => {
    expect(await ask()).toBeNull();
    reveal({ dmSentAt: new Date("2026-11-20T10:00:00.000Z") });
    expect(await ask()).toBeNull();
    state.db.dmLogs[0] = { ...state.db.dmLogs[0], status: "FAILED", updatedAt: new Date(NOW) };
    expect(await ask()).toBeNull();
    state.db.dmLogs[0] = { ...state.db.dmLogs[0], status: "SENT", dmSentAt: new Date(NOW) };
    expect(await ask()).toBe("link");
    state.db.dmLogs[0] = { ...state.db.dmLogs[0], status: "PENDING", dmSentAt: null, updatedAt: new Date(NOW) };
    expect(await ask()).toBe("link");
    state.db.dmLogs[0] = { ...state.db.dmLogs[0], status: "FAILED", dmDeliveryUnconfirmed: true };
    expect(await ask()).toBe("link");
  });

  it("for a DM keyword of the person the campaign answered after the tap", async () => {
    state.db.dmLogs.push({
      instagramAccountId: "account_1",
      automationId: "c_guide",
      commentId: "dm:mid_kw",
      commenterId: "p_anna",
      status: "SENT",
      dmSentAt: new Date(NOW),
    });
    expect(await ask()).toBe("dm");
  });

  it("for another tap of the person on the campaign's buttons that arrived; not this very tap delivered late", async () => {
    storedTap("p_anna", new Date(NOW).toISOString(), "followcheck:c_guide:open", "m_lost");
    storedTap("p_anna", new Date(NOW).toISOString(), "reveal:c_other:open", "m_other_campaign");
    storedTap("p_ben", new Date(NOW).toISOString(), "followcheck:c_guide:open", "m_other_person");
    storedTap("p_anna", "2026-11-25T20:50:00.000Z", "followcheck:c_guide:open", "m_before");
    expect(await ask()).toBeNull();
    storedTap("p_anna", new Date(NOW).toISOString(), "followcheck:c_guide", "m_again");
    expect(await ask()).toBe("tap");
  });
});

describe("the production silence of 2026-11-25/26", () => {
  interface Timeline {
    dms: [string, "opening" | "reveal", string][];
    inbound: [string, string, string?][];
  }
  const timeline = JSON.parse(
    readFileSync(path.join(__dirname, "fixtures", "messaging-silence-timeline.json"), "utf8")
  ) as Timeline;

  it("looks at the four people who got an opening DM in it, leaves the one who tapped after the fix alone, and continues their taps", async () => {
    // The rows and webhooks of the timeline (people relabelled p1, p2, …).
    timeline.dms.forEach(([iso, kind, person], index) => {
      state.db.dmLogs.push({
        instagramAccountId: "account_1",
        automationId: "c_guide",
        commentId: kind === "opening" ? `comment_dm_${index}` : `reveal:${person}`,
        commenterId: person,
        commenterName: person,
        status: "SENT",
        dmSentAt: new Date(iso),
      });
    });
    timeline.inbound
      .filter(([, kind]) => kind === "postback")
      .forEach(([iso, , person]) => storedTap(person!, iso));
    const inSilence = timeline.dms.filter(
      ([iso, kind]) => kind === "opening" && Date.parse(iso) > FROM.getTime() && Date.parse(iso) <= UNTIL.getTime()
    );
    expect(inSilence.map(([, , person]) => person)).toEqual(["p60", "p61", "p62", "p63", "p1"]);
    // What their conversations might have shown: two lost taps, one at
    // night; nothing from the others.
    conversation("p60", "2026-11-25T20:49:23.000Z", [{ text: LABEL, at: "2026-11-25T20:50:31.000Z" }]);
    conversation("p61", "2026-11-25T20:49:24.000Z");
    conversation("p62", "2026-11-25T20:51:36.000Z");
    conversation("p63", "2026-11-26T04:51:55.000Z", [
      { text: LABEL, at: "2026-11-26T05:02:11.000Z" },
      { text: LABEL, at: "2026-11-26T05:02:40.000Z" },
    ]);
    conversation("p1", "2026-11-26T10:04:10.000Z", [{ text: LABEL, at: "2026-11-26T10:30:57.000Z" }]);

    expect(await run()).toBe("done");
    // p1's tap at 10:30:57 ended the silence and brought the link at
    // 10:30:58: not read. p61 and p62 did nothing after their opening DM:
    // not read either.
    expect(readConversations()).toEqual(["conv_p63", "conv_p60"]);
    expect(tapJobs().map((job) => [job.data.userId, job.data.tappedAt, job.opts.delay])).toEqual([
      ["p60", Date.parse("2026-11-25T20:50:31.000Z"), 0],
      ["p63", Date.parse("2026-11-26T05:02:40.000Z"), LOST_TAP_SPACING_MS],
    ]);
    expect(taps()).toMatchObject({ people: 5, continued: 2, noTap: 2, answered: 1, notChecked: 0, reads: 3 });
    expect(sent[0].text).toContain("2 Leute haben in dieser Zeit auf den Button in deiner ersten DM getippt");
  });
});

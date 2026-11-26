/**
 * The calibration of the messaging silence check (A2): the production
 * timeline of 2026-11-20 to 2026-11-26 11:37 UTC, replayed through the real
 * check with its default thresholds and through the webhook route's own step,
 * every 30 minutes like the worker's sweep (COMMENT_POLL_INTERVAL_MS in
 * production), once for each of the 30 minutes the sweep may fall on.
 *
 * The timeline (fixtures/messaging-silence-timeline.json) is derived from the
 * one the A2 spec calibrates with: every webhook that arrived (comment
 * changes, button taps, DMs, read receipts, echoes) and every SENT DmLog row,
 * with people relabelled. It knows of two incidents: no messaging webhooks
 * from 2026-11-25T13:15Z until the reconnect with the Facebook Page at
 * 2026-11-26T10:30Z, and no webhooks at all from 16:45Z to 20:39Z on the
 * 25th (A1's lost connection, which the replay sets as A1's check did).
 *
 * What it asserts:
 * - never a silent check before the silence began, quiet nights included;
 * - the incident opens during the silence, before the reconnect fixed it:
 *   at 09:30 UTC (10:30 in Berlin) with sweeps on the hour and the half
 *   hour, between 09:22 and 09:51 UTC for every other minute;
 * - its start is the last DM a person sent before it (13:15:16), the owners
 *   and admins get one alert, the first tap after the fix (10:30:57) ends it
 *   at the webhook route, and the all-clear follows with the next sweep.
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
import type { MailMessage, MailTransport } from "../lib/ops/mail";
import { resetMailWarnings } from "../lib/ops/mail";
import { resetMessagingSilenceMailWarnings } from "../lib/ops/messaging-silence-alert";

interface Timeline {
  silence: { from: string; until: string };
  connectionLost: { from: string; until: string };
  /** [time, kind, person] of every webhook that arrived. */
  inbound: [string, string, string?][];
  /** [time, opening or reveal, person] of every SENT DmLog row. */
  dms: [string, "opening" | "reveal", string][];
}

const timeline = JSON.parse(
  readFileSync(path.join(__dirname, "fixtures", "messaging-silence-timeline.json"), "utf8")
) as Timeline;

const IG = "ig_1";
const MINUTE = 60_000;
const INTERVAL = 30 * MINUTE;
const START = Date.parse("2026-11-20T00:00:00Z");
const END = Date.parse("2026-11-26T11:37:00Z");
const SILENCE_FROM = Date.parse(timeline.silence.from);
const SILENCE_UNTIL = Date.parse(timeline.silence.until);
const LOST_FROM = Date.parse(timeline.connectionLost.from);
const LOST_UNTIL = Date.parse(timeline.connectionLost.until);
const ENV = { DEFAULT_LOCALE: "de", NEXTAUTH_URL: "https://dm.example.test" };

// The webhook as Instagram sent it, for each kind the timeline names.
function webhook([iso, kind, person]: Timeline["inbound"][number], n: number) {
  const time = Date.parse(iso);
  const mid = `mid_${n}`;
  const from = { sender: { id: person ?? "unknown" }, recipient: { id: IG }, timestamp: time };
  const entry = (body: Record<string, unknown>) => ({
    object: "instagram",
    entry: [{ id: IG, time, ...body }],
  });
  switch (kind) {
    case "change:comments":
      return entry({
        changes: [
          {
            field: "comments",
            value: {
              id: `comment_${n}`,
              text: "Guide",
              from: { id: `commenter_${n}`, username: "someone" },
              media: { id: "media_1", media_product_type: "REELS" },
            },
          },
        ],
      });
    case "echo":
      return entry({
        messaging: [
          {
            sender: { id: IG },
            recipient: { id: "someone" },
            timestamp: time,
            message: { mid, text: "Hier ist dein Guide", is_echo: true },
          },
        ],
      });
    case "message":
      return entry({ messaging: [{ ...from, message: { mid, text: "Danke!" } }] });
    case "read":
      return entry({ messaging: [{ ...from, read: { mid } }] });
    case "postback":
      return entry({
        messaging: [
          {
            ...from,
            postback: { mid, title: "Ja, schick ihn mir", payload: "followcheck:campaign_1:open" },
          },
        ],
      });
    default:
      throw new Error(`the timeline has a kind the replay does not know: ${kind}`);
  }
}

interface Replay {
  firstStrike: number | null;
  opened: number | null;
  since: Date | null;
  ended: { at: string; via: string } | null;
  /** When each e-mail went out, by subject. */
  mails: { at: number; subject: string; to: string }[];
  /** The outcomes of the sweeps while A1's incident was open. */
  duringLostConnection: Set<string>;
}

async function replay(phaseMinutes: number): Promise<Replay> {
  state.redis = new FakeRedis();
  state.db = new FakeConnectionDb();
  state.db.accounts.push(fakeAccount({ instagramId: IG }));
  state.db.users.push(
    { id: "u_owner", email: "owner@example.test" },
    { id: "u_admin", email: "admin@example.test" }
  );
  state.db.workspaces.push({ id: "workspace_1", ownerId: "u_owner" });
  state.db.members.push(
    { workspaceId: "workspace_1", userId: "u_owner", role: "OWNER", createdAt: new Date(START) },
    { workspaceId: "workspace_1", userId: "u_admin", role: "ADMIN", createdAt: new Date(START) }
  );
  // The resource campaigns: an opening DM with a button, then the follow
  // gate. Every DM of the timeline belongs to such a campaign.
  state.db.campaigns.push(
    fakeCampaign({
      openingDmEnabled: true,
      openingDmMessage: "Hey! Magst du den Guide?",
      openingDmButtonLabel: "Ja, schick ihn mir",
    })
  );
  timeline.dms.forEach(([iso, kind, person], index) => {
    state.db.dmLogs.push({
      instagramAccountId: "account_1",
      automationId: "campaign_1",
      commentId: kind === "opening" ? `comment_dm_${index}` : `reveal:${person}`,
      commenterId: person,
      status: "SENT",
      dmSentAt: new Date(iso),
    });
  });
  const arrivals = timeline.inbound.map((event, n) => ({
    at: Date.parse(event[0]),
    payload: webhook(event, n),
  }));

  const mails: Replay["mails"] = [];
  let now = START;
  const transport: MailTransport = {
    name: "resend",
    async send(message: MailMessage) {
      mails.push({ at: now, subject: message.subject, to: message.to });
      return { ok: true };
    },
  };
  const result: Replay = {
    firstStrike: null,
    opened: null,
    since: null,
    ended: null,
    mails,
    duringLostConnection: new Set(),
  };
  const noteEnd = () => {
    const row = state.db.account();
    if (result.opened !== null && !result.ended && !row.messagingSilentSince) {
      const stored = row.messagingSilenceResult as { endedAt: string; via: string };
      result.ended = { at: stored.endedAt, via: stored.via };
    }
  };

  let delivered = 0;
  for (now = START + phaseMinutes * MINUTE; now <= END; now += INTERVAL) {
    // The webhooks since the last sweep, each stored and handed to the
    // route's own step at the moment it arrived.
    while (delivered < arrivals.length && arrivals[delivered].at <= now) {
      const { at, payload } = arrivals[delivered];
      delivered += 1;
      state.db.webhookEvents.push({
        id: `we_${String(delivered).padStart(4, "0")}`,
        createdAt: new Date(at),
        payload,
      });
      vi.setSystemTime(at);
      await endMessagingSilencesFor(payload as never, [{ ...state.db.account() }], {
        at: new Date(at),
      });
      noteEnd();
    }
    // A1's incident as its check recorded it.
    Object.assign(state.db.account(), {
      connectionLostAt: now >= LOST_FROM && now < LOST_UNTIL ? new Date(LOST_FROM) : null,
      connectionRecoveredAt: now >= LOST_UNTIL ? new Date(LOST_UNTIL) : null,
    });

    vi.setSystemTime(now);
    const sweep = now;
    const summary = await checkMessagingSilences({
      intervalMs: INTERVAL,
      clock: () => sweep,
      env: ENV,
      transport,
    });
    expect(summary.outcomes.error, new Date(now).toISOString()).toBeUndefined();
    if (now >= LOST_FROM && now < LOST_UNTIL) {
      for (const outcome of Object.keys(summary.outcomes)) result.duringLostConnection.add(outcome);
    }
    const row = state.db.account();
    if (row.messagingSilenceCheckAt && result.firstStrike === null) result.firstStrike = now;
    if (row.messagingSilentSince && result.opened === null) {
      result.opened = now;
      result.since = row.messagingSilentSince;
    }
    noteEnd();
  }
  return result;
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
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

describe("the defaults on the production timeline of 2026-11-20 to 26", () => {
  it("open the incident at 09:30 UTC for sweeps on the hour and the half hour, and end it with the first tap after the fix", async () => {
    const run = await replay(0);
    expect(iso(run.firstStrike)).toBe("2026-11-26T09:00:00.000Z");
    expect(iso(run.opened)).toBe("2026-11-26T09:30:00.000Z");
    expect(run.since?.toISOString()).toBe("2026-11-25T13:15:16.000Z");
    expect(run.ended).toEqual({ at: "2026-11-26T10:30:57.000Z", via: "webhook" });
    // One alert to the owner and the admin, then the all-clear with the
    // first sweep after the end.
    expect(
      run.mails.map((mail) => [iso(mail.at), mail.subject.split(":")[0]])
    ).toEqual([
      ["2026-11-26T09:30:00.000Z", "Instagram gibt keine Button-Tipps weiter"],
      ["2026-11-26T09:30:00.000Z", "Instagram gibt keine Button-Tipps weiter"],
      ["2026-11-26T11:00:00.000Z", "Entwarnung"],
      ["2026-11-26T11:00:00.000Z", "Entwarnung"],
    ]);
    // No judgment while A1's incident was open.
    expect([...run.duringLostConnection]).toEqual(["connection-lost"]);
  });

  it("never make a silent check before the silence, and always open the incident during it, whatever minute the sweep falls on", async () => {
    const opened: number[] = [];
    const strikes: number[] = [];
    for (let phase = 0; phase < 30; phase += 1) {
      const run = await replay(phase);
      expect(run.firstStrike, `phase ${phase}`).not.toBeNull();
      expect(run.firstStrike!, `phase ${phase}: first silent check`).toBeGreaterThanOrEqual(SILENCE_FROM);
      expect(run.opened!, `phase ${phase}`).toBeGreaterThan(SILENCE_FROM);
      expect(run.opened!, `phase ${phase}`).toBeLessThan(SILENCE_UNTIL);
      expect(run.since?.toISOString(), `phase ${phase}`).toBe("2026-11-25T13:15:16.000Z");
      expect(run.ended?.at, `phase ${phase}`).toBe("2026-11-26T10:30:57.000Z");
      opened.push(run.opened!);
      strikes.push(run.firstStrike!);
    }
    // Between 08:52 and 09:21 the first silent check, half an hour later the incident.
    expect(iso(Math.min(...strikes))).toBe("2026-11-26T08:52:00.000Z");
    expect(iso(Math.max(...strikes))).toBe("2026-11-26T09:21:00.000Z");
    expect(iso(Math.min(...opened))).toBe("2026-11-26T09:22:00.000Z");
    expect(iso(Math.max(...opened))).toBe("2026-11-26T09:51:00.000Z");
  });
});

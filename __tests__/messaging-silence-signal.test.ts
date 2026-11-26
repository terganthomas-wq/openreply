/**
 * The messaging silence signal (A2) on its own: which webhook payloads count
 * as an inbound messaging event (echoes and comment changes do not, standby
 * does), the thresholds and their bounds, the judgment of one check (the
 * window and the spread rule), and the two strikes, the second judged on the
 * first one's evidence.
 *
 * Pure functions: no database, no clock, no network.
 */
import { describe, expect, it } from "vitest";
import {
  inboundMessagingAccountIds,
  inboundMessagingKind,
  parseMessageEvents,
  parsePostbackEvents,
  parseReadEvents,
} from "../lib/meta/webhook";
import {
  INBOUND_LOOKBACK_MS,
  judgeMessagingSilence,
  MESSAGING_SILENCE_DEFAULTS,
  messagingSilenceThresholds,
  nextSilenceStep,
  SILENCE_STRIKE_MAX_AGE_MS,
  silenceDmBounds,
  silenceJudgedAt,
  type OpeningDm,
} from "../lib/instagram/messaging-silence-signal";

const IG = "17841400000000001";
const OTHER_IG = "17841400000000002";
const PERSON = "1234567890123456";
const TIME = Date.parse("2026-11-26T10:30:57.000Z");
const HOUR = 3_600_000;
const MINUTE = 60_000;

type Payload = Parameters<typeof inboundMessagingAccountIds>[0];
type Item = NonNullable<Payload["entry"][number]["messaging"]>[number];

// Webhooks as Instagram sends them for an account connected through Meta.
function messaging(item: Item, account = IG): Payload {
  return {
    object: "instagram",
    entry: [{ id: account, time: TIME, messaging: [{ timestamp: TIME, ...item }] }],
  };
}

const fromPerson = { sender: { id: PERSON }, recipient: { id: IG } };
const PAYLOADS = {
  postback: messaging({
    ...fromPerson,
    postback: { mid: "aWdfZAG1_tap", title: "Ja, schick ihn mir", payload: "reveal:campaign_1:open" },
  }),
  message: messaging({ ...fromPerson, message: { mid: "aWdfZAG1_msg", text: "Danke!" } }),
  sticker: messaging({
    ...fromPerson,
    message: { mid: "aWdfZAG1_sticker", attachments: [{ type: "image" }] },
  }),
  deleted: messaging({ ...fromPerson, message: { mid: "aWdfZAG1_del", is_deleted: true } }),
  read: messaging({ ...fromPerson, read: { mid: "aWdfZAG1_read" } }),
  reaction: messaging({
    ...fromPerson,
    reaction: { mid: "aWdfZAG1_msg", action: "react", reaction: "love", emoji: "❤️" },
  }),
  echo: messaging({
    sender: { id: IG },
    recipient: { id: PERSON },
    message: { mid: "aWdfZAG1_echo", text: "Hier ist dein Guide", is_echo: true },
  }),
  ownRead: messaging({ sender: { id: IG }, recipient: { id: PERSON }, read: { mid: "m" } }),
  comment: {
    object: "instagram",
    entry: [
      {
        id: IG,
        time: TIME,
        changes: [
          {
            field: "comments",
            value: {
              id: "18012345678901234",
              text: "Guide",
              from: { id: PERSON, username: "anna" },
              media: { id: "18098765432109876", media_product_type: "REELS" },
            },
          },
        ],
      },
    ],
  } satisfies Payload,
  standbyRead: {
    object: "instagram",
    entry: [{ id: IG, time: TIME, standby: [{ ...fromPerson, timestamp: TIME, read: { mid: "m" } }] }],
  } satisfies Payload,
  standbyEcho: {
    object: "instagram",
    entry: [
      {
        id: IG,
        time: TIME,
        standby: [
          {
            sender: { id: IG },
            recipient: { id: PERSON },
            timestamp: TIME,
            message: { mid: "m", text: "Hallo", is_echo: true },
          },
        ],
      },
    ],
  } satisfies Payload,
  otherAccount: messaging(
    { sender: { id: PERSON }, recipient: { id: OTHER_IG }, read: { mid: "m" } },
    OTHER_IG
  ),
};

describe("what counts as an inbound messaging event", () => {
  it("counts a button tap, a DM, a DM without text, a deleted one, a read receipt and a reaction", () => {
    for (const name of ["postback", "message", "sticker", "deleted", "read", "reaction"] as const) {
      expect(inboundMessagingAccountIds(PAYLOADS[name]), name).toEqual([IG]);
    }
    expect(inboundMessagingKind(PAYLOADS.reaction.entry[0].messaging![0], IG)).toBe("reaction");
    expect(inboundMessagingKind(PAYLOADS.postback.entry[0].messaging![0], IG)).toBe("postback");
  });

  it("never counts an echo, the account's own read or a comment change", () => {
    for (const name of ["echo", "ownRead", "comment", "standbyEcho"] as const) {
      expect(inboundMessagingAccountIds(PAYLOADS[name]), name).toEqual([]);
    }
    // Also an echo that names no sender (a DM the account sent from another app).
    const echo = { recipient: { id: PERSON }, message: { mid: "m", text: "Hallo", is_echo: true } };
    expect(inboundMessagingAccountIds(messaging(echo))).toEqual([]);
  });

  it("counts events in standby, which arrive while another app is the conversation's receiver", () => {
    expect(inboundMessagingAccountIds(PAYLOADS.standbyRead)).toEqual([IG]);
    // The parsers that queue jobs never act on them.
    expect(parseReadEvents(PAYLOADS.standbyRead)).toEqual([]);
  });

  it("names the account the event is for, once, and an echo beside a receipt does not hide it", () => {
    const mixed: Payload = {
      object: "instagram",
      entry: [
        { ...PAYLOADS.echo.entry[0] },
        { ...PAYLOADS.otherAccount.entry[0] },
        { ...PAYLOADS.read.entry[0] },
        { ...PAYLOADS.postback.entry[0] },
      ],
    };
    expect(inboundMessagingAccountIds(mixed).sort()).toEqual([IG, OTHER_IG].sort());
    expect(inboundMessagingAccountIds(PAYLOADS.otherAccount)).toEqual([OTHER_IG]);
  });

  it("reads anything the database may hold without throwing", () => {
    for (const odd of [
      {},
      { object: "page", entry: [] },
      { object: "instagram" },
      { object: "instagram", entry: [null, { id: 5 }, { id: IG, messaging: "x" }, { id: IG, messaging: [null, 7] }] },
    ]) {
      expect(inboundMessagingAccountIds(odd as unknown as Payload)).toEqual([]);
    }
  });

  it("agrees with the parsers on what a person did", () => {
    expect(parsePostbackEvents(PAYLOADS.postback)).toHaveLength(1);
    expect(parseMessageEvents(PAYLOADS.message)).toHaveLength(1);
    expect(parseMessageEvents(PAYLOADS.echo)).toEqual([]);
    // A DM without text queues no job, but it shows that DMs arrive.
    expect(parseMessageEvents(PAYLOADS.sticker)).toEqual([]);
    expect(inboundMessagingAccountIds(PAYLOADS.sticker)).toEqual([IG]);
  });
});

describe("the thresholds", () => {
  it("are 3 people, 12 hours and an 18-hour window, or 5 people however far apart, by default", () => {
    expect(messagingSilenceThresholds({})).toEqual({
      thresholds: { minPeople: 3, minAgeMs: 12 * HOUR, windowMs: 18 * HOUR, spreadMinPeople: 5 },
      notes: [],
    });
    expect(MESSAGING_SILENCE_DEFAULTS).toEqual({
      minPeople: 3,
      minAgeHours: 12,
      windowBeyondAgeHours: 6,
      spreadBeyondPeople: 2,
    });
  });

  it("take what the environment sets within the bounds", () => {
    expect(
      messagingSilenceThresholds({
        MESSAGING_SILENCE_MIN_PEOPLE: "4",
        MESSAGING_SILENCE_MIN_AGE_HOURS: "13.5",
        MESSAGING_SILENCE_WINDOW_HOURS: "24",
        MESSAGING_SILENCE_SPREAD_MIN_PEOPLE: "8",
      })
    ).toEqual({
      thresholds: { minPeople: 4, minAgeMs: 13.5 * HOUR, windowMs: 24 * HOUR, spreadMinPeople: 8 },
      notes: [],
    });
  });

  it("keep the six hours of the window when only the age changes, and two people more for the spread when only the people change", () => {
    expect(
      messagingSilenceThresholds({ MESSAGING_SILENCE_MIN_AGE_HOURS: "20" }).thresholds.windowMs
    ).toBe(26 * HOUR);
    expect(
      messagingSilenceThresholds({ MESSAGING_SILENCE_MIN_PEOPLE: "4" }).thresholds.spreadMinPeople
    ).toBe(6);
  });

  it("move a value outside its bounds to the nearest one and say so", () => {
    const { thresholds, notes } = messagingSilenceThresholds({
      MESSAGING_SILENCE_MIN_PEOPLE: "1",
      MESSAGING_SILENCE_MIN_AGE_HOURS: "2",
      MESSAGING_SILENCE_WINDOW_HOURS: "3",
      MESSAGING_SILENCE_SPREAD_MIN_PEOPLE: "2",
    });
    expect(thresholds).toEqual({ minPeople: 2, minAgeMs: 4 * HOUR, windowMs: 5 * HOUR, spreadMinPeople: 3 });
    expect(notes).toEqual([
      "MESSAGING_SILENCE_MIN_PEOPLE=1 is outside 2 to 10: using 2",
      "MESSAGING_SILENCE_MIN_AGE_HOURS=2 is outside 4 to 36: using 4",
      "MESSAGING_SILENCE_WINDOW_HOURS=3 is outside 5 to 52: using 5",
      // Always more people than the window's.
      "MESSAGING_SILENCE_SPREAD_MIN_PEOPLE=2 is outside 3 to 22: using 3",
    ]);
    expect(
      messagingSilenceThresholds({
        MESSAGING_SILENCE_MIN_PEOPLE: "50",
        MESSAGING_SILENCE_MIN_AGE_HOURS: "100",
        MESSAGING_SILENCE_WINDOW_HOURS: "1000",
        MESSAGING_SILENCE_SPREAD_MIN_PEOPLE: "1000",
      }).thresholds
    ).toEqual({ minPeople: 10, minAgeMs: 36 * HOUR, windowMs: 84 * HOUR, spreadMinPeople: 30 });
  });

  it("fall back to the default for anything that is not a number", () => {
    const { thresholds, notes } = messagingSilenceThresholds({
      MESSAGING_SILENCE_MIN_PEOPLE: "drei",
      MESSAGING_SILENCE_MIN_AGE_HOURS: "12h",
      MESSAGING_SILENCE_WINDOW_HOURS: " ",
      MESSAGING_SILENCE_SPREAD_MIN_PEOPLE: "5.5",
    });
    expect(thresholds).toEqual({ minPeople: 3, minAgeMs: 12 * HOUR, windowMs: 18 * HOUR, spreadMinPeople: 5 });
    expect(notes).toEqual([
      "MESSAGING_SILENCE_MIN_PEOPLE=drei is not a whole number: using 3",
      "MESSAGING_SILENCE_MIN_AGE_HOURS=12h is not a number: using 12",
      "MESSAGING_SILENCE_SPREAD_MIN_PEOPLE=5.5 is not a whole number: using 5",
    ]);
    expect(messagingSilenceThresholds({ MESSAGING_SILENCE_MIN_PEOPLE: "3.5" }).notes).toEqual([
      "MESSAGING_SILENCE_MIN_PEOPLE=3.5 is not a whole number: using 3",
    ]);
  });
});

describe("one check's judgment", () => {
  const { thresholds } = messagingSilenceThresholds({});
  const at = (iso: string) => new Date(iso);
  // 2026-11-25: the last DM from a person at 13:15:16, then opening DMs to
  // three people after the A1 reconnect.
  const LAST_INBOUND = at("2026-11-25T13:15:16Z");
  const DMS: OpeningDm[] = [
    { recipientId: "p1", sentAt: at("2026-11-25T20:49:23Z") },
    { recipientId: "p2", sentAt: at("2026-11-25T20:49:24Z") },
    { recipientId: "p3", sentAt: at("2026-11-25T20:51:36Z") },
  ];
  function judge(now: string, dms = DMS, lastInboundAt: Date | null = LAST_INBOUND, notBefore: Date | null = null) {
    return judgeMessagingSilence({
      dms,
      lastInboundAt,
      bounds: silenceDmBounds(Date.parse(now), thresholds, notBefore),
      thresholds,
    });
  }

  it("is silent once three people's opening DMs are 12 hours old and nothing came back", () => {
    expect(judge("2026-11-26T08:51:35Z")).toEqual({ silent: false, people: 2 });
    expect(judge("2026-11-26T08:51:36Z")).toEqual({
      silent: true,
      rule: "window",
      people: 3,
      firstDmAt: at("2026-11-25T20:49:23Z"),
    });
  });

  it("is not silent when anything arrived after the DMs", () => {
    expect(judge("2026-11-26T09:00:00Z", DMS, at("2026-11-25T20:50:00Z"))).toEqual({
      silent: false,
      people: 1,
    });
  });

  it("counts people, not DMs", () => {
    const twice = [...DMS.slice(0, 2), { recipientId: "p1", sentAt: at("2026-11-25T20:51:36Z") }];
    expect(judge("2026-11-26T09:00:00Z", twice)).toEqual({ silent: false, people: 2 });
  });

  it("counts only DMs of the last 18 hours: the people must have got them close together", () => {
    expect(judge("2026-11-26T14:49:22Z").silent).toBe(true);
    // The first DM is exactly 18 hours old now: it no longer counts.
    expect(judge("2026-11-26T14:49:23Z")).toEqual({ silent: false, people: 2 });
  });

  it("counts no DM sent before the end of the last lost connection", () => {
    expect(judge("2026-11-26T09:00:00Z", DMS, null, at("2026-11-25T20:49:30Z"))).toEqual({
      silent: false,
      people: 1,
    });
  });

  it("needs no inbound event at all to be silent", () => {
    expect(judge("2026-11-26T09:00:00Z", DMS, null).silent).toBe(true);
  });

  // One opening DM to a new person every 190 minutes, as on a quiet day: never
  // three of them within the six hours of the window.
  const SPREAD: OpeningDm[] = Array.from({ length: 6 }, (_, n) => ({
    recipientId: `s${n}`,
    sentAt: new Date(Date.parse("2026-11-24T08:00:00Z") + n * 190 * MINUTE),
  }));
  const FIFTH_DM = Date.parse("2026-11-24T08:00:00Z") + 4 * 190 * MINUTE;
  const before = at("2026-11-24T07:00:00Z");

  it("is silent by the spread rule once five people's opening DMs are 12 hours old, however far apart", () => {
    const now = (ms: number) => new Date(ms).toISOString();
    expect(judge(now(FIFTH_DM + 12 * HOUR - 1_000), SPREAD, before)).toEqual({ silent: false, people: 1 });
    expect(judge(now(FIFTH_DM + 12 * HOUR), SPREAD, before)).toEqual({
      silent: true,
      rule: "spread",
      people: 5,
      firstDmAt: SPREAD[0].sentAt,
    });
    // Anything that arrived after the first of them leaves too few.
    expect(judge(now(FIFTH_DM + 12 * HOUR), SPREAD, at("2026-11-24T08:30:00Z")).silent).toBe(false);
    // And none before the end of the last lost connection counts.
    expect(judge(now(FIFTH_DM + 12 * HOUR), SPREAD, before, at("2026-11-24T08:30:00Z")).silent).toBe(false);
  });

  it("reaches back as far as the inbound events are read, and no further", () => {
    const bounds = silenceDmBounds(Date.parse("2026-11-26T09:00:00Z"), thresholds);
    expect(bounds).toEqual({
      after: at("2026-11-25T15:00:00Z"),
      spreadAfter: new Date(Date.parse("2026-11-26T09:00:00Z") - INBOUND_LOOKBACK_MS),
      until: at("2026-11-25T21:00:00Z"),
    });
    // Judged at an earlier first check: its window and age, today's look-back.
    expect(
      silenceDmBounds(Date.parse("2026-11-26T08:30:00Z"), thresholds, null, Date.parse("2026-11-26T09:00:00Z"))
    ).toEqual({ ...bounds, after: at("2026-11-25T14:30:00Z"), until: at("2026-11-25T20:30:00Z") });
  });
});

describe("the two strikes", () => {
  const GAP = 27 * MINUTE;
  const NOW = Date.parse("2026-11-26T09:30:00Z");
  const silent = { silent: true as const, rule: "window" as const, people: 3, firstDmAt: new Date(NOW - 13 * HOUR) };
  const quiet = { silent: false as const, people: 1 };
  const none = { messagingSilenceCheckAt: null, messagingSilentSince: null };

  it("remembers the first silent check and opens the incident with the second", () => {
    expect(nextSilenceStep(none, silent, NOW, GAP)).toEqual({ kind: "strike" });
    expect(
      nextSilenceStep({ ...none, messagingSilenceCheckAt: new Date(NOW - 30 * MINUTE) }, silent, NOW, GAP)
    ).toEqual({ kind: "open" });
  });

  it("waits for one interval between them", () => {
    expect(
      nextSilenceStep({ ...none, messagingSilenceCheckAt: new Date(NOW - 26 * MINUTE) }, silent, NOW, GAP)
    ).toEqual({ kind: "none" });
  });

  it("forgets the first silent check after one that is not", () => {
    expect(
      nextSilenceStep({ ...none, messagingSilenceCheckAt: new Date(NOW - 30 * MINUTE) }, quiet, NOW, GAP)
    ).toEqual({ kind: "clear-strike" });
    expect(nextSilenceStep(none, quiet, NOW, GAP)).toEqual({ kind: "none" });
  });

  it("never ends an open incident: only an event that arrived does", () => {
    const open = { messagingSilenceCheckAt: new Date(NOW - 2 * HOUR), messagingSilentSince: new Date(NOW - 20 * HOUR) };
    expect(nextSilenceStep(open, quiet, NOW, GAP)).toEqual({ kind: "still-silent" });
    expect(nextSilenceStep(open, silent, NOW, GAP)).toEqual({ kind: "still-silent" });
  });

  it("judge the second check at the first one's time, so DMs growing too old meanwhile undo nothing", () => {
    const { thresholds } = messagingSilenceThresholds({});
    const first = new Date("2026-11-26T09:00:00Z");
    // Three people's DMs that count together only from 08:51:36 to 09:30.
    const dms: OpeningDm[] = [
      { recipientId: "p1", sentAt: new Date("2026-11-25T15:30:00Z") },
      { recipientId: "p2", sentAt: new Date("2026-11-25T18:00:00Z") },
      { recipientId: "p3", sentAt: new Date("2026-11-25T20:51:36Z") },
    ];
    const judgeAt = (strike: Date | null, now: number, lastInboundAt: Date | null = null) => {
      const judged = silenceJudgedAt(strike, now, null);
      const judgment = judgeMessagingSilence({
        dms,
        lastInboundAt,
        bounds: silenceDmBounds(judged.at, thresholds, null, now),
        thresholds,
      });
      return nextSilenceStep({ messagingSilenceCheckAt: strike, messagingSilentSince: null }, judgment, now, GAP, judged.strike);
    };
    expect(judgeAt(null, first.getTime())).toEqual({ kind: "strike" });
    // Judged at its own time, the second check would forget the first.
    const second = Date.parse("2026-11-26T09:30:00Z");
    expect(judgeAt(null, second)).toEqual({ kind: "none" });
    // On the first one's evidence it opens the incident, also hours later.
    expect(silenceJudgedAt(first, second, null)).toEqual({ at: first.getTime(), strike: first });
    expect(judgeAt(first, second)).toEqual({ kind: "open" });
    expect(judgeAt(first, Date.parse("2026-11-26T15:00:00Z"))).toEqual({ kind: "open" });
    // Only an event that arrived since undoes it.
    expect(judgeAt(first, second, new Date("2026-11-26T09:10:00Z"))).toEqual({ kind: "clear-strike" });
  });

  it("start over when the first check no longer counts: from before the last lost connection ended, or a day old", () => {
    const first = new Date(NOW - 30 * MINUTE);
    expect(silenceJudgedAt(first, NOW, new Date(NOW - 40 * MINUTE))).toEqual({ at: first.getTime(), strike: first });
    expect(silenceJudgedAt(first, NOW, new Date(NOW - 10 * MINUTE))).toEqual({ at: NOW, strike: null });
    expect(silenceJudgedAt(first, first.getTime() + SILENCE_STRIKE_MAX_AGE_MS, null).strike).toEqual(first);
    expect(silenceJudgedAt(first, first.getTime() + SILENCE_STRIKE_MAX_AGE_MS + 1, null)).toEqual({
      at: first.getTime() + SILENCE_STRIKE_MAX_AGE_MS + 1,
      strike: null,
    });
    // A first check that no longer counts is replaced by a silent one, or forgotten.
    const stored = { messagingSilenceCheckAt: new Date(NOW - 2 * SILENCE_STRIKE_MAX_AGE_MS), messagingSilentSince: null };
    expect(nextSilenceStep(stored, silent, NOW, GAP, null)).toEqual({ kind: "strike" });
    expect(nextSilenceStep(stored, quiet, NOW, GAP, null)).toEqual({ kind: "clear-strike" });
  });
});

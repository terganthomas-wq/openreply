/**
 * The messaging silence signal (A2) on its own: which webhook payloads count
 * as an inbound messaging event (echoes and comment changes do not, standby
 * does), the thresholds and their bounds, the judgment of one check, and the
 * two strikes.
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
  judgeMessagingSilence,
  MESSAGING_SILENCE_DEFAULTS,
  messagingSilenceThresholds,
  nextSilenceStep,
  silenceDmBounds,
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
  it("are 3 people, 12 hours and an 18-hour window by default", () => {
    expect(messagingSilenceThresholds({})).toEqual({
      thresholds: { minPeople: 3, minAgeMs: 12 * HOUR, windowMs: 18 * HOUR },
      notes: [],
    });
    expect(MESSAGING_SILENCE_DEFAULTS).toEqual({
      minPeople: 3,
      minAgeHours: 12,
      windowBeyondAgeHours: 6,
    });
  });

  it("take what the environment sets within the bounds", () => {
    expect(
      messagingSilenceThresholds({
        MESSAGING_SILENCE_MIN_PEOPLE: "4",
        MESSAGING_SILENCE_MIN_AGE_HOURS: "13.5",
        MESSAGING_SILENCE_WINDOW_HOURS: "24",
      })
    ).toEqual({
      thresholds: { minPeople: 4, minAgeMs: 13.5 * HOUR, windowMs: 24 * HOUR },
      notes: [],
    });
  });

  it("keep the six hours of the window when only the age changes", () => {
    expect(
      messagingSilenceThresholds({ MESSAGING_SILENCE_MIN_AGE_HOURS: "20" }).thresholds.windowMs
    ).toBe(26 * HOUR);
  });

  it("move a value outside its bounds to the nearest one and say so", () => {
    const { thresholds, notes } = messagingSilenceThresholds({
      MESSAGING_SILENCE_MIN_PEOPLE: "1",
      MESSAGING_SILENCE_MIN_AGE_HOURS: "2",
      MESSAGING_SILENCE_WINDOW_HOURS: "3",
    });
    expect(thresholds).toEqual({ minPeople: 2, minAgeMs: 4 * HOUR, windowMs: 5 * HOUR });
    expect(notes).toEqual([
      "MESSAGING_SILENCE_MIN_PEOPLE=1 is outside 2 to 10: using 2",
      "MESSAGING_SILENCE_MIN_AGE_HOURS=2 is outside 4 to 36: using 4",
      "MESSAGING_SILENCE_WINDOW_HOURS=3 is outside 5 to 52: using 5",
    ]);
    expect(
      messagingSilenceThresholds({
        MESSAGING_SILENCE_MIN_PEOPLE: "50",
        MESSAGING_SILENCE_MIN_AGE_HOURS: "100",
        MESSAGING_SILENCE_WINDOW_HOURS: "1000",
      }).thresholds
    ).toEqual({ minPeople: 10, minAgeMs: 36 * HOUR, windowMs: 84 * HOUR });
  });

  it("fall back to the default for anything that is not a number", () => {
    const { thresholds, notes } = messagingSilenceThresholds({
      MESSAGING_SILENCE_MIN_PEOPLE: "drei",
      MESSAGING_SILENCE_MIN_AGE_HOURS: "12h",
      MESSAGING_SILENCE_WINDOW_HOURS: " ",
    });
    expect(thresholds).toEqual({ minPeople: 3, minAgeMs: 12 * HOUR, windowMs: 18 * HOUR });
    expect(notes).toEqual([
      "MESSAGING_SILENCE_MIN_PEOPLE=drei is not a whole number: using 3",
      "MESSAGING_SILENCE_MIN_AGE_HOURS=12h is not a number: using 12",
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
      minPeople: thresholds.minPeople,
    });
  }

  it("is silent once three people's opening DMs are 12 hours old and nothing came back", () => {
    expect(judge("2026-11-26T08:51:35Z")).toEqual({ silent: false, people: 2 });
    expect(judge("2026-11-26T08:51:36Z")).toEqual({
      silent: true,
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
});

describe("the two strikes", () => {
  const GAP = 27 * MINUTE;
  const NOW = Date.parse("2026-11-26T09:30:00Z");
  const silent = { silent: true as const, people: 3, firstDmAt: new Date(NOW - 13 * HOUR) };
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
});

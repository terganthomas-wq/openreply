/**
 * Order, window and reminder timing of lead-magnet offers.
 *
 * Instagram only lets a business message someone within 24 hours of their
 * last tap or DM, so the reminder has to land inside that window even after
 * BullMQ's retries, and every send checks the window with a safety margin.
 */

import { describe, expect, it, vi } from "vitest";
import {
  followUpCanMeetOffer,
  LATE_OFFER_FOLLOW_UP_LIMIT_MINUTES,
  lateStartDelayMs,
  lateStartFireAt,
  OFFER_DELAY_HOURS,
  OFFER_LATE_START_HOURS,
  OFFER_ORDER,
  offerJobId,
  offerStartKey,
  offerStartsLate,
  reminderFireAt,
  resolveOfferOrder,
  withinWindow,
} from "@/lib/offers/schedule";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.parse("2026-11-20T12:10:00.000Z");

describe("OFFER_ORDER", () => {
  it("orders by position and breaks ties by age and id", () => {
    expect(OFFER_ORDER).toEqual([
      { position: "asc" },
      { createdAt: "asc" },
      { id: "asc" },
    ]);
  });
});

describe("resolveOfferOrder", () => {
  const active = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("uses the workspace's default order when the campaign has none", () => {
    expect(resolveOfferOrder([], active)).toEqual(active);
  });

  it("follows the campaign's own order", () => {
    expect(resolveOfferOrder(["c", "a"], active)).toEqual([
      { id: "c" },
      { id: "a" },
    ]);
  });

  it("counts an offer once when the campaign lists it twice", () => {
    expect(resolveOfferOrder(["b", "a", "b"], active)).toEqual([
      { id: "b" },
      { id: "a" },
    ]);
  });

  // The active list holds neither paused nor deleted offers, so their ids
  // drop out like unknown ones and the campaign moves on to the next offer.
  it("drops unknown, paused and deleted offers", () => {
    expect(resolveOfferOrder(["paused", "b", "deleted", "unknown"], active)).toEqual([
      { id: "b" },
    ]);
  });

  it("leaves the default list it was given unchanged", () => {
    const defaults = [...active];
    resolveOfferOrder([], defaults).reverse();
    expect(defaults).toEqual(active);
  });
});

describe("withinWindow", () => {
  it("is open right after a tap", () => {
    expect(withinWindow(new Date(NOW - MINUTE), NOW)).toBe(true);
  });

  it("closes five minutes before Instagram's 24 hours are up", () => {
    const lastSafe = NOW - (24 * HOUR - 5 * MINUTE) + 1;
    expect(withinWindow(lastSafe, NOW)).toBe(true);
    expect(withinWindow(lastSafe - 1, NOW)).toBe(false);
    expect(withinWindow(new Date(NOW - 24 * HOUR), NOW)).toBe(false);
  });

  it("is closed for someone who never tapped or wrote", () => {
    expect(withinWindow(null, NOW)).toBe(false);
    expect(withinWindow(undefined, NOW)).toBe(false);
  });

  it("reads the clock when no time is given", () => {
    expect(withinWindow(new Date())).toBe(true);
  });
});

describe("reminderFireAt", () => {
  it("fires the chosen hours after the offer's last message, on a half hour", () => {
    const fireAt = reminderFireAt({
      pitchSentAt: NOW,
      lastInteractionAt: NOW - 10_000,
      delayHours: 23,
    });

    // 23 hours after 12:10 is 11:10, rounded down to 11:00 UTC.
    expect(new Date(fireAt).toISOString()).toBe("2026-11-21T11:00:00.000Z");
  });

  it("fires no later than 23.5 hours after the last interaction", () => {
    const lastInteractionAt = NOW - 3 * HOUR;
    const fireAt = reminderFireAt({
      pitchSentAt: NOW,
      lastInteractionAt,
      delayHours: 23,
    });

    expect(fireAt).toBeLessThanOrEqual(lastInteractionAt + 23.5 * HOUR);
    // 09:10 + 23.5 h = 08:40 the next day, rounded down to 08:30.
    expect(new Date(fireAt).toISOString()).toBe("2026-11-21T08:30:00.000Z");
  });

  it("rounds down to a full or half hour in UTC, so it only ever fires earlier", () => {
    for (const minute of [0, 1, 29, 30, 31, 59]) {
      const pitchSentAt = Date.parse("2026-11-20T08:00:00.000Z") + minute * MINUTE;
      const fireAt = reminderFireAt({
        pitchSentAt,
        lastInteractionAt: pitchSentAt,
        delayHours: 2,
      });
      expect(fireAt % (30 * MINUTE)).toBe(0);
      expect(fireAt).toBeLessThanOrEqual(pitchSentAt + 2 * HOUR);
      expect(fireAt).toBeGreaterThan(pitchSentAt + 2 * HOUR - 30 * MINUTE);
    }
  });

  it.each([
    { delayHours: 0, expected: "2026-11-20T13:00:00.000Z" },
    { delayHours: -5, expected: "2026-11-20T13:00:00.000Z" },
    { delayHours: 1, expected: "2026-11-20T13:00:00.000Z" },
    { delayHours: 48, expected: "2026-11-21T11:00:00.000Z" },
    { delayHours: Number.NaN, expected: "2026-11-21T11:00:00.000Z" },
  ])("keeps $delayHours hours within 1 to 23", ({ delayHours, expected }) => {
    const fireAt = reminderFireAt({
      pitchSentAt: NOW,
      lastInteractionAt: NOW,
      delayHours,
    });
    expect(new Date(fireAt).toISOString()).toBe(expected);
  });

  it("accepts Date and epoch milliseconds alike", () => {
    expect(
      reminderFireAt({
        pitchSentAt: new Date(NOW),
        lastInteractionAt: new Date(NOW),
        delayHours: 5,
      })
    ).toBe(reminderFireAt({ pitchSentAt: NOW, lastInteractionAt: NOW, delayHours: 5 }));
  });
});

// A campaign can start its offer 22 hours after the link (A-037), while
// Instagram's window, 24 hours from the tap or DM, is still open.
describe("late offer start", () => {
  it("takes 22 hours, and campaigns know only right away and late", () => {
    expect(OFFER_LATE_START_HOURS).toBe(22);
    expect(OFFER_DELAY_HOURS).toEqual([0, 22]);
  });

  it("starts late only for the late value", () => {
    expect(offerStartsLate(22)).toBe(true);
    for (const value of [0, 1, 21, 23, 24, -22, 22.5, Number.NaN, null, undefined]) {
      expect(offerStartsLate(value)).toBe(false);
    }
  });

  it("fires 22 hours after the tap, rounded down to a half hour in UTC", () => {
    // 12:10 + 22 h = 10:10 the next day, rounded down to 10:00.
    expect(new Date(lateStartFireAt(NOW)).toISOString()).toBe(
      "2026-11-21T10:00:00.000Z"
    );
  });

  it("never fires later than 22 hours after the tap, and less than half an hour earlier", () => {
    for (const minute of [0, 1, 29, 30, 31, 59]) {
      for (const second of [0, 1, 59]) {
        const tap =
          Date.parse("2026-11-20T08:00:00.000Z") + minute * MINUTE + second * 1000;
        const fireAt = lateStartFireAt(tap);
        expect(fireAt % (30 * MINUTE)).toBe(0);
        expect(fireAt).toBeLessThanOrEqual(tap + 22 * HOUR);
        expect(fireAt).toBeGreaterThan(tap + 22 * HOUR - 30 * MINUTE);
        // Inside the window, with the margin every send keeps, and with
        // room for the retries 5 and 15 minutes later.
        expect(withinWindow(tap, fireAt + 20 * MINUTE)).toBe(true);
      }
    }
  });

  it("keeps a tap on the half hour exactly 22 hours", () => {
    const tap = Date.parse("2026-11-20T08:30:00.000Z");
    expect(lateStartFireAt(tap)).toBe(tap + 22 * HOUR);
  });

  it("accepts Date and epoch milliseconds alike", () => {
    expect(lateStartFireAt(new Date(NOW))).toBe(lateStartFireAt(NOW));
    expect(lateStartDelayMs(new Date(NOW), NOW)).toBe(lateStartDelayMs(NOW, NOW));
  });

  it("waits until the fire time", () => {
    expect(lateStartDelayMs(NOW, NOW)).toBe(
      Date.parse("2026-11-21T10:00:00.000Z") - NOW
    );
    // Queued a while after the tap, it still fires on the same half hour.
    expect(NOW + 5 * MINUTE + lateStartDelayMs(NOW, NOW + 5 * MINUTE)).toBe(
      lateStartFireAt(NOW)
    );
  });

  it("does not wait once the fire time has passed", () => {
    expect(lateStartDelayMs(NOW - 22 * HOUR, NOW)).toBe(0);
    expect(lateStartDelayMs(NOW - 23 * HOUR, NOW)).toBe(0);
    expect(lateStartDelayMs(NOW - 3 * 24 * HOUR, NOW)).toBe(0);
  });

  it("reads the clock when no time is given", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(NOW);
      expect(lateStartDelayMs(NOW)).toBe(lateStartDelayMs(NOW, NOW));
    } finally {
      vi.useRealTimers();
    }
  });
});

// The campaign editor warns that the follow-up message can land between the
// offer messages only where it can (G1 leftover). The follow-up goes out
// followUpDelayMinutes (0 to 1440) after the link, the link moments after the
// tap or DM, a late offer 21.5 to 22 hours after that tap or DM.
describe("followUpCanMeetOffer", () => {
  it("always can with an offer right after the link", () => {
    for (const minutes of [0, 1, 60, LATE_OFFER_FOLLOW_UP_LIMIT_MINUTES, 1440]) {
      expect(followUpCanMeetOffer(0, minutes), String(minutes)).toBe(true);
    }
    // Anything but the late value starts the offer right away.
    expect(followUpCanMeetOffer(5, 10)).toBe(true);
    expect(followUpCanMeetOffer(null, 10)).toBe(true);
  });

  it("can with a late offer only when the follow-up waits more than 21 hours", () => {
    expect(LATE_OFFER_FOLLOW_UP_LIMIT_MINUTES).toBe(21 * 60);
    for (const minutes of [0, 5, 60, 600, 1200, LATE_OFFER_FOLLOW_UP_LIMIT_MINUTES]) {
      expect(followUpCanMeetOffer(OFFER_LATE_START_HOURS, minutes), String(minutes)).toBe(false);
    }
    for (const minutes of [LATE_OFFER_FOLLOW_UP_LIMIT_MINUTES + 1, 1290, 1320, 1440]) {
      expect(followUpCanMeetOffer(OFFER_LATE_START_HOURS, minutes), String(minutes)).toBe(true);
    }
  });

  it("leaves a follow-up within the limit before every late start, with half an hour for the link", () => {
    for (let minute = 0; minute < 60; minute++) {
      for (const second of [0, 59]) {
        const tap = Date.parse("2026-11-20T08:00:00.000Z") + minute * MINUTE + second * 1000;
        // The link out half an hour after the tap, the follow-up at the limit.
        const followUpAt = tap + 30 * MINUTE + LATE_OFFER_FOLLOW_UP_LIMIT_MINUTES * MINUTE;
        expect(followUpAt).toBeLessThan(lateStartFireAt(tap));
      }
    }
  });

  it("can meet a late start once it waits longer", () => {
    // A tap at 08:29:59 starts its offer at 06:00 the next day, 21.5 hours
    // and a second later; a follow-up 1291 minutes after a link sent within
    // a second of the tap comes after that.
    const tap = Date.parse("2026-11-20T08:29:59.000Z");
    expect(lateStartFireAt(tap)).toBe(Date.parse("2026-11-21T06:00:00.000Z"));
    expect(tap + 1000 + 1291 * MINUTE).toBeGreaterThan(lateStartFireAt(tap));
    expect(followUpCanMeetOffer(OFFER_LATE_START_HOURS, 1291)).toBe(true);
  });
});

describe("offerStartKey", () => {
  it("names the campaign, how the link went out and the trigger's id", () => {
    expect(offerStartKey("auto_1", "tap", "mid_1")).toBe("auto_1:tap:mid_1");
    expect(offerStartKey("auto_1", "dm", "mid_1")).not.toBe(
      offerStartKey("auto_1", "tap", "mid_1")
    );
  });
});

describe("offerJobId", () => {
  it("builds ids BullMQ accepts", () => {
    const ids = [
      offerJobId.start("auto_1", "17841400000000001", "abc123"),
      offerJobId.step("co1", "offer", 0),
      offerJobId.step("co1", "confirm", 2),
      offerJobId.card("co1"),
      offerJobId.reminder("co1"),
      // The confirmation of a reported sign-up: one per row.
      offerJobId.signup("co1"),
    ];

    expect(ids).toEqual([
      "offerstart_auto_1_17841400000000001_abc123",
      "offer_co1_offer_0",
      "offer_co1_confirm_2",
      "offer_co1_card",
      "offer_co1_reminder",
      "offer_co1_signup",
    ]);
    for (const id of ids) expect(id).not.toContain(":");
  });
});

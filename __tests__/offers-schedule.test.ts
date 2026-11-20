/**
 * Order, window and reminder timing of lead-magnet offers.
 *
 * Instagram only lets a business message someone within 24 hours of their
 * last tap or DM, so the reminder has to land inside that window even after
 * BullMQ's retries, and every send checks the window with a safety margin.
 */

import { describe, expect, it } from "vitest";
import {
  OFFER_ORDER,
  offerJobId,
  offerStartKey,
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
    ];

    expect(ids).toEqual([
      "offerstart_auto_1_17841400000000001_abc123",
      "offer_co1_offer_0",
      "offer_co1_confirm_2",
      "offer_co1_card",
      "offer_co1_reminder",
    ]);
    for (const id of ids) expect(id).not.toContain(":");
  });
});

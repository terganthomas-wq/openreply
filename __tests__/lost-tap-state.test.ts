/**
 * The rules of the search for lost taps after a messaging silence (A2
 * requirement 4) that need no database: which message of a conversation is a
 * lost tap (the button's title, from the person, newer than their opening
 * DM; not someone else's, never the account's own), what the tap would have
 * set off (the payload the worker sends with each button), the 24-hour
 * window with its hour of margin, and the stored shapes read back.
 */
import { describe, expect, it } from "vitest";
import {
  campaignOfTapPayload,
  findLostTaps,
  LOST_TAP_READ_GAP_MS,
  LOST_TAP_SPACING_MS,
  lostTapSearchJobId,
  readLostTapProgress,
  readLostTapResult,
  tapButton,
  tapPayload,
  tapWindowOpen,
  type ConversationMessage,
  type TapCampaign,
} from "../lib/instagram/lost-tap-state";
import { CATCH_UP_SPACING_MS } from "../lib/instagram/catch-up-state";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const PERSON = "17841400000000001";
const ACCOUNT = "17841499999999999";
const OPENING = Date.parse("2026-11-25T20:49:23.000Z");

function campaign(overrides: Partial<TapCampaign> = {}): TapCampaign {
  return {
    automationId: "campaign_guide",
    openingDmAt: OPENING,
    requireFollow: false,
    openingDmButtonLabel: "Ja, schick ihn mir",
    followPromptButtonLabel: null,
    followPromptRetryButtonLabel: null,
    ...overrides,
  };
}

// A message as the Conversations API gives it: Meta's own time format.
function message(
  id: string,
  text: string,
  iso: string,
  from: string = PERSON
): ConversationMessage {
  return {
    id,
    message: text,
    created_time: iso.replace(".000Z", "+0000"),
    from: { id: from },
  };
}

describe("a lost tap in a conversation", () => {
  it("is a message from the person whose text is the opening DM's button, newer than the opening DM", () => {
    const messages = [
      // Newest first, as Meta answers.
      message("m_tap", "Ja, schick ihn mir", "2026-11-25T20:51:10.000Z"),
      message("m_opening", "Hey! Magst du den Guide?", "2026-11-25T20:49:23.000Z", ACCOUNT),
    ];
    expect(findLostTaps(PERSON, [campaign()], messages)).toEqual([
      {
        automationId: "campaign_guide",
        messageId: "m_tap",
        tappedAt: Date.parse("2026-11-25T20:51:10.000Z"),
        payload: "reveal:campaign_guide:open",
      },
    ]);
  });

  it("is not one from before the opening DM, from someone else, or from the account itself", () => {
    const messages = [
      message("m_other", "Ja, schick ihn mir", "2026-11-25T21:00:00.000Z", "17841400000000002"),
      message("m_own", "Ja, schick ihn mir", "2026-11-25T21:01:00.000Z", ACCOUNT),
      message("m_before", "Ja, schick ihn mir", "2026-11-25T20:40:00.000Z"),
      message("m_same_second", "Ja, schick ihn mir", "2026-11-25T20:49:23.000Z"),
      message("m_text", "Danke, kommt da noch was?", "2026-11-25T22:00:00.000Z"),
      { id: "m_no_time", message: "Ja, schick ihn mir", from: { id: PERSON } },
      { message: "Ja, schick ihn mir", created_time: "2026-11-25T22:01:00+0000", from: { id: PERSON } },
      { id: "m_no_from", message: "Ja, schick ihn mir", created_time: "2026-11-25T22:02:00+0000" },
    ];
    expect(findLostTaps(PERSON, [campaign()], messages)).toEqual([]);
  });

  it("is the button's title as the button showed it: Meta keeps 20 characters, spaces do not count", () => {
    const long = campaign({ openingDmButtonLabel: "Ja bitte, schick mir den Guide" });
    expect(tapButton(long, "Ja bitte, schick mir")).toBe("open");
    expect(tapButton(long, "Ja bitte, schick mir den Guide")).toBe("open");
    expect(tapButton(campaign(), "  Ja,  schick ihn mir ")).toBe("open");
    // Equal, not similar.
    expect(tapButton(campaign(), "ja, schick ihn mir")).toBeNull();
    expect(tapButton(campaign(), "Ja")).toBeNull();
    expect(tapButton(campaign(), "")).toBeNull();
    expect(tapButton(campaign({ openingDmButtonLabel: null }), "Ja, schick ihn mir")).toBeNull();
  });

  it("can be on a follow prompt's button, which only a campaign with the follow gate has", () => {
    const gated = campaign({
      requireFollow: true,
      followPromptButtonLabel: "Ich folge dir",
      followPromptRetryButtonLabel: "Jetzt aber",
    });
    expect(tapButton(gated, "Ja, schick ihn mir")).toBe("open");
    expect(tapButton(gated, "Ich folge dir")).toBe("follow");
    expect(tapButton(gated, "Jetzt aber")).toBe("retry");
    // The worker's defaults when the campaign names none.
    expect(tapButton(campaign({ requireFollow: true }), "i'm following")).toBe("follow");
    expect(tapButton(campaign({ requireFollow: false }), "i'm following")).toBeNull();
    // The opening DM's button wins a tie.
    expect(tapButton(campaign({ requireFollow: true, followPromptButtonLabel: "Ja, schick ihn mir" }), "Ja, schick ihn mir")).toBe("open");
  });

  it("would have set off exactly the postback of the button the worker sent", () => {
    const open = { automationId: "c1", requireFollow: false };
    const gated = { automationId: "c1", requireFollow: true };
    expect(tapPayload(open, "open")).toBe("reveal:c1:open");
    expect(tapPayload(gated, "open")).toBe("followcheck:c1:open");
    expect(tapPayload(gated, "follow")).toBe("followcheck:c1");
    expect(tapPayload(gated, "retry")).toBe("followcheck:c1:retry");
    for (const payload of ["reveal:c1", "reveal:c1:open", "followcheck:c1", "followcheck:c1:open", "followcheck:c1:retry"]) {
      expect(campaignOfTapPayload(payload), payload).toBe("c1");
    }
    for (const payload of ["offer:o1:yes", "reveal:", "c1", null, 3]) {
      expect(campaignOfTapPayload(payload)).toBeNull();
    }
  });

  it("is the newest tap of the campaign when the person tapped more than once", () => {
    const gated = campaign({ requireFollow: true });
    const taps = findLostTaps(PERSON, [gated], [
      message("m_third", "Ja, schick ihn mir", "2026-11-26T07:30:00.000Z"),
      message("m_second", "Ja, schick ihn mir", "2026-11-25T23:00:00.000Z"),
      message("m_first", "Ja, schick ihn mir", "2026-11-25T20:51:00.000Z"),
    ]);
    expect(taps).toEqual([
      {
        automationId: "campaign_guide",
        messageId: "m_third",
        tappedAt: Date.parse("2026-11-26T07:30:00.000Z"),
        payload: "followcheck:campaign_guide:open",
      },
    ]);
  });

  it("belongs to the campaign whose opening DM came last before it when two buttons say the same", () => {
    const first = campaign({ automationId: "c_first", openingDmAt: OPENING });
    const second = campaign({ automationId: "c_second", openingDmAt: OPENING + 2 * HOUR });
    const taps = findLostTaps(PERSON, [first, second], [
      message("m_late", "Ja, schick ihn mir", "2026-11-25T23:00:00.000Z"),
      message("m_early", "Ja, schick ihn mir", "2026-11-25T21:00:00.000Z"),
    ]);
    // Oldest first.
    expect(taps.map((tap) => [tap.automationId, tap.messageId])).toEqual([
      ["c_first", "m_early"],
      ["c_second", "m_late"],
    ]);
  });
});

describe("the window a tap opened", () => {
  const tappedAt = Date.parse("2026-11-25T21:00:00.000Z");

  it("is continued while Instagram's 24 hours leave at least an hour when the job runs", () => {
    expect(tapWindowOpen(tappedAt, tappedAt + 23 * HOUR)).toBe(true);
    expect(tapWindowOpen(tappedAt, tappedAt + 23 * HOUR + 1)).toBe(false);
    expect(tapWindowOpen(tappedAt, tappedAt + 10 * HOUR)).toBe(true);
    expect(tapWindowOpen(tappedAt, tappedAt + 25 * HOUR)).toBe(false);
  });
});

describe("the pacing", () => {
  it("keeps the reads at least 2 seconds apart and the continued taps at A1's pace", () => {
    expect(LOST_TAP_READ_GAP_MS).toBeGreaterThanOrEqual(2_000);
    expect(LOST_TAP_SPACING_MS).toBe(CATCH_UP_SPACING_MS);
  });
});

describe("what is stored", () => {
  it("names the search's job by the account, the silence's start and end, and a continuation by its time", () => {
    const from = new Date("2026-11-25T13:15:16.000Z");
    const until = new Date("2026-11-26T10:30:57.000Z");
    expect(lostTapSearchJobId("account_1", from, until)).toBe(
      `losttaps_account_1_${from.getTime()}_${until.getTime()}`
    );
    expect(lostTapSearchJobId("account_1", from, until, 1795689657000.7)).toBe(
      `losttaps_account_1_${from.getTime()}_${until.getTime()}_1795689657000`
    );
    expect(lostTapSearchJobId("account_1", from, until)).not.toContain(":");
  });

  it("reads back only what this version wrote", () => {
    const progress = {
      v: 1,
      from: "2026-11-25T13:15:16.000Z",
      until: "2026-11-26T10:30:57.000Z",
      startedAt: "2026-11-26T10:31:00.000Z",
      people: [
        {
          userId: "p1",
          username: "anna",
          campaigns: [{ automationId: "c1", openingDmAt: "2026-11-25T20:49:23.000Z" }],
          conversationId: "conv_1",
          conversationUpdatedAt: "2026-11-25T20:51:10.000Z",
          done: true,
        },
        { userId: "p2", campaigns: [] },
        { username: "nobody" },
      ],
      total: 3,
      answered: 1,
      list: { after: "cursor", pageSize: 999, pages: 2, done: true, blind: false },
      reads: 3,
      found: [{ userId: "p1" }],
      continued: [],
      listed: [{ campaign: "Guide", tappedAt: "2026-11-25T20:51:10.000Z", reason: "other" }],
      noTap: 1,
      notChecked: -2,
      stops: 1,
      resumeAt: "later",
      gaveUp: false,
    };
    expect(readLostTapProgress(progress)).toEqual({
      ...progress,
      people: [progress.people[0]],
      list: { after: "cursor", pageSize: 50, pages: 2, done: true, blind: false },
      found: [],
      listed: [{ username: null, campaign: "Guide", tappedAt: "2026-11-25T20:51:10.000Z", reason: "window" }],
      notChecked: 0,
      resumeAt: null,
    });
    for (const odd of [null, [], { v: 2 }, { ...progress, from: "x" }, { ...progress, until: null }]) {
      expect(readLostTapProgress(odd)).toBeNull();
    }
    expect(readLostTapResult({ v: 1, finishedAt: "2026-11-26T10:40:00.000Z", notChecked: 2 })).toMatchObject({
      continued: 0,
      listed: [],
      notChecked: 2,
      complete: false,
    });
    expect(readLostTapResult({ v: 1, finishedAt: "2026-11-26T10:40:00.000Z" })?.complete).toBe(true);
    expect(readLostTapResult({ v: 1, finishedAt: "2026-11-26T10:40:00.000Z", gaveUp: true })?.complete).toBe(false);
    expect(readLostTapResult({ v: 1 })).toBeNull();
  });
});

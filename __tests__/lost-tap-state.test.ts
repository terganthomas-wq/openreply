/**
 * The rules of the search for lost taps after a messaging silence (A2
 * requirement 4) that need no database: which message of a conversation is a
 * lost tap (the button's title, from the person, newer than their opening
 * DM and the silence's start; not someone else's, never the account's own),
 * which campaign it goes to when buttons say the same, which messages after
 * it someone else wrote, what the tap would have set off (the payload the
 * worker sends with each button), the 24-hour window with its hour of margin,
 * and the stored shapes read back.
 */
import { describe, expect, it } from "vitest";
import {
  campaignOfTapPayload,
  findLostTaps,
  LOST_TAP_READ_GAP_MS,
  LOST_TAP_SPACING_MS,
  lostTapSearchJobId,
  mergeLostTapResults,
  OWN_SEND_TOLERANCE_MS,
  readLostTapProgress,
  readLostTapResult,
  tapButton,
  tapPayload,
  tapWindowOpen,
  unexplainedReplies,
  type ConversationMessage,
  type LostTapResult,
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

  it("gives two taps after two opening DMs whose buttons say the same one campaign each, the newest to the latest DM", () => {
    const first = campaign({ automationId: "c_first", openingDmAt: OPENING });
    const second = campaign({ automationId: "c_second", openingDmAt: OPENING + 16 * MINUTE });
    const taps = findLostTaps(PERSON, [first, second], [
      message("m_2", "Ja, schick ihn mir", "2026-11-26T07:31:00.000Z"),
      message("m_1", "Ja, schick ihn mir", "2026-11-26T07:30:00.000Z"),
    ]);
    expect(taps).toEqual([
      {
        automationId: "c_first",
        messageId: "m_1",
        tappedAt: Date.parse("2026-11-26T07:30:00.000Z"),
        payload: "reveal:c_first:open",
      },
      {
        automationId: "c_second",
        messageId: "m_2",
        tappedAt: Date.parse("2026-11-26T07:31:00.000Z"),
        payload: "reveal:c_second:open",
      },
    ]);
  });

  it("gives one tap after two such DMs to the latest, and marks the other campaign as unclear instead of dropping it", () => {
    const first = campaign({ automationId: "c_first", openingDmAt: OPENING });
    const second = campaign({ automationId: "c_second", openingDmAt: OPENING + 16 * MINUTE });
    const taps = findLostTaps(PERSON, [first, second], [
      message("m_1", "Ja, schick ihn mir", "2026-11-26T07:30:00.000Z"),
    ]);
    expect(taps).toEqual([
      {
        automationId: "c_second",
        messageId: "m_1",
        tappedAt: Date.parse("2026-11-26T07:30:00.000Z"),
        payload: "reveal:c_second:open",
      },
      {
        automationId: "c_first",
        messageId: "m_1",
        tappedAt: Date.parse("2026-11-26T07:30:00.000Z"),
        payload: "reveal:c_first:open",
        unclear: true,
      },
    ]);
    // Three taps for two campaigns: the oldest is a repeat, nothing unclear.
    expect(
      findLostTaps(PERSON, [first, second], [
        message("m_3", "Ja, schick ihn mir", "2026-11-26T07:32:00.000Z"),
        message("m_2", "Ja, schick ihn mir", "2026-11-26T07:31:00.000Z"),
        message("m_1", "Ja, schick ihn mir", "2026-11-26T07:30:00.000Z"),
      ]).map((tap) => [tap.automationId, tap.messageId, tap.unclear ?? false])
    ).toEqual([
      ["c_first", "m_2", false],
      ["c_second", "m_3", false],
    ]);
  });

  it("counts only taps in the silence, for an opening DM from before it", () => {
    const before = campaign({ openingDmAt: Date.parse("2026-11-24T22:17:34.000Z") });
    const messages = [
      message("m_in", "Ja, schick ihn mir", "2026-11-25T16:02:00.000Z"),
      message("m_before", "Ja, schick ihn mir", "2026-11-25T10:00:00.000Z"),
    ];
    const silenceFrom = Date.parse("2026-11-25T13:15:16.000Z");
    expect(findLostTaps(PERSON, [before], messages, { after: silenceFrom }).map((tap) => tap.messageId)).toEqual([
      "m_in",
    ]);
    expect(findLostTaps(PERSON, [before], messages.slice(1), { after: silenceFrom })).toEqual([]);
  });
});

describe("who wrote after a tap", () => {
  const TAP = Date.parse("2026-11-25T20:51:10.000Z");
  const at = (iso: string) => Date.parse(iso);

  it("is anyone but the person, newer than the tap, that OpenReply's own sends do not explain", () => {
    const messages = [
      message("m_hand", "Sorry, hier ist dein Guide", "2026-11-26T09:41:00.000Z", ACCOUNT),
      message("m_dm", "Magst du den Dach-Guide?", "2026-11-26T07:00:00.000Z", ACCOUNT),
      message("m_person", "Hallo? Der Link kommt nicht", "2026-11-26T08:10:00.000Z"),
      message("m_tap", "Ja, schick ihn mir", "2026-11-25T20:51:10.000Z"),
      message("m_opening", "Hey! Magst du den Guide?", "2026-11-25T20:49:23.000Z", ACCOUNT),
    ];
    // Another campaign's opening DM, recorded a second after Instagram took it.
    const own = [{ from: at("2026-11-26T07:00:01.000Z"), until: at("2026-11-26T07:00:01.000Z"), count: 1 }];
    expect(unexplainedReplies(PERSON, TAP, messages, own).map((item) => item.id)).toEqual(["m_hand"]);
    expect(unexplainedReplies(PERSON, TAP, messages.slice(1), own)).toEqual([]);
    // Without any record, both are someone else's.
    expect(unexplainedReplies(PERSON, TAP, messages, []).map((item) => item.id)).toEqual(["m_dm", "m_hand"]);
  });

  it("explains each message once: a stretch of own sends explains at most as many as it sent, within two minutes of it", () => {
    const offer = { from: at("2026-11-26T08:00:00.000Z"), until: at("2026-11-26T08:00:10.000Z"), count: 2 };
    const three = [
      message("m_3", "Magst du den Prompt-Guide?", "2026-11-26T08:00:10.000Z", ACCOUNT),
      message("m_2", "Hier ist dein Guide", "2026-11-26T08:00:05.000Z", ACCOUNT),
      message("m_1", "Hey, noch was für dich!", "2026-11-26T08:00:00.000Z", ACCOUNT),
    ];
    expect(unexplainedReplies(PERSON, TAP, three, [offer])).toHaveLength(1);
    expect(unexplainedReplies(PERSON, TAP, three.slice(0, 2), [offer])).toEqual([]);
    expect(OWN_SEND_TOLERANCE_MS).toBe(2 * MINUTE);
    const late = [message("m_late", "Hey", new Date(offer.until + OWN_SEND_TOLERANCE_MS + 1_000).toISOString(), ACCOUNT)];
    expect(unexplainedReplies(PERSON, TAP, late, [offer])).toHaveLength(1);
  });

  it("takes a message without its time or its sender for someone else's", () => {
    const odd: ConversationMessage[] = [
      { id: "m_no_time", message: "Hier", from: { id: ACCOUNT } },
      { id: "m_no_from", message: "Hier", created_time: "2026-11-26T09:00:00+0000" },
    ];
    expect(unexplainedReplies(PERSON, TAP, odd, [{ from: 0, until: Infinity, count: 10 }]).map((item) => item.id)).toEqual([
      "m_no_time",
    ]);
    expect(unexplainedReplies(PERSON, TAP, odd, []).map((item) => item.id).sort()).toEqual(["m_no_from", "m_no_time"]);
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

  it("reads back the reasons and the taps that are only listed", () => {
    for (const reason of ["window", "campaign", "replied", "unclear"] as const) {
      expect(
        readLostTapResult({
          v: 1,
          finishedAt: "2026-11-26T10:40:00.000Z",
          listed: [{ campaign: "Guide", tappedAt: "2026-11-25T20:51:10.000Z", reason }],
        })?.listed[0].reason
      ).toBe(reason);
    }
    const found = {
      userId: "p1",
      automationId: "c1",
      messageId: "m1",
      payload: "reveal:c1:open",
      tappedAt: "2026-11-25T20:51:10.000Z",
      openingDmAt: "2026-11-25T20:49:23.000Z",
    };
    const progress = (listOnly: unknown) =>
      readLostTapProgress({
        v: 1,
        from: "2026-11-25T13:15:16.000Z",
        until: "2026-11-26T10:30:57.000Z",
        startedAt: "2026-11-26T10:31:00.000Z",
        found: [{ ...found, listOnly }],
      })?.found[0];
    expect(progress("replied")?.listOnly).toBe("replied");
    expect(progress("unclear")?.listOnly).toBe("unclear");
    expect(progress("other")).not.toHaveProperty("listOnly");
  });

  it("joins two finished searches for one report", () => {
    const result = (overrides: Partial<LostTapResult>): LostTapResult => ({
      v: 1,
      finishedAt: "2026-11-26T14:00:00.000Z",
      people: 2,
      continued: 1,
      firstJobAt: "2026-11-26T14:00:00.000Z",
      lastJobAt: "2026-11-26T14:00:00.000Z",
      listed: [{ username: "gerd", campaign: "Guide", tappedAt: "2026-11-25T13:21:00.000Z", reason: "window" }],
      noTap: 1,
      answered: 0,
      notChecked: 0,
      reads: 3,
      gaveUp: false,
      complete: true,
      ...overrides,
    });
    const earlier = result({});
    const later = result({
      finishedAt: "2026-11-27T09:01:00.000Z",
      firstJobAt: "2026-11-27T09:01:00.000Z",
      lastJobAt: "2026-11-27T09:03:30.000Z",
      listed: [
        { username: "gerd", campaign: "Guide", tappedAt: "2026-11-25T13:21:00.000Z", reason: "window" },
        { username: "ida", campaign: "Guide", tappedAt: "2026-11-27T01:00:00.000Z", reason: "replied" },
      ],
      notChecked: 1,
      complete: false,
    });
    expect(mergeLostTapResults(earlier, later)).toEqual({
      v: 1,
      finishedAt: "2026-11-27T09:01:00.000Z",
      people: 4,
      continued: 2,
      firstJobAt: "2026-11-26T14:00:00.000Z",
      lastJobAt: "2026-11-27T09:03:30.000Z",
      listed: [
        { username: "gerd", campaign: "Guide", tappedAt: "2026-11-25T13:21:00.000Z", reason: "window" },
        { username: "ida", campaign: "Guide", tappedAt: "2026-11-27T01:00:00.000Z", reason: "replied" },
      ],
      noTap: 2,
      answered: 0,
      notChecked: 1,
      reads: 6,
      gaveUp: false,
      complete: false,
    });
  });
});

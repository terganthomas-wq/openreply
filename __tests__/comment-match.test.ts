/**
 * Which campaign answers a comment (lib/automation/comment-match.ts): the one
 * rule the worker, the sweep and the Kommentare page share, so the campaign
 * the page preselects is the one the worker would have sent.
 */
import { describe, expect, it } from "vitest";
import {
  boundCampaignsFirst,
  campaignForComment,
  isBoundToMedia,
  matchCommentToCampaign,
} from "../lib/automation/comment-match";

function campaign(overrides: Partial<Parameters<typeof campaignForComment>[0][number]> & { id: string }) {
  return {
    postId: null,
    matchAnyPost: true,
    isActive: true,
    keywords: ["GUIDE"],
    matchAnyWord: false,
    wholeWordMatch: true,
    ignoreQuestionComments: false,
    ...overrides,
  };
}

describe("matchCommentToCampaign", () => {
  it("needs the keyword as a whole word unless partial matches are allowed", () => {
    const whole = campaign({ id: "a" });
    expect(matchCommentToCampaign(whole, "Guide bitte")).toEqual({
      matched: true,
      matchedKeyword: "GUIDE",
    });
    // The keyword inside a longer word: the case the manual send is for.
    expect(matchCommentToCampaign(whole, "Guidebitte").matched).toBe(false);
    expect(
      matchCommentToCampaign({ ...whole, wholeWordMatch: false }, "Guidebitte").matched
    ).toBe(true);
  });

  it("leaves questions to a human when the campaign says so, by the raw text", () => {
    const filtered = campaign({ id: "a", ignoreQuestionComments: true });
    expect(matchCommentToCampaign(filtered, "Ist der GUIDE kostenlos?").matched).toBe(false);
    expect(matchCommentToCampaign(filtered, "GUIDE ¿").matched).toBe(false);
    expect(matchCommentToCampaign(filtered, "GUIDE bitte").matched).toBe(true);
    expect(
      matchCommentToCampaign({ ...filtered, ignoreQuestionComments: false }, "GUIDE?")
        .matched
    ).toBe(true);
  });

  it("answers every comment for any word, without a keyword", () => {
    const any = campaign({ id: "a", matchAnyWord: true, keywords: [] });
    expect(matchCommentToCampaign(any, "kallt")).toEqual({
      matched: true,
      matchedKeyword: null,
    });
    // The question filter still comes first.
    expect(
      matchCommentToCampaign({ ...any, ignoreQuestionComments: true }, "wie?").matched
    ).toBe(false);
  });
});

describe("campaignForComment", () => {
  it("picks the campaign bound to the post before an older any-post campaign", () => {
    const anyPost = campaign({ id: "any" });
    const thisPost = campaign({ id: "post", matchAnyPost: false, postId: "media_1" });
    expect(
      campaignForComment([anyPost, thisPost], { text: "GUIDE", mediaId: "media_1" })
        ?.campaign.id
    ).toBe("post");
    // Another post: only the any-post campaign covers it.
    expect(
      campaignForComment([anyPost, thisPost], { text: "GUIDE", mediaId: "media_2" })
        ?.campaign.id
    ).toBe("any");
  });

  it("keeps the oldest first within a group, and skips what does not match", () => {
    const older = campaign({ id: "older", keywords: ["LINK"] });
    const newer = campaign({ id: "newer" });
    const newest = campaign({ id: "newest" });
    expect(
      campaignForComment([older, newer, newest], { text: "GUIDE", mediaId: "m" })
        ?.campaign.id
    ).toBe("newer");
  });

  it("never picks a paused campaign on its own, and finds none for an unmatched text", () => {
    const paused = campaign({ id: "paused", isActive: false });
    expect(campaignForComment([paused], { text: "GUIDE", mediaId: "m" })).toBeNull();
    expect(
      campaignForComment([campaign({ id: "a" })], { text: "kallt", mediaId: "m" })
    ).toBeNull();
  });

  it("counts a campaign bound to the post an ad was made from", () => {
    const bound = campaign({ id: "post", matchAnyPost: false, postId: "post_1" });
    expect(
      campaignForComment([bound], {
        text: "GUIDE",
        mediaId: "ad_1",
        originalMediaId: "post_1",
      })?.campaign.id
    ).toBe("post");
    expect(isBoundToMedia("post_1", "ad_1", "post_1")).toBe(true);
    expect(isBoundToMedia(null, "ad_1", null)).toBe(false);
  });

  it("orders without changing the list it was given", () => {
    const list = [campaign({ id: "any" }), campaign({ id: "post", postId: "m" })];
    expect(boundCampaignsFirst(list, "m").map((c) => c.id)).toEqual(["post", "any"]);
    expect(list.map((c) => c.id)).toEqual(["any", "post"]);
  });
});

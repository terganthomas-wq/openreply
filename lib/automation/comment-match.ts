/**
 * Which campaign answers a comment.
 *
 * One rule for every place that asks: the DM worker (processComment), which
 * sends; the comment sweep, which queues what the worker would answer; and
 * the Kommentare page, which preselects the campaign a manual send uses. They
 * must agree, or the page offers one campaign while the worker would have
 * sent another.
 *
 * - A campaign covers a comment when it is bound to the comment's post
 *   (postId is the comment's media, or the post an ad was made from) or
 *   matches any post. Only active campaigns answer on their own.
 * - A campaign may leave questions to a human (ignoreQuestionComments). The
 *   raw text is checked: the keyword matcher turns the question mark into a
 *   space.
 * - "Any word" campaigns match every comment; the others need a keyword,
 *   as a whole word unless the campaign allows partial matches.
 * - Campaigns bound to the post go before any-post campaigns: only the first
 *   one to send can use the comment's one private reply, and a campaign set
 *   up for this very post is the one meant to answer it. Bound is read from
 *   postId, not matchAnyPost, which an edit can leave set next to a post. The
 *   order is stable otherwise, so the oldest campaign of each group stays
 *   first (callers load campaigns oldest first).
 *
 * No database or queue import: the page's server code and the tests use it
 * as it is.
 */

import { isQuestionComment } from "./question-filter";
import {
  matchKeywords,
  type KeywordMatchResult,
} from "@/lib/utils/keyword-matcher";

export interface MatchableCampaign {
  keywords: string[];
  matchAnyWord: boolean;
  wholeWordMatch: boolean;
  ignoreQuestionComments: boolean;
}

export interface CoveringCampaign extends MatchableCampaign {
  postId: string | null;
  matchAnyPost: boolean;
  isActive: boolean;
}

const NO_MATCH: KeywordMatchResult = { matched: false, matchedKeyword: null };

/**
 * Whether the campaign answers this comment text: not a question it leaves to
 * a human, and a keyword (or any word) that matches. The keyword is null for
 * "any word" campaigns.
 */
export function matchCommentToCampaign(
  campaign: MatchableCampaign,
  text: string
): KeywordMatchResult {
  if (campaign.ignoreQuestionComments && isQuestionComment(text)) {
    return NO_MATCH;
  }
  if (campaign.matchAnyWord) return { matched: true, matchedKeyword: null };
  return matchKeywords(text, campaign.keywords, campaign.wholeWordMatch);
}

/** The campaign is bound to the comment's post, or to the post its ad copies. */
export function isBoundToMedia(
  postId: string | null,
  mediaId: string,
  originalMediaId?: string | null
): boolean {
  return (
    Boolean(postId) &&
    (postId === mediaId || (Boolean(originalMediaId) && postId === originalMediaId))
  );
}

/** Campaigns bound to the comment's post first, otherwise in the given order. */
export function boundCampaignsFirst<T extends { postId: string | null }>(
  campaigns: T[],
  mediaId: string,
  originalMediaId?: string | null
): T[] {
  return [...campaigns].sort(
    (a, b) =>
      Number(isBoundToMedia(b.postId, mediaId, originalMediaId)) -
      Number(isBoundToMedia(a.postId, mediaId, originalMediaId))
  );
}

/**
 * The campaign that would answer a comment on its own, as the worker picks
 * it: among the active campaigns that cover the comment's post, bound ones
 * first, the first whose keywords match. Null when none would.
 */
export function campaignForComment<T extends CoveringCampaign>(
  campaigns: T[],
  comment: { text: string; mediaId: string; originalMediaId?: string | null }
): { campaign: T; matchedKeyword: string | null } | null {
  const covering = campaigns.filter(
    (campaign) =>
      campaign.isActive &&
      (campaign.matchAnyPost ||
        isBoundToMedia(campaign.postId, comment.mediaId, comment.originalMediaId))
  );
  for (const campaign of boundCampaignsFirst(
    covering,
    comment.mediaId,
    comment.originalMediaId
  )) {
    const match = matchCommentToCampaign(campaign, comment.text);
    if (match.matched) {
      return { campaign, matchedKeyword: match.matchedKeyword };
    }
  }
  return null;
}

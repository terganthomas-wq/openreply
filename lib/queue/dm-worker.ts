import {
  classifySendError,
  hasLegacyUnconfirmedDelivery,
  isConfirmedSendRejection,
  isDeliveryUnconfirmed,
  isMetaThrottle,
} from "@/lib/instagram/delivery-errors";
import {
  claimCommentDelivery,
  MAX_COMMENT_SEND_ATTEMPTS,
  privateReplyTaken,
  releaseCommentClaim,
} from "./comment-delivery";
import {
  AccountPausedError,
  checkAccountPause,
  formatPauseTime,
  MAX_PAUSE_REQUEUES,
  metaLimitOf,
  nextPauseWait,
  PAUSE_JITTER_MS,
  pauseAccountForLimit,
  pausedRunAt,
  pauseWaitMessage,
  requeueForPause,
} from "./account-pause";
import { afterLinkDelivered } from "./after-delivery";
import {
  claimPostbackDelivery,
  formatError,
  isTemplateRejection,
  isUniqueViolation,
  logWorkerEvent,
  sendClaimedPostback,
  sendPostbackOnce,
} from "./send-helpers";
import type { Prisma } from "@/app/generated/prisma/client";
import type { RateLimitError } from "@/lib/meta/client";
import {
  boundCampaignsFirst,
  matchCommentToCampaign,
} from "@/lib/automation/comment-match";
import {
  MANUAL_MATCHED_KEYWORD,
  manualSendJobBase,
} from "@/lib/comments/manual";
import { ensureContactSafe, type ContactSummary } from "@/lib/contacts/store";
import { OFFER_PAYLOAD_PREFIX, withinWindow } from "@/lib/offers/schedule";
import { processOffer, processOfferTap } from "@/lib/offers/worker";
import { createHash } from "node:crypto";
import { UnrecoverableError, Worker, type Job } from "bullmq";
import {
  getDMQueue,
  getRedisConnection,
  COMMENT_JOB_NAME,
  MESSAGE_JOB_NAME,
  POSTBACK_JOB_NAME,
  FOLLOWUP_JOB_NAME,
  OFFER_JOB_NAME,
  type DmQueueJob,
  type ProcessCommentJob,
  type ProcessMessageJob,
  type ProcessOfferJob,
  type ProcessPostbackJob,
  type ProcessFollowUpJob,
} from "./client";
import { prisma } from "@/lib/db/client";
import {
  getUserFollowStatus,
  resolveRecipientName,
  sendCommentReply,
  sendDirectMessage,
  sendDirectMessageWithButton,
  sendDirectMessageWithLinkButton,
  sendPrivateReply,
  sendPrivateReplyWithButton,
  sendPrivateReplyWithLinkButton,
} from "@/lib/instagram/provider";
import {
  createInstagramContext,
  hasInstagramCredentials,
  type InstagramContext,
} from "@/lib/instagram/provider";
import { matchKeywords } from "@/lib/utils/keyword-matcher";
import { reserveDMSlot, releaseDMSlot } from "@/lib/utils/rate-limiter";
import {
  releaseWorkspaceDMReservation,
  reserveWorkspaceDMSend,
} from "@/lib/billing/usage";
import { recordWorkerAlert } from "@/lib/ops/worker-health";
import {
  buildTrackedUrl,
  renderMessageWithTracking,
  renderMessageWithoutLink,
} from "@/lib/tracking/message";
import { TRACKED_LINK_ORDER } from "@/lib/tracking/link-order";
import { hashRecipientId } from "@/lib/tracking/server";

const BACKOFF_DELAYS = [5 * 60 * 1000, 15 * 60 * 1000, 45 * 60 * 1000];

// How long to wait before re-checking a follow that came back false: one
// delay per re-check, each counted from the previous check.
//
// `is_user_follow_business` does not reflect a brand-new follow right away, and
// the follow gate asks people to follow and tap a button that is sitting in
// front of them — so tapping seconds after following is the normal case, not
// the exception. Rejecting on the first `false` therefore turns away the exact
// people who did what was asked, and they get told to follow an account they
// already follow.
//
// Two checks rather than one long wait: measured, a follow still read `false`
// 17 s after it happened and `true` by ~68 s. An early check catches the fast
// ones sooner; the last still covers the slow ones.
const FOLLOW_RECHECK_DELAYS_MS = (
  process.env.FOLLOW_RECHECK_DELAYS_MS ?? "20000,40000"
)
  .split(",")
  .map(Number)
  .filter((ms) => ms > 0);
const FOLLOW_RECHECK_TOTAL_MS = FOLLOW_RECHECK_DELAYS_MS.reduce(
  (total, ms) => total + ms,
  0
);

type WorkerTrackedLink = {
  slug: string;
  label: string | null;
  destinationUrl: string;
};

/**
 * Build the tappable link buttons for a DM. The first link uses the campaign's
 * `linkButtonLabel`; each additional link uses its own stored `label`. Capped at
 * Meta's 3-button limit for a button template.
 */
function buildLinkButtons(
  trackedLinks: WorkerTrackedLink[],
  primaryLabel: string | null,
  recipientToken: string
): { title: string; url: string }[] {
  return trackedLinks.slice(0, 3).map((link, index) => ({
    url: buildTrackedUrl(link.slug, undefined, recipientToken),
    title:
      (index === 0 ? primaryLabel : link.label) || link.label || "Open link",
  }));
}

/**
 * Fallback text when Meta rejects the button template: render the primary link
 * inline, then append any extra tracked URLs on their own lines so no link is
 * lost.
 */
function buildInlineLinkFallback(
  message: string,
  commenterName: string | null | undefined,
  trackedLinks: WorkerTrackedLink[],
  bodyText: string,
  recipientToken: string
): string {
  const base =
    renderMessageWithTracking({
      message,
      commenterName,
      trackedLinks,
      recipientToken,
    }) || bodyText;
  const extraUrls = trackedLinks
    .slice(1)
    .map((link) => buildTrackedUrl(link.slug, undefined, recipientToken));
  return extraUrls.length > 0 ? `${base}\n${extraUrls.join("\n")}` : base;
}

type RevealAutomation = {
  dmMessage: string;
  linkButtonLabel: string | null;
  trackedLinks: WorkerTrackedLink[];
  instagramAccount: { instagramId: string };
};

/**
 * Deliver a campaign's reveal message as a direct message. Shared by the
 * button-tap (postback) path and the DM keyword-trigger path — both already
 * have an open conversation with the user, so neither uses a private reply.
 */
async function sendRevealDirectMessage({
  accessToken,
  automation,
  userId,
  commenterName,
  context,
}: {
  accessToken: InstagramContext;
  automation: RevealAutomation;
  userId: string;
  commenterName: string | null;
  context: string;
}): Promise<void> {
  if (automation.trackedLinks.length === 0) {
    await sendDirectMessage({
      context: accessToken,
      instagramAccountId: automation.instagramAccount.instagramId,
      userId: userId,
      message: renderMessageWithTracking({
        message: automation.dmMessage,
        commenterName,
        trackedLinks: automation.trackedLinks,
      }),
    });
    return;
  }

  // Try button template first; if Meta rejects it, fall back to inline links.
  const bodyText =
    renderMessageWithoutLink({
      message: automation.dmMessage,
      commenterName,
    }) || "Here's your link:";
  const recipientToken = hashRecipientId(userId);
  const buttons = buildLinkButtons(
    automation.trackedLinks,
    automation.linkButtonLabel,
    recipientToken
  );

  try {
    await sendDirectMessageWithLinkButton({
      context: accessToken,
      instagramAccountId: automation.instagramAccount.instagramId,
      userId: userId,
      text: bodyText,
      buttons: buttons,
    });
  } catch (buttonError) {
    // A closed messaging window rejects the text retry too, so don't let it
    // overwrite the original error with a misleading one.
    if (!isTemplateRejection(buttonError)) throw buttonError;

    console.log(
      `[DM Worker] Button template rejected in ${context}, falling back to inline link:`,
      formatError(buttonError)
    );
    try {
      await sendDirectMessage({
        context: accessToken,
        instagramAccountId: automation.instagramAccount.instagramId,
        userId: userId,
        message: buildInlineLinkFallback(
          automation.dmMessage,
          commenterName,
          automation.trackedLinks,
          bodyText,
          recipientToken
        ),
      });
    } catch (fallbackError) {
      throw classifySendError(fallbackError);
    }
  }
}


function connectionScope(data: DmQueueJob) {
  return data.accountConnectionId ? { instagramAccountId: data.accountConnectionId } : {};
}

/**
 * What a comment job's copies are named after (the pause's `_pause_<n>`, the
 * hourly limit's `_retry_<n>`): comment_<account>_<comment>, or for a manual
 * send manual_<account>_<comment>_<campaign> (manualSendJobBase). A manual
 * send's copies carry the chosen campaign, so they must never share an id
 * with the copies of the comment's automatic job, which BullMQ would take
 * for the same job and drop.
 */
function commentJobBase(data: ProcessCommentJob): string {
  return data.forceAutomationId
    ? manualSendJobBase({
        instagramId: data.instagramAccountId,
        commentId: data.commentId,
        automationId: data.forceAutomationId,
      })
    : `comment_${data.instagramAccountId}_${data.commentId}`;
}

// When the tap behind a postback job happened (epoch ms). A follow re-check
// carries the time of the tap it repeats; a tap is its own job's timestamp.
function tapTime(job: Job<ProcessPostbackJob>): number {
  return job.data.tappedAt ?? job.timestamp ?? Date.now();
}

/**
 * Put a comment back for the end of its account's pause instead of calling
 * Meta (lib/queue/account-pause.ts): its DM leg waits as PENDING with the
 * time of the next try, and a delayed copy of the job runs then, as
 * comment_<account>_<comment>_pause_<n>. The copy goes through every
 * campaign of the comment again, the one bound to the post first. A manual
 * send's copy is manual_<account>_<comment>_<campaign>_pause_<n> and sends
 * the chosen campaign again (commentJobBase).
 *
 * With `releaseClaim`, this job claimed the DM leg for a send that Meta
 * refused with a request limit. The claim is given back before the copy is
 * queued (a copy that ran first would find it and take the DM for sent), and
 * the refused try does not count as one of the comment's send attempts.
 *
 * After MAX_PAUSE_REQUEUES copies the comment is not put back ("capped"):
 * the caller fails it as any refused send.
 */
async function holdCommentForPause({
  job,
  automationId,
  resumeAt,
  releaseClaim,
}: {
  job: Job<ProcessCommentJob>;
  automationId: string;
  resumeAt: number;
  releaseClaim: boolean;
}): Promise<"held" | "capped"> {
  const { instagramAccountId, commentId } = job.data;
  const held = (job.data.pauseRequeue ?? 0) + 1;
  if (held > MAX_PAUSE_REQUEUES) return "capped";

  const jobId = `${commentJobBase(job.data)}_pause_${held}`;
  const reason = `Instagram request limit; next try at ${formatPauseTime(
    pausedRunAt(resumeAt, jobId)
  )}`;
  console.log(`[DM Worker] Comment ${commentId}: ${reason} (wait ${held})`);
  if (releaseClaim) {
    await releaseCommentClaim(automationId, commentId, reason);
  } else {
    await prisma.dmLog.updateMany({
      where: {
        automationId,
        commentId,
        status: { not: "SENT" },
        dmDeliveryUnconfirmed: false,
      },
      data: { status: "PENDING", errorMessage: reason },
    });
  }
  await requeueForPause({
    name: COMMENT_JOB_NAME,
    data: { ...job.data, pauseRequeue: held },
    jobId,
    instagramAccountId,
    resumeAt,
  });
  return "held";
}

function pauseGaveUpMessage(resumeAt: number): string {
  return `Instagram request limit: the account was still paused after ${MAX_PAUSE_REQUEUES} waits (until ${formatPauseTime(resumeAt)}), so the DM was not sent`;
}

/**
 * The comment's account is paused, and nothing was claimed or sent for it
 * yet: the comment waits for the end of the pause, or, after
 * MAX_PAUSE_REQUEUES waits, fails like a refused send (FAILED, and the job
 * is thrown back to BullMQ, whose retries send nothing while the pause
 * lasts). Its send attempts stay as they are either way.
 */
async function waitForAccountPause(
  job: Job<ProcessCommentJob>,
  automationId: string,
  resumeAt: number
): Promise<void> {
  const hold = await holdCommentForPause({
    job,
    automationId,
    resumeAt,
    releaseClaim: false,
  });
  if (hold === "held") return;
  const message = pauseGaveUpMessage(resumeAt);
  await prisma.dmLog.updateMany({
    where: {
      automationId,
      commentId: job.data.commentId,
      status: { not: "SENT" },
      dmDeliveryUnconfirmed: false,
    },
    data: { status: "FAILED", errorMessage: message },
  });
  throw new AccountPausedError(message, resumeAt);
}

function pauseWindowClosedMessage(resumeAt: number): string {
  return `Instagram request limit: the messaging window closes before the account's pause ends (${formatPauseTime(resumeAt)}), so the DM was not sent`;
}

// Why a message that waited for the account's pause is not sent after all,
// although the pause is over: its copy no longer reaches the campaign, or a
// tap's follow check after the pause finds no follow.
const PAUSE_CAMPAIGN_CHANGED_MESSAGE =
  "Not sent: the campaign was paused or changed while the account was paused";
const PAUSE_NO_FOLLOW_MESSAGE =
  "Not sent: the follow check after the account's pause found no follow";

/**
 * A tap's copy, queued for the account's pause, ends without the link: the
 * person's link that waits for the pause (PENDING, holdTapForPause) is
 * logged FAILED with the reason, as a refused link is. Only a waiting row
 * changes: one that says the link went out stays as it is, and a tap whose
 * link never waited has no row to change (a follow request has none).
 *
 * Nothing else would end the wait: only the copies settle the row, and the
 * read fallback reads a waiting row as a link still to come and stands back,
 * so a row left PENDING would hold the fallback back for good.
 */
async function settleWaitingReveal(
  automationId: string,
  userId: string,
  errorMessage: string
): Promise<void> {
  await prisma.dmLog.updateMany({
    where: { automationId, commentId: `reveal:${userId}`, status: "PENDING" },
    data: { status: "FAILED", errorMessage },
  });
}

// The latest of some times (epoch ms), any of which may be missing.
function latestTime(
  ...times: (Date | number | null | undefined)[]
): number | null {
  let latest: number | null = null;
  for (const time of times) {
    if (time === null || time === undefined) continue;
    const ms = typeof time === "number" ? time : time.getTime();
    if (latest === null || ms > latest) latest = ms;
  }
  return latest;
}

// What became of a tap, a DM reply or a follow-up that met its account's
// pause (holdConversation).
type ConversationHold = "held" | "window-closed" | "capped";

/**
 * Put a conversation job (a button tap, the reply to a DM, a follow-up) back
 * for the end of its account's pause: a copy of it runs then, as
 * `<baseJobId>_pause_<n>` (requeueForPause). Nothing was sent: the pause was
 * found before Instagram was called, or Instagram refused with a request
 * limit, which gave the message's claim back as any refusal does.
 *
 * The copy is queued only while it can still be sent. Instagram lets the
 * account message the person for 24 hours after their last tap or DM
 * (`windowFrom`). When that window is closed by the time the copy would run,
 * within withinWindow's margin, nothing is queued ("window-closed"), and
 * after MAX_PAUSE_REQUEUES waits neither ("capped"). The caller handles
 * these as it handles a closed window and a refused send.
 *
 * `beforeQueue` gets what the job shows meanwhile ("Instagram request limit;
 * next try at …") and runs before the copy is queued, so what the caller
 * records can never land after the copy's own outcome.
 */
async function holdConversation({
  name,
  data,
  baseJobId,
  instagramAccountId,
  resumeAt,
  windowFrom,
  beforeQueue,
}: {
  name: string;
  data: DmQueueJob;
  /** The job's usual id, without ":" (BullMQ forbids it in custom ids). */
  baseJobId: string;
  instagramAccountId: string;
  resumeAt: number;
  windowFrom: number | null;
  beforeQueue?: (reason: string) => Promise<unknown>;
}): Promise<ConversationHold> {
  const wait = nextPauseWait(baseJobId, data.pauseRequeue, resumeAt);
  if (!withinWindow(windowFrom, wait.runAt)) return "window-closed";
  if (wait.capped) return "capped";
  const reason = pauseWaitMessage(wait.runAt);
  await beforeQueue?.(reason);
  await requeueForPause({
    name,
    data: { ...data, pauseRequeue: wait.number },
    jobId: wait.jobId,
    instagramAccountId,
    resumeAt,
  });
  console.log(`[DM Worker] ${baseJobId}: ${reason} (wait ${wait.number})`);
  return "held";
}

/**
 * Show on its DmLog row that a message waits for the account's pause:
 * PENDING with the time of the next try. A row that says the message went
 * out keeps saying so: another job sent it meanwhile, or, on a tap's row, an
 * earlier tap did, which the read fallback must still see.
 */
async function markDmLogWaiting(
  row: Prisma.DmLogUncheckedCreateInput,
  reason: string
): Promise<void> {
  const { count } = await prisma.dmLog.updateMany({
    where: {
      automationId: row.automationId,
      commentId: row.commentId,
      status: { not: "SENT" },
    },
    data: { status: "PENDING", errorMessage: reason },
  });
  if (count > 0) return;
  try {
    await prisma.dmLog.create({
      data: { ...row, status: "PENDING", errorMessage: reason },
    });
  } catch (error) {
    // The row is there after all and says the message went out: leave it.
    if (!isUniqueViolation(error)) throw error;
  }
}

// What a comment job loads with each campaign it may answer with.
const COMMENT_CAMPAIGN_INCLUDE = {
  instagramAccount: true,
  workspace: true,
  trackedLinks: {
    select: {
      slug: true,
      label: true,
      destinationUrl: true,
    },
    orderBy: TRACKED_LINK_ORDER,
  },
} satisfies Prisma.AutomationInclude;

/**
 * The campaign a manual send names (forceAutomationId), on the comment's own
 * account, or none. Its keywords, its question filter, its post and whether
 * it is active do not matter: the owner chose it for this comment (an
 * inactive campaign may be sent by hand, the page says so). A campaign that
 * was deleted or moved to another account since sends nothing, recorded in
 * Diagnostics.
 */
async function loadManualCampaign(data: ProcessCommentJob) {
  const automation = await prisma.automation.findFirst({
    where: {
      id: data.forceAutomationId,
      ...connectionScope(data),
      instagramAccount: { instagramId: data.instagramAccountId },
    },
    include: COMMENT_CAMPAIGN_INCLUDE,
  });
  if (automation) return [automation];

  console.warn(
    `[DM Worker] Manual send for comment ${data.commentId}: campaign ${data.forceAutomationId} not found`
  );
  const account = await prisma.instagramAccount
    .findUnique({
      where: { instagramId: data.instagramAccountId },
      select: { workspaceId: true },
    })
    .catch(() => null);
  await logWorkerEvent({
    workspaceId: account?.workspaceId ?? null,
    level: "WARNING",
    message: `Manual send for comment ${data.commentId} not sent: the campaign was deleted or belongs to another account`,
    payload: {
      kind: "manual-send",
      commentId: data.commentId,
      automationId: data.forceAutomationId ?? null,
    },
  });
  return [];
}

/**
 * Another campaign's row that says this comment's private reply is used: it
 * went out, may have, or another job holds the claim for it right now
 * (privateReplyTaken). A manual send asks before it claims the comment and
 * again right after, so that it never sends next to a DM that may be on its
 * way.
 */
async function privateReplyTakenBy(
  commentId: string,
  automationId: string
): Promise<{ name: string; sent: boolean } | null> {
  const rows = await prisma.dmLog.findMany({
    where: { commentId, automationId: { not: automationId } },
    select: {
      status: true,
      dmDeliveryUnconfirmed: true,
      errorMessage: true,
      automation: { select: { name: true } },
    },
  });
  const taken = rows.find(privateReplyTaken);
  return taken
    ? { name: taken.automation?.name ?? "unknown", sent: taken.status === "SENT" }
    : null;
}

/**
 * A manual send of another campaign that took this comment's private reply,
 * or holds its claim right now. The comment's automatic jobs ask this right
 * after their own claim. A manual send claims and then looks for every other
 * claim, so of two sends that claim at the same moment, at least one sees the
 * other and stands back: the comment never gets two private replies.
 *
 * Read by its label: a manual send writes "(manuell)" with its claim (and on
 * the row it creates). A claim on such a row stands for the comment's
 * private reply whichever job took it, so standing back is right either way.
 * The label is compared again on the answer: only such a row counts.
 */
async function manualSendHolding(
  commentId: string,
  automationId: string
): Promise<string | null> {
  const row = await prisma.dmLog.findFirst({
    where: {
      commentId,
      automationId: { not: automationId },
      matchedKeyword: MANUAL_MATCHED_KEYWORD,
      OR: [{ status: "SENT" }, { dmDeliveryUnconfirmed: true }],
    },
    select: { matchedKeyword: true, automation: { select: { name: true } } },
  });
  return row?.matchedKeyword === MANUAL_MATCHED_KEYWORD
    ? row.automation?.name ?? "unknown"
    : null;
}

async function processComment(job: Job<ProcessCommentJob>): Promise<void> {
  const {
    instagramAccountId,
    commentId,
    commentText,
    commenterId,
    commenterName,
    mediaId,
    originalMediaId,
  } = job.data;
  const requeueAttempt = job.data.requeueAttempt ?? 0;
  // A manual send from the Kommentare page (lib/comments/manual.ts): exactly
  // the campaign it names, with the public reply as the owner chose.
  // Everything else, from the claims to what follows the DM, is the same.
  const manual = Boolean(job.data.forceAutomationId);

  const automations = manual
    ? await loadManualCampaign(job.data)
    : // Campaigns bound to the commented post go first
      // (lib/automation/comment-match.ts): only the first campaign to send
      // can use the comment's one private reply.
      boundCampaignsFirst(
        await prisma.automation.findMany({
          where: {
            ...connectionScope(job.data),
            // Match campaigns bound to this specific post, plus any-post
            // campaigns. A comment left on an ad carries the ad's own media
            // id, while the campaign is bound to the post the ad was created
            // from, so both ids have to be considered or the comment is
            // dropped without a trace.
            OR: [
              { postId: mediaId },
              ...(originalMediaId ? [{ postId: originalMediaId }] : []),
              { matchAnyPost: true },
            ],
            isActive: true,
            instagramAccount: {
              instagramId: instagramAccountId,
            },
          },
          include: COMMENT_CAMPAIGN_INCLUDE,
          orderBy: { createdAt: "asc" },
        }),
        mediaId,
        originalMediaId
      );

  // Recorded once per job, by the first campaign with work to do for this
  // comment. Undefined until then, null when that write failed.
  let contactId: string | null | undefined;

  for (const automation of automations) {
    // A campaign can leave questions to a human, "any word" campaigns fire on
    // every comment, the others need a keyword. A manual send needs neither:
    // the owner chose the campaign for this comment.
    const matchResult = manual
      ? { matched: true, matchedKeyword: MANUAL_MATCHED_KEYWORD }
      : matchCommentToCampaign(automation, commentText);

    if (!matchResult.matched) {
      continue;
    }

    // Whether this campaign posts its public reply. A manual send says it
    // itself (off when the owner already answered in public); without that,
    // the campaign's setting.
    const publicReplyOn =
      manual && typeof job.data.publicReplyOverride === "boolean"
        ? job.data.publicReplyOverride
        : automation.publicReplyEnabled;

    const existingLog = await prisma.dmLog.findUnique({
      where: {
        automationId_commentId: {
          automationId: automation.id,
          commentId,
        },
      },
    });

    if (existingLog?.status === "FAILED" && hasLegacyUnconfirmedDelivery(existingLog.errorMessage)) {
      await prisma.dmLog.update({
        where: { automationId_commentId: { automationId: automation.id, commentId } },
        data: { dmDeliveryUnconfirmed: true },
      });
      existingLog.dmDeliveryUnconfirmed = true;
    }

    const alreadyDmd = existingLog?.status === "SENT";
    const alreadyPublicReplied = Boolean(existingLog?.publicReplySentAt);
    const needsDm = !alreadyDmd && !existingLog?.dmDeliveryUnconfirmed &&
      (existingLog?.attempts ?? 0) < MAX_COMMENT_SEND_ATTEMPTS;
    // The public reply follows the DM, so it is owed only once the DM went out
    // (or may have).
    const dmWentOut = alreadyDmd || Boolean(existingLog?.dmDeliveryUnconfirmed);

    // Skip only when there is genuinely nothing left to do. A comment whose DM
    // already went out but whose public reply never posted (e.g. it hit a rate
    // limit) must still come back so the public reply can be retried. A dedupe
    // skip is final: another campaign used the comment's private reply, and
    // the public reply belongs to that campaign. Not for a manual send: the
    // owner asks again, and the checks below decide anew (another campaign's
    // DM still rules it out).
    if (
      !manual &&
      (existingLog?.status === "SKIPPED_PLAN_LIMIT" ||
        existingLog?.status === "SKIPPED_DEDUP")
    ) {
      continue;
    }
    if (
      !needsDm &&
      (!dmWentOut || alreadyPublicReplied || existingLog?.publicReplyDeliveryUnconfirmed || !publicReplyOn)
    ) {
      continue;
    }

    // The commenter becomes, or stays, a contact. A comment opens no
    // messaging window, so no interaction time is stamped. Best effort: a
    // failed write must not hold up the DM.
    if (contactId === undefined) {
      const contact = await ensureContactSafe({
        workspaceId: automation.workspaceId,
        instagramAccountId: automation.instagramAccountId,
        igsid: commenterId,
        username: commenterName ?? null,
      });
      contactId = contact?.id ?? null;
    }

    if (!hasInstagramCredentials(automation.instagramAccount)) {
      await prisma.dmLog.upsert({
        where: {
          automationId_commentId: {
            automationId: automation.id,
            commentId,
          },
        },
        create: {
          workspaceId: automation.workspaceId,
          automationId: automation.id,
          instagramAccountId: automation.instagramAccountId,
          commenterId,
          commenterName,
          commentText,
          commentId,
          matchedKeyword: matchResult.matchedKeyword,
          status: "FAILED",
          errorMessage: "No Instagram access token available",
        },
        update: {
          status: "FAILED",
          errorMessage: "No Instagram access token available",
        },
      });
      continue;
    }

    let accessToken: InstagramContext;
    try {
      accessToken = await createInstagramContext(
        automation.instagramAccount,
        `${job.id}:${automation.id}`
      );
    } catch {
      await prisma.dmLog.upsert({
        where: {
          automationId_commentId: {
            automationId: automation.id,
            commentId,
          },
        },
        create: {
          workspaceId: automation.workspaceId,
          automationId: automation.id,
          instagramAccountId: automation.instagramAccountId,
          commenterId,
          commenterName,
          commentText,
          commentId,
          matchedKeyword: matchResult.matchedKeyword,
          status: "FAILED",
          errorMessage: "Failed to decrypt Instagram access token",
        },
        update: {
          status: "FAILED",
          errorMessage: "Failed to decrypt Instagram access token",
        },
      });
      continue;
    }

    await prisma.dmLog.upsert({
      where: { automationId_commentId: { automationId: automation.id, commentId } },
      create: {
        workspaceId: automation.workspaceId,
        automationId: automation.id,
        instagramAccountId: automation.instagramAccountId,
        commenterId, commenterName, commentText, commentId,
        matchedKeyword: matchResult.matchedKeyword,
        status: "PENDING",
      },
      update: {},
    });

    // Public reply leg. It is posted after the DM leg, and only when the DM went
    // out or may have: a "check your DMs" reply under a comment whose DM was
    // refused or skipped would promise a message that never comes. A DM that
    // waits for a retry gets its public reply on the pass that sends it.
    // Idempotent across retries via publicReplySentAt.
    const postPublicReply = async (): Promise<void> => {
      if (manual && !publicReplyOn && automation.publicReplyEnabled) {
        // The owner sent this DM by hand without the public reply (usually
        // because they already answered in public). The public leg is closed
        // for good, as a reply that may have gone out closes it, so no later
        // webhook or sweep job posts the campaign's reply under the comment.
        await prisma.dmLog
          .updateMany({
            where: {
              automationId: automation.id,
              commentId,
              publicReplySentAt: null,
              publicReplyDeliveryUnconfirmed: false,
            },
            data: {
              publicReplyDeliveryUnconfirmed: true,
              publicReplyError: "Not posted: the public reply was switched off for this manual send",
            },
          })
          .catch((error) =>
            console.error(
              "[DM Worker] Could not close the public reply of a manual send:",
              formatError(error)
            )
          );
        return;
      }
      const replyPool =
        automation.publicReplyMessages.length > 0
          ? automation.publicReplyMessages
          : automation.publicReplyMessage
            ? [automation.publicReplyMessage]
            : [];
      if (
        !publicReplyOn ||
        replyPool.length === 0 ||
        existingLog?.publicReplySentAt ||
        existingLog?.publicReplyDeliveryUnconfirmed ||
        !(await claimCommentDelivery(automation.id, commentId, "public"))
      ) {
        return;
      }
      try {
        const chosen = replyPool[Math.floor(Math.random() * replyPool.length)];
        const publicReply = renderMessageWithTracking({
          message: chosen,
          commenterName,
          trackedLinks: automation.trackedLinks,
        });
        await sendCommentReply({
          context: accessToken,
          commentId: commentId,
          message: publicReply,
          postId: mediaId,
        });
        await prisma.dmLog.update({
          where: {
            automationId_commentId: { automationId: automation.id, commentId },
          },
          data: { publicReplySentAt: new Date(), publicReplyError: null, publicReplyDeliveryUnconfirmed: false },
        });
      } catch (error) {
        console.error(
          "[DM Worker] Public comment reply failed:",
          formatError(error)
        );
        await prisma.dmLog
          .update({
            where: {
              automationId_commentId: {
                automationId: automation.id,
                commentId,
              },
            },
            data: { publicReplyError: formatError(classifySendError(error)), publicReplyDeliveryUnconfirmed: !isConfirmedSendRejection(error) },
          })
          .catch(() => {});
      }
    };

    // DM already handled on an earlier pass: only the public reply can be
    // left, and only if that DM went out. Don't re-send the DM.
    if (!needsDm) {
      if (dmWentOut) await postPublicReply();
      continue;
    }

    // Meta allows exactly ONE private reply per comment, ever — across every
    // campaign. When several campaigns match the same comment (duplicated
    // campaigns, or an any-post campaign overlapping a post-specific one), only
    // the first can deliver; the rest would fail with "The comment is invalid
    // for a private reply". Skip them explicitly instead of burning an API call
    // and logging a failure the user can do nothing about. Only the campaign
    // that sent the DM posts a public reply: a second "check your DMs" under
    // the same comment, from a campaign that sent nothing, adds noise and
    // promises a message that never comes. A manual send also stands back
    // for a DM that may have gone out or is on its way (privateReplyTakenBy).
    const privateReplyUsedBy = manual
      ? await privateReplyTakenBy(commentId, automation.id)
      : await prisma.dmLog
          .findFirst({
            where: {
              commentId,
              status: "SENT",
              automationId: { not: automation.id },
            },
            select: { automation: { select: { name: true } } },
          })
          .then((row) =>
            row ? { name: row.automation?.name ?? "unknown", sent: true } : null
          );
    if (privateReplyUsedBy) {
      await prisma.dmLog.update({
        where: {
          automationId_commentId: { automationId: automation.id, commentId },
        },
        data: {
          status: "SKIPPED_DEDUP",
          matchedKeyword: matchResult.matchedKeyword,
          errorMessage: privateReplyUsedBy.sent
            ? `Another campaign (${privateReplyUsedBy.name}) already sent the one private reply Instagram allows for this comment`
            : `Another campaign (${privateReplyUsedBy.name}) is sending, or may have sent, the one private reply Instagram allows for this comment`,
        },
      });
      continue;
    }

    // Meta refuses this account's calls for a request limit (the account is
    // paused): nothing is called and nothing reserved. The comment waits for
    // the end of the pause; the follow check and the send happen then.
    const pausedUntil = await checkAccountPause(instagramAccountId);
    if (pausedUntil !== null) {
      await waitForAccountPause(job, automation.id, pausedUntil);
      return;
    }

    const usage = await reserveWorkspaceDMSend(automation.workspaceId);
    if (!usage.allowed) {
      await prisma.dmLog.update({
        where: {
          automationId_commentId: {
            automationId: automation.id,
            commentId,
          },
        },
        data: {
          status: "SKIPPED_PLAN_LIMIT",
          matchedKeyword: matchResult.matchedKeyword,
          errorMessage: `Monthly DM limit reached (${usage.limit})`,
        },
      });
      continue;
    }

    let rateLimit;
    try {
      rateLimit = await reserveDMSlot(instagramAccountId, requeueAttempt);
    } catch (error) {
      await releaseWorkspaceDMReservation(
        automation.workspaceId,
        usage.periodStart
      );
      await prisma.dmLog.update({
        where: {
          automationId_commentId: {
            automationId: automation.id,
            commentId,
          },
        },
        data: {
          status: "FAILED",
          errorMessage: formatError(error),
        },
      });
      throw error;
    }

    if (!rateLimit.allowed) {
      await releaseWorkspaceDMReservation(
        automation.workspaceId,
        usage.periodStart
      );

      if (rateLimit.shouldSkip) {
        await prisma.dmLog.update({
          where: {
            automationId_commentId: {
              automationId: automation.id,
              commentId,
            },
          },
          data: {
            status: "SKIPPED_RATE_LIMIT",
            matchedKeyword: matchResult.matchedKeyword,
            errorMessage: "Hourly Instagram DM rate limit reached",
          },
        });
        continue;
      }

      if (rateLimit.shouldRequeue) {
        await prisma.dmLog.update({
          where: {
            automationId_commentId: {
              automationId: automation.id,
              commentId,
            },
          },
          data: {
            status: "PENDING",
            matchedKeyword: matchResult.matchedKeyword,
            errorMessage: "Hourly rate limit hit; retry scheduled",
          },
        });

        await getDMQueue().add(
          COMMENT_JOB_NAME,
          {
            ...job.data,
            requeueAttempt: requeueAttempt + 1,
          },
          {
            delay: rateLimit.requeueDelayMs,
            jobId: `${commentJobBase(job.data)}_retry_${requeueAttempt + 1}`,
          }
        );
        continue;
      }
    }

    // With an opening DM, the private reply is a button message; tapping it
    // fires a postback that delivers the reveal (see processPostback). Without
    // one, we send the reveal text directly as today.
    const useOpeningDm =
      automation.openingDmEnabled &&
      Boolean(automation.openingDmMessage) &&
      Boolean(automation.openingDmButtonLabel);

    // Follow-gating: the link is revealed only after a follow. When an opening
    // DM is enabled it comes FIRST, and its button routes into the follow check
    // (opening DM → follow gate → link). Without an opening DM, we check follow
    // status at comment time: confirmed followers get the link now, everyone
    // else gets the "follow me first" prompt (re-verified on tap).
    let sendFollowPrompt = false;
    if (automation.requireFollow && !useOpeningDm) {
      let alreadyFollows: boolean | null;
      try {
        // A request limit is thrown rather than read as unknown, which would
        // send the follow prompt to someone who may well follow.
        alreadyFollows = await getUserFollowStatus({
          context: accessToken,
          recipientId: commenterId,
          throwOnLimit: true,
        });
      } catch (error) {
        if (rateLimit?.reserved) await releaseDMSlot(instagramAccountId);
        await releaseWorkspaceDMReservation(automation.workspaceId, usage.periodStart);
        if (!isMetaThrottle(error)) throw error;
        const pause = await pauseAccountForLimit({
          instagramAccountId,
          workspaceId: automation.workspaceId,
          account: automation.instagramAccount.username,
          error,
        });
        await waitForAccountPause(job, automation.id, pause.resumeAt);
        return;
      }
      sendFollowPrompt =
        accessToken.provider === "ZERNIO"
          ? alreadyFollows === false
          : alreadyFollows !== true;
    }

    // Whether this private reply carries the link. The opening DM and the
    // follow prompt are logged SENT as well, but the link comes later, with
    // the tap on their button.
    const sendsLink = !useOpeningDm && !sendFollowPrompt;

    let claimed;
    try {
      claimed = await claimCommentDelivery(
        automation.id,
        commentId,
        "dm",
        manual ? { matchedKeyword: MANUAL_MATCHED_KEYWORD } : undefined
      );
    } catch (error) {
      if (rateLimit?.reserved) await releaseDMSlot(instagramAccountId);
      await releaseWorkspaceDMReservation(automation.workspaceId, usage.periodStart);
      throw error;
    }
    if (!claimed) {
      if (rateLimit?.reserved) await releaseDMSlot(instagramAccountId);
      await releaseWorkspaceDMReservation(automation.workspaceId, usage.periodStart);
      continue;
    }

    // The claim is per campaign, the private reply per comment. A manual send
    // can claim the comment for its campaign while an automatic job claims it
    // for another. So after its claim, a manual send looks for any other
    // campaign's claim or DM, and an automatic job for a manual send's: of
    // two sends that claim at the same moment, at least one sees the other.
    // That one gives its claim back, with its attempt (nothing was sent), and
    // leaves the comment to the other campaign.
    let rival: string | null;
    try {
      rival = manual
        ? ((await privateReplyTakenBy(commentId, automation.id))?.name ?? null)
        : await manualSendHolding(commentId, automation.id);
    } catch (error) {
      // Nothing was sent: the claim goes back, and the job is retried.
      await releaseCommentClaim(automation.id, commentId, formatError(error)).catch(
        () => false
      );
      if (rateLimit?.reserved) await releaseDMSlot(instagramAccountId);
      await releaseWorkspaceDMReservation(automation.workspaceId, usage.periodStart);
      throw error;
    }
    if (rival !== null) {
      if (rateLimit?.reserved) await releaseDMSlot(instagramAccountId);
      await releaseWorkspaceDMReservation(automation.workspaceId, usage.periodStart);
      await releaseCommentClaim(
        automation.id,
        commentId,
        manual
          ? `Not sent: another campaign (${rival}) is sending, or may have sent, the one private reply Instagram allows for this comment`
          : `Not sent: this comment's DM was sent by hand with another campaign (${rival}); Instagram allows one private reply per comment`,
        "SKIPPED_DEDUP"
      );
      continue;
    }
    let delivered = false;
    try {
      if (useOpeningDm) {
        const openingText = renderMessageWithTracking({
          message: automation.openingDmMessage as string,
          commenterName,
          trackedLinks: [],
        });
        await sendPrivateReplyWithButton({
          context: accessToken,
          instagramAccountId: automation.instagramAccount.instagramId,
          commentId: commentId,
          text: openingText,
          buttonTitle: automation.openingDmButtonLabel as string,
          // The ":open" marker tells a tap here apart from the follow prompt's
          // own "I'm following" button, which sends the same prefix.
          payload: `${automation.requireFollow ? "followcheck" : "reveal"}:${automation.id}:open`,
          postId: mediaId,
        });
      } else if (sendFollowPrompt) {
        const promptText = renderMessageWithoutLink({
          message:
            automation.followPromptMessage ||
            "quick favor before i send your link. i don't make any money from this, it's free. if you want to support me, just don't unfollow after, and star the repo on github if it helps you. tap the button once you're following and i'll send it over",
          commenterName,
        });
        await sendPrivateReplyWithButton({
          context: accessToken,
          instagramAccountId: automation.instagramAccount.instagramId,
          commentId: commentId,
          text: promptText,
          buttonTitle: automation.followPromptButtonLabel || "i'm following",
          payload: `followcheck:${automation.id}`,
          postId: mediaId,
        });
      } else if (automation.trackedLinks.length > 0) {
        // Try button template first; if Meta rejects it, fall back to inline links.
        const bodyText =
          renderMessageWithoutLink({
            message: automation.dmMessage,
            commenterName,
          }) || "Here's your link:";
        const buttons = buildLinkButtons(
          automation.trackedLinks,
          automation.linkButtonLabel,
          hashRecipientId(commenterId)
        );

        try {
          await sendPrivateReplyWithLinkButton({
            context: accessToken,
            instagramAccountId: automation.instagramAccount.instagramId,
            commentId: commentId,
            text: bodyText,
            buttons: buttons,
            postId: mediaId,
          });
        } catch (buttonError) {
          // Only a template rejection is worth retrying as text. Anything else
          // (closed window, comment already replied to) fails the same way and
          // would replace the real error with a misleading one.
          if (!isTemplateRejection(buttonError)) throw buttonError;

          console.log(
            "[DM Worker] Button template rejected, falling back to inline link:",
            formatError(buttonError)
          );
          const fallbackMessage = buildInlineLinkFallback(
            automation.dmMessage,
            commenterName,
            automation.trackedLinks,
            bodyText,
            hashRecipientId(commenterId)
          );
          try {
            await sendPrivateReply({
              context: accessToken,
              instagramAccountId: automation.instagramAccount.instagramId,
              commentId: commentId,
              message: fallbackMessage,
              postId: mediaId,
            });
          } catch (fallbackError) {
            throw classifySendError(fallbackError);
          }
        }
      } else {
        const dmMessage = renderMessageWithTracking({
          message: automation.dmMessage,
          commenterName,
          trackedLinks: automation.trackedLinks,
          recipientToken: hashRecipientId(commenterId),
        });
        await sendPrivateReply({
          context: accessToken,
          instagramAccountId: automation.instagramAccount.instagramId,
          commentId: commentId,
          message: dmMessage,
          postId: mediaId,
        });
      }

      delivered = true;
      await prisma.dmLog.update({
        where: {
          automationId_commentId: {
            automationId: automation.id,
            commentId,
          },
        },
        data: {
          status: "SENT",
          dmSentAt: new Date(),
          dmDeliveryUnconfirmed: false,
          errorMessage: null,
        },
      });
    } catch (error) {
      const sendError = classifySendError(error);
      // Retain reservations if the provider may have delivered the message.
      if (isConfirmedSendRejection(sendError)) {
        if (rateLimit?.reserved) await releaseDMSlot(instagramAccountId);
        await releaseWorkspaceDMReservation(automation.workspaceId, usage.periodStart);
      }
      let errorMessage = formatError(sendError);
      // A request limit proves nothing was sent, and the account's next calls
      // would be refused as well. The account pauses, the claim goes back
      // with its attempt, and the comment waits for the end of the pause.
      // This job then ends without an error: BullMQ's own retries (5 and 15
      // minutes) would only run into the limit again.
      if (!delivered && isMetaThrottle(sendError)) {
        const pause = await pauseAccountForLimit({
          instagramAccountId,
          workspaceId: automation.workspaceId,
          account: automation.instagramAccount.username,
          error: sendError,
        });
        const hold = await holdCommentForPause({
          job,
          automationId: automation.id,
          resumeAt: pause.resumeAt,
          releaseClaim: true,
        });
        if (hold === "held") return;
        errorMessage = `${pauseGaveUpMessage(pause.resumeAt)}. ${errorMessage}`;
      }
      await prisma.dmLog.update({
        where: { automationId_commentId: { automationId: automation.id, commentId } },
        data: {
          status: delivered ? "SENT" : "FAILED",
          ...(delivered ? { dmSentAt: new Date() } : {}),
          errorMessage,
          dmDeliveryUnconfirmed: isDeliveryUnconfirmed(sendError),
        },
      });
      // A DM that may have arrived still gets its public reply. This job is
      // not retried (see processJob), so no later pass would post it.
      if (delivered || isDeliveryUnconfirmed(sendError)) {
        await postPublicReply().catch((replyError) =>
          console.error(
            "[DM Worker] Public comment reply failed:",
            formatError(replyError)
          )
        );
      }
      throw sendError;
    }

    // Outside the send's try block, like on every other delivery path: work
    // that follows the link must never turn it into a failure.
    if (sendsLink) {
      await afterLinkDelivered({
        automation,
        userId: commenterId,
        commenterName: commenterName ?? null,
        contactId: contactId ?? null,
        via: "private-reply",
        interactionAt: null,
        triggerId: commentId,
      });
    }

    await postPublicReply();
  }
}

// Tells someone whose "I'm following" tap is being re-checked that it is being
// looked at, so the chat does not sit silent while Instagram catches up with
// the follow. Opt-in through FOLLOW_RECHECK_ACK_MESSAGE, and best-effort: it
// never holds up the re-check, which is already queued when this runs.
//
// While the account is paused for a Meta request limit it is skipped, not
// held back: the re-check waits for the pause, and an acknowledgement that
// came after the pause would only arrive next to the link or the prompt.
// A limit on the acknowledgement itself pauses the account, so the re-check
// that follows waits as well.
async function sendFollowRecheckAck({
  context,
  instagramAccountId,
  automationId,
  userId,
  operationId,
  workspaceId,
  account,
}: {
  context: InstagramContext;
  instagramAccountId: string;
  automationId: string;
  userId: string;
  operationId: string | null;
  workspaceId: string;
  /** The account's username, for the pause's event. */
  account: string | null;
}): Promise<void> {
  const message = process.env.FOLLOW_RECHECK_ACK_MESSAGE?.trim();
  if (!message) return;
  try {
    if ((await checkAccountPause(instagramAccountId)) !== null) return;
    // One acknowledgement per re-check cycle: a burst of taps collapses into a
    // single re-check (bucketed job id) and should get a single reply too.
    const first = await getRedisConnection().set(
      `follow_recheck_ack:${automationId}:${userId}`,
      "1",
      "PX",
      FOLLOW_RECHECK_TOTAL_MS,
      "NX"
    );
    if (first !== "OK") return;
    const send = () =>
      sendDirectMessage({ context, instagramAccountId, userId, message });
    // Its own id: the tap's id is claimed later by the link or prompt that
    // the re-check sends, and claiming it here would suppress that message.
    // Without an id the Redis NX above is the only dedupe.
    if (operationId) {
      await sendPostbackOnce({ operationId: `${operationId}:ack`, send });
    } else {
      await send();
    }
  } catch (error) {
    const limit = metaLimitOf(error);
    if (limit) {
      await pauseAccountForLimit({
        instagramAccountId,
        workspaceId,
        account,
        error: limit,
      });
    }
    console.log(
      "[DM Worker] Failed to send follow re-check acknowledgement:",
      formatError(error),
    );
  }
}

/**
 * A button tap meets its account's pause, before anything was sent: the pause
 * was found, or Instagram refused the follow check, the follow prompt or the
 * link with a request limit (sendClaimedPostback gave the claim back, as for
 * any refusal). The tap waits for the end of the pause, as
 * postback_<claim>_pause_<n>, carrying the tap's time and id: the copy takes
 * the same claim, so it can never deliver this tap twice, and it starts the
 * same offer. `step` is what the tap was about to send or ask. The tap's
 * DmLog row is the link's, a follow request has none: a link that waits
 * shows on it (PENDING with the next try), and a follow check or prompt that
 * waits creates none. Once a link waited, though, its row stays PENDING
 * while the copies go on, also through the follow checks and prompts that
 * meet the pause before the link: each of them moves the next try along.
 *
 * A read fallback waits one minute longer than the taps and DM replies held
 * for the same pause. Whichever of those brings this person the link, the
 * fallback then finds it and sends nothing.
 *
 * A closed window ends the tap here: a link is logged FAILED, and so is a
 * waiting link behind a follow check or prompt. "capped" ends it too: a
 * waiting link behind a follow check or prompt is logged FAILED here, with
 * `error`, what Instagram answered, if it was asked; a link that met the cap
 * itself is left to the caller, which fails the tap as a refused send.
 * Nothing is ever logged as sent.
 */
async function holdTapForPause({
  job,
  automation,
  contact,
  commenterName,
  tapId,
  operationId,
  resumeAt,
  step,
  error,
}: {
  job: Job<ProcessPostbackJob>;
  automation: { id: string; workspaceId: string; instagramAccountId: string };
  contact: ContactSummary | null;
  commenterName: string | null;
  tapId: string;
  operationId: string;
  resumeAt: number;
  step: "check" | "prompt" | "link";
  error?: unknown;
}): Promise<ConversationHold> {
  const { userId } = job.data;
  const fallback = Boolean(job.data.fallback);
  const dedupeId = `reveal:${userId}`;
  const outcome = await holdConversation({
    name: POSTBACK_JOB_NAME,
    data: {
      ...job.data,
      ...(fallback ? {} : { tappedAt: tapTime(job) }),
      tapId,
    },
    baseJobId: `postback_${operationId}`,
    instagramAccountId: job.data.instagramAccountId,
    resumeAt: fallback ? resumeAt + PAUSE_JITTER_MS : resumeAt,
    // A read fallback opens no window: only one the person opened counts.
    windowFrom: latestTime(
      contact?.lastInteractionAt,
      fallback ? null : tapTime(job)
    ),
    beforeQueue: fallback
      ? undefined
      : step === "link"
        ? (reason) =>
            markDmLogWaiting(
              {
                workspaceId: automation.workspaceId,
                automationId: automation.id,
                instagramAccountId: automation.instagramAccountId,
                commenterId: userId,
                commenterName,
                commentText: "(button tap)",
                commentId: dedupeId,
              },
              reason
            )
        : // Only a link that waits already: the row says when it is tried
          // next, never that a follow request waits.
          (reason) =>
            prisma.dmLog.updateMany({
              where: {
                automationId: automation.id,
                commentId: dedupeId,
                status: "PENDING",
              },
              data: { errorMessage: reason },
            }),
  });
  if (outcome === "held") return outcome;

  if (outcome === "window-closed" && (fallback || step !== "link")) {
    console.log(
      `[DM Worker] ${fallback ? "Read fallback" : "Tap"} not answered: the messaging window closes before the account's pause ends (${formatPauseTime(resumeAt)})`,
      job.id
    );
  }
  // A read fallback records nothing while it waits, nor after.
  if (fallback) return outcome;
  if (step !== "link") {
    const gaveUp = pauseGaveUpMessage(resumeAt);
    await settleWaitingReveal(
      automation.id,
      userId,
      outcome === "window-closed"
        ? pauseWindowClosedMessage(resumeAt)
        : error
          ? `${gaveUp}. ${formatError(error)}`
          : gaveUp
    );
    return outcome;
  }
  if (outcome === "capped") return outcome;
  await prisma.dmLog.upsert({
    where: {
      automationId_commentId: { automationId: automation.id, commentId: dedupeId },
    },
    create: {
      workspaceId: automation.workspaceId,
      automationId: automation.id,
      instagramAccountId: automation.instagramAccountId,
      commenterId: userId,
      commenterName,
      commentText: "(button tap)",
      commentId: dedupeId,
      status: "FAILED",
      errorMessage: pauseWindowClosedMessage(resumeAt),
    },
    update: {
      status: "FAILED",
      errorMessage: pauseWindowClosedMessage(resumeAt),
    },
  });
  return outcome;
}

/**
 * Deliver the reveal message after a user taps an opening DM's button.
 * The postback payload is `reveal:<automationId>`; the sender is the user's
 * IGSID (same id as their comment author id), which we DM directly.
 */
async function processPostback(job: Job<ProcessPostbackJob>): Promise<void> {
  const { instagramAccountId, userId, payload, fallback } = job.data;

  // The "yes, send it" button of a lead-magnet offer. It belongs to the
  // offer, not to a campaign: the campaign that started the offer may be
  // paused or deleted by now, which must not leave the tap unanswered.
  if (payload.startsWith(OFFER_PAYLOAD_PREFIX)) return processOfferTap(job);

  const isFollowCheck = payload.startsWith("followcheck:");
  if (!isFollowCheck && !payload.startsWith("reveal:")) return;
  // The opening DM's button appends ":open" to the payload; the first follow
  // prompt's button does not. Automation ids are cuids and contain no colon.
  const [automationId, marker] = payload
    .slice(isFollowCheck ? "followcheck:".length : "reveal:".length)
    .split(":");
  const fromOpeningDm = marker === "open";
  // The second follow request's button appends ":retry". A tap on it gets the
  // link without another check, so nobody who was asked twice ends up stuck
  // when Instagram is slow to report the follow.
  const retryTap = isFollowCheck && marker === "retry";
  // A copy of a tap, queued for the account's pause (a follow re-check of
  // one included). Where it ends without the link, the person's link that
  // waits for the pause ends as well (settleWaitingReveal): no later copy of
  // this tap would.
  const pauseCopy = !fallback && Boolean(job.data.pauseRequeue);

  const automation = await prisma.automation.findFirst({
    where: { id: automationId, isActive: true, ...connectionScope(job.data) },
    include: {
      instagramAccount: true,
      workspace: true,
      trackedLinks: {
        select: { slug: true, label: true, destinationUrl: true },
        orderBy: TRACKED_LINK_ORDER,
      },
    },
  });

  if (
    !automation ||
    automation.instagramAccount.instagramId !== instagramAccountId ||
    !hasInstagramCredentials(automation.instagramAccount)
  ) {
    // The campaign was paused or moved to another account while the tap
    // waited, or its account lost its token. (A deleted campaign took its
    // rows with it.)
    if (pauseCopy) {
      await settleWaitingReveal(
        automationId,
        userId,
        automation?.instagramAccount.instagramId === instagramAccountId
          ? "No Instagram access token available"
          : PAUSE_CAMPAIGN_CHANGED_MESSAGE
      );
    }
    return;
  }

  // Duplicate sends are enabled: every button tap re-sends the reveal
  // instead of only firing once per person.
  const dedupeId = `reveal:${userId}`;

  if (fallback) {
    const existingReveal = await prisma.dmLog.findUnique({
      where: {
        automationId_commentId: {
          automationId: automation.id,
          commentId: dedupeId,
        },
      },
    });
    // PENDING: a tap's link waits for the account's pause (only
    // holdTapForPause writes it on this row) and goes out after it. A copy
    // that ends without it logs it FAILED (settleWaitingReveal), and the
    // fallback works again.
    if (
      existingReveal?.status === "SENT" ||
      existingReveal?.status === "PENDING" ||
      existingReveal?.dmDeliveryUnconfirmed
    )
      return;

    // The person may have answered the opening DM by typing the keyword
    // instead of tapping. With the DM trigger on, this campaign answered
    // that DM itself, logged as "dm:<mid>": with the link, or with a follow
    // prompt whose button brings it, or the answer waits for the account's
    // pause (PENDING, until the DM's copy sends it or logs it FAILED:
    // settleUnansweredDm). Either way the conversation holds the campaign's
    // next step already, and a fallback would send the link a second time.
    const answeredByDm = await prisma.dmLog.findFirst({
      where: {
        automationId: automation.id,
        commenterId: userId,
        commentId: { startsWith: "dm:" },
        OR: [
          { status: "SENT" },
          { status: "PENDING" },
          { dmDeliveryUnconfirmed: true },
        ],
      },
      select: { id: true },
    });
    if (answeredByDm) return;
  }

  let accessToken: InstagramContext;
  try {
    accessToken = await createInstagramContext(
      automation.instagramAccount,
      `${job.id}:${automation.id}`,
    );
  } catch {
    if (pauseCopy) {
      await settleWaitingReveal(
        automation.id,
        userId,
        "Failed to decrypt Instagram access token"
      );
    }
    return;
  }

  // This tap, by Instagram's message id. A follow re-check carries the mid
  // of the tap it repeats, a redelivered webhook the same mid again, and a
  // copy queued for the account's pause the id of the tap it copies.
  const tapId = job.data.tapId ?? job.data.mid ?? job.id ?? payload;
  const operationId = createHash("sha256")
    .update(JSON.stringify([
      automation.instagramAccountId,
      automation.id,
      userId,
      tapId,
    ]))
    .digest("hex");

  // The tapper becomes, or stays, a contact. A tap opens Instagram's 24-hour
  // messaging window, so it stamps the tap's time. A read fallback is no
  // interaction, and a re-check repeats a tap that was stamped already. A
  // copy queued for the account's pause stamps the time of its tap again,
  // which moves nothing.
  const realTap = !fallback && !job.data.followRecheck;
  const interactionAt = realTap ? new Date(tapTime(job)) : null;
  // Whether the follow gate below asks Instagram before the link.
  const checksFollow =
    automation.requireFollow && !retryTap && (isFollowCheck || Boolean(fallback));
  const pauseScope = {
    job,
    automation,
    tapId,
    operationId,
  };

  // Meta refuses this account's calls for a request limit (the account is
  // paused): nothing is looked up, checked, reserved, claimed or sent. The
  // tap is recorded on the contact, which is where the window is read from,
  // and waits for the end of the pause.
  const pausedUntil = await checkAccountPause(instagramAccountId);
  if (pausedUntil !== null) {
    const waiting = await ensureContactSafe({
      workspaceId: automation.workspaceId,
      instagramAccountId: automation.instagramAccountId,
      igsid: userId,
      interactionAt,
    });
    const outcome = await holdTapForPause({
      ...pauseScope,
      contact: waiting,
      commenterName: waiting?.username ?? null,
      resumeAt: pausedUntil,
      step: checksFollow ? "check" : "link",
    });
    if (outcome !== "capped") return;
    // It waited MAX_PAUSE_REQUEUES times: it fails like a refused send, and
    // BullMQ's retries send nothing while the pause lasts. A follow check
    // that met the cap logged a link that waited behind it already
    // (holdTapForPause).
    const message = pauseGaveUpMessage(pausedUntil);
    if (fallback) {
      console.log("[DM Worker] Read fallback not delivered:", message);
      return;
    }
    if (!checksFollow) {
      await prisma.dmLog.upsert({
        where: {
          automationId_commentId: {
            automationId: automation.id,
            commentId: dedupeId,
          },
        },
        create: {
          workspaceId: automation.workspaceId,
          automationId: automation.id,
          instagramAccountId: automation.instagramAccountId,
          commenterId: userId,
          commenterName: waiting?.username ?? null,
          commentText: "(button tap)",
          commentId: dedupeId,
          status: "FAILED",
          errorMessage: message,
        },
        update: { status: "FAILED", errorMessage: message },
      });
    }
    throw new AccountPausedError(message, pausedUntil);
  }

  // Personalize {username}. The postback carries only the tapper's IGSID.
  const commenterName = await resolveRecipientName({
    context: accessToken,
    workspaceId: automation.workspaceId,
    recipientId: userId,
    instagramAccountRowId: automation.instagramAccountId,
  });

  const contact = await ensureContactSafe({
    workspaceId: automation.workspaceId,
    instagramAccountId: automation.instagramAccountId,
    igsid: userId,
    username: commenterName,
    interactionAt,
  });
  // A request limit on this tap's follow check or follow prompt.
  const pauseForLimit = async (
    error: RateLimitError,
    step: "check" | "prompt"
  ): Promise<ConversationHold> => {
    const pause = await pauseAccountForLimit({
      instagramAccountId,
      workspaceId: automation.workspaceId,
      account: automation.instagramAccount.username,
      error,
    });
    return holdTapForPause({
      ...pauseScope,
      contact,
      commenterName,
      resumeAt: pause.resumeAt,
      step,
      error,
    });
  };

  // Follow-gate: before revealing the link, verify the user follows. On a
  // `followcheck:` tap a non-follower gets the prompt again (no quota spent);
  // on a read fallback a non-follower is silently skipped — the gate must not
  // be bypassable by just reading the DM and waiting. On a tap, following or
  // unverifiable (null) falls through and delivers the link — fail-open so a
  // real follower is never trapped. A tap on the second follow request skips
  // the check; that is recorded, so Diagnostics shows how often the link went
  // out without a confirmed follow.
  if (retryTap && automation.requireFollow) {
    await logWorkerEvent({
      workspaceId: automation.workspaceId,
      level: "INFO",
      message: "Follow gate skipped after the second follow request",
      payload: {
        automationId: automation.id,
        automationName: automation.name,
        userId,
        commenterName,
      },
    });
  } else if ((isFollowCheck || fallback) && automation.requireFollow) {
    let follows: boolean | null;
    try {
      // A request limit is thrown rather than read as unknown: a tap would
      // then get the link without a check, a read fallback nothing at all.
      follows = await getUserFollowStatus({
        context: accessToken,
        recipientId: userId,
        throwOnLimit: true,
      });
    } catch (error) {
      if (!isMetaThrottle(error)) throw error;
      if ((await pauseForLimit(error, "check")) !== "capped") return;
      if (fallback) {
        console.log(
          "[DM Worker] Read fallback not delivered:",
          formatError(error),
        );
        return;
      }
      throw error;
    }
    // A read fallback needs a confirmed follow. Instagram only reports follow
    // status once the person has tapped a button (before that it answers
    // "User consent is required", i.e. null), so failing open here handed the
    // link to anyone who read the opening DM and waited, follower or not.
    if (fallback && follows !== true) return;
    if (follows === false) {
      if (fallback) return;

      // A tap on an opening-DM button is not a claim to follow — most people
      // who tap it simply don't follow yet — so they get the follow prompt
      // right away. Only the prompt's own button earns the delayed re-check;
      // holding an opening tap for it left people staring at a silent chat.
      if (!fromOpeningDm) {
        // A `false` on a button tap: give the follow time to register and look
        // again, rather than rejecting someone who just followed.
        //
        // The job id is bucketed by the recheck window, not fixed per user.
        // BullMQ keeps completed jobs (removeOnComplete: count 1000) and silently
        // drops an add whose id is still retained, so a fixed id let a person be
        // re-checked once and then never again — their next false tap did
        // nothing at all, no link and no prompt. Bucketing still collapses a burst
        // of taps into a single re-check, which is what the fixed id was for.
        //
        // Jobs queued before re-checks were counted carry only `followRecheck`,
        // which meant one re-check done.
        const rechecksDone =
          job.data.followRecheckAttempt ?? (job.data.followRecheck ? 1 : 0);
        if (rechecksDone < FOLLOW_RECHECK_DELAYS_MS.length) {
          const delay = FOLLOW_RECHECK_DELAYS_MS[rechecksDone];
          const window = Math.floor(Date.now() / delay);
          await getDMQueue().add(
            POSTBACK_JOB_NAME,
            {
              ...job.data,
              followRecheck: true,
              followRecheckAttempt: rechecksDone + 1,
              // The tap's own time, kept through every pass: this job's
              // timestamp will be the time of this pass, not of the tap.
              tappedAt: tapTime(job),
            },
            {
              delay,
              jobId: `postback_recheck_${automation.id}_${userId}_${rechecksDone + 1}_${window}`,
            }
          );
          if (rechecksDone === 0) {
            await sendFollowRecheckAck({
              context: accessToken,
              instagramAccountId: automation.instagramAccount.instagramId,
              automationId: automation.id,
              userId,
              operationId,
              workspaceId: automation.workspaceId,
              account: automation.instagramAccount.username,
            });
          }
          return;
        }

        // Last `false`: they are genuinely not following. Record it — this
        // branch used to return without writing anything at all, so a gate that
        // turned people away left no trace and its rejection rate could not be
        // measured, only guessed at from complaints.
        await prisma.operationalEvent
          .create({
            data: {
              workspaceId: automation.workspaceId,
              source: "WORKER",
              level: "INFO",
              message: "Follow gate rejected a button tap",
              payload: {
                automationId: automation.id,
                automationName: automation.name,
                userId,
                commenterName,
              },
            },
          })
          .catch(() => {});
      }

      // After an opening-DM tap this is the first follow request. Otherwise
      // the person was asked before and the last re-check still saw no follow,
      // so this is the second request: its own text and label, falling back
      // to the first ones, and a ":retry" button whose tap gets the link.
      const secondRequest = !fromOpeningDm;
      const promptText = renderMessageWithoutLink({
        message:
          (secondRequest && automation.followPromptRetryMessage) ||
          automation.followPromptMessage ||
          "quick favor before i send your link. i don't make any money from this, it's free. if you want to support me, just don't unfollow after, and star the repo on github if it helps you. tap the button once you're following and i'll send it over",
        commenterName,
      });
      try {
        await sendPostbackOnce({
          operationId,
          send: () =>
            sendDirectMessageWithButton({
              context: accessToken,
              instagramAccountId: automation.instagramAccount.instagramId,
              userId: userId,
              text: promptText,
              buttonTitle:
                (secondRequest && automation.followPromptRetryButtonLabel) ||
                automation.followPromptButtonLabel ||
                "i'm following",
              payload: secondRequest
                ? `followcheck:${automation.id}:retry`
                : `followcheck:${automation.id}`,
            }),
        });
      } catch (error) {
        // A request limit: the account pauses, and the prompt goes out
        // after the pause (its claim is back, as for any refusal). A refused
        // prompt whose claim could not be given back is not tried again.
        // A prompt that cannot wait any more ended a link that waited
        // behind it (holdTapForPause).
        const limit = metaLimitOf(error);
        if (isMetaThrottle(error)) {
          if ((await pauseForLimit(error, "prompt")) !== "capped") return;
          console.log(
            "[DM Worker] Failed to re-send follow prompt:",
            formatError(error),
          );
          return;
        }
        if (limit) {
          await pauseAccountForLimit({
            instagramAccountId,
            workspaceId: automation.workspaceId,
            account: automation.instagramAccount.username,
            error: limit,
          });
        }
        console.log(
          "[DM Worker] Failed to re-send follow prompt:",
          formatError(error),
        );
      }
      // The person's link waited for the pause, and this copy asked them to
      // follow instead: the link does not come with it.
      if (pauseCopy) {
        await settleWaitingReveal(automation.id, userId, PAUSE_NO_FOLLOW_MESSAGE);
      }
      return;
    }
  }

  // A copy queued for the account's pause runs after the pause, and the link
  // may have reached the person meanwhile: from a read fallback that ran
  // once the pause was over, or from another of their taps that waited with
  // this one. A tap answered that way is not answered once more. (Every
  // other tap re-sends the link, as always.)
  if (pauseCopy) {
    const reveal = await prisma.dmLog.findUnique({
      where: {
        automationId_commentId: {
          automationId: automation.id,
          commentId: dedupeId,
        },
      },
      select: { status: true, dmSentAt: true },
    });
    if (
      reveal?.status === "SENT" &&
      reveal.dmSentAt &&
      reveal.dmSentAt.getTime() >= tapTime(job)
    ) {
      console.log(
        "[DM Worker] Tap already answered while it waited for the pause:",
        job.id,
      );
      return;
    }
  }

  const usage = await reserveWorkspaceDMSend(automation.workspaceId);
  if (!usage.allowed) {
    await prisma.dmLog.upsert({
      where: {
        automationId_commentId: {
          automationId: automation.id,
          commentId: dedupeId,
        },
      },
      create: {
        workspaceId: automation.workspaceId,
        automationId: automation.id,
        instagramAccountId: automation.instagramAccountId,
        commenterId: userId,
        commenterName,
        commentText: "(button tap)",
        commentId: dedupeId,
        status: "SKIPPED_PLAN_LIMIT",
        errorMessage: `Monthly DM limit reached (${usage.limit})`,
      },
      // With its reason: a link that waited for the account's pause showed
      // the time of its next try here.
      update: {
        status: "SKIPPED_PLAN_LIMIT",
        errorMessage: `Monthly DM limit reached (${usage.limit})`,
      },
    });
    return;
  }

  // The claim stays outside the send's error handling, as for a DM keyword
  // reply. A database error on it means nothing was sent: the reservation is
  // released (the retry takes its own) and the error is rethrown as it is,
  // so BullMQ retries the job. Read as a send error it would count as an
  // unknown delivery: the tap would be logged FAILED and unconfirmed and the
  // job ended for good, with the link never sent.
  let claimed: boolean;
  try {
    claimed = await claimPostbackDelivery(operationId);
  } catch (error) {
    await releaseWorkspaceDMReservation(
      automation.workspaceId,
      usage.periodStart,
    );
    throw error;
  }
  if (!claimed) {
    // An earlier run sent this link, or may have: never send it again.
    await releaseWorkspaceDMReservation(
      automation.workspaceId,
      usage.periodStart,
    );
    return;
  }

  try {
    await sendClaimedPostback({
      operationId,
      send: () =>
        sendRevealDirectMessage({
          accessToken: accessToken,
          automation: automation,
          userId: userId,
          commenterName: commenterName,
          context: "postback",
        }),
    });
    await prisma.dmLog.upsert({
      where: {
        automationId_commentId: {
          automationId: automation.id,
          commentId: dedupeId,
        },
      },
      create: {
        workspaceId: automation.workspaceId,
        automationId: automation.id,
        instagramAccountId: automation.instagramAccountId,
        commenterId: userId,
        commenterName,
        commentText: "(button tap)",
        commentId: dedupeId,
        status: "SENT",
        dmSentAt: new Date(),
      },
      update: { status: "SENT", dmSentAt: new Date(), errorMessage: null },
    });
  } catch (originalError) {
    const error = classifySendError(originalError);
    if (isConfirmedSendRejection(error)) await releaseWorkspaceDMReservation(
      automation.workspaceId,
      usage.periodStart,
    );

    // A request limit proves nothing was sent, and the account's next calls
    // would be refused as well. The account pauses, and the tap waits for
    // the end of the pause: sendClaimedPostback gave its claim back, and the
    // reservation went back above, as for any refusal. It is not retried by
    // BullMQ, whose retries would only run into the limit again. A refusal
    // whose claim could not be given back only pauses the account: a copy
    // would find the claim and send nothing.
    let errorMessage = formatError(error);
    const limit = metaLimitOf(originalError);
    if (limit) {
      const pause = await pauseAccountForLimit({
        instagramAccountId,
        workspaceId: automation.workspaceId,
        account: automation.instagramAccount.username,
        error: limit,
      });
      if (isMetaThrottle(error)) {
        const outcome = await holdTapForPause({
          ...pauseScope,
          contact,
          commenterName,
          resumeAt: pause.resumeAt,
          step: "link",
        });
        if (outcome !== "capped") return;
        errorMessage = `${pauseGaveUpMessage(pause.resumeAt)}. ${errorMessage}`;
      }
    }

    // The read fallback is speculative: it only runs when the user read the
    // opening DM and never tapped the button, which means they never messaged
    // us, which means the 24-hour window is closed and Meta rejects the send
    // ("outside of allowed window"). That is the expected outcome here, not a
    // failure the user can act on — so don't log it as FAILED and don't retry
    // it against a window that cannot reopen on its own. It still delivers in
    // the case that does work: the user replied by typing instead of tapping.
    if (fallback && !isDeliveryUnconfirmed(error)) {
      console.log(
        "[DM Worker] Read fallback not delivered (messaging window closed):",
        errorMessage,
      );
      return;
    }

    await prisma.dmLog.upsert({
      where: {
        automationId_commentId: {
          automationId: automation.id,
          commentId: dedupeId,
        },
      },
      create: {
        workspaceId: automation.workspaceId,
        automationId: automation.id,
        instagramAccountId: automation.instagramAccountId,
        commenterId: userId,
        commenterName,
        commentText: "(button tap)",
        commentId: dedupeId,
        status: "FAILED",
        errorMessage,
        dmDeliveryUnconfirmed: isDeliveryUnconfirmed(error),
      },
      update: {
        status: "FAILED",
        errorMessage,
        dmDeliveryUnconfirmed: isDeliveryUnconfirmed(error),
      },
    });
    throw error;
  }

  // The link is out and recorded. Nothing that follows may turn this delivery
  // into a failure or a retry, so it runs outside the send's try block.
  await afterLinkDelivered({
    automation,
    userId,
    commenterName,
    contactId: contact?.id ?? null,
    via: fallback ? "read-fallback" : "tap",
    // A link a re-check delivers counts from the tap, which opened the window.
    interactionAt: fallback ? null : tapTime(job),
    triggerId: tapId,
  });
}

/**
 * Send the scheduled appreciation follow-up. Runs after its delay elapses.
 * Best-effort: if the message can't be delivered (e.g. the 24-hour messaging
 * window closed because the delay was long), it is logged, not retried forever.
 */
async function processFollowUp(job: Job<ProcessFollowUpJob>): Promise<void> {
  const { instagramAccountId, userId, automationId, commenterName } = job.data;

  const automation = await prisma.automation.findFirst({
    where: { id: automationId, isActive: true, ...connectionScope(job.data) },
    include: { instagramAccount: true },
  });

  if (
    !automation ||
    !automation.followUpEnabled ||
    !automation.followUpMessage?.trim() ||
    automation.instagramAccount.instagramId !== instagramAccountId ||
    !hasInstagramCredentials(automation.instagramAccount)
  ) {
    return;
  }

  let accessToken: InstagramContext;
  try {
    accessToken = await createInstagramContext(
      automation.instagramAccount,
      `${job.id}:${automation.id}`
    );
  } catch {
    return;
  }

  // Meta refuses this account's calls for a request limit (the account is
  // paused): the follow-up waits for the end of the pause instead.
  const pausedUntil = await checkAccountPause(instagramAccountId);
  if (pausedUntil !== null) {
    return holdFollowUpForPause(job, automation, pausedUntil);
  }

  try {
    await sendDirectMessage({
      context: accessToken,
      instagramAccountId: automation.instagramAccount.instagramId,
      userId: userId,
      message: renderMessageWithoutLink({
        message: automation.followUpMessage,
        commenterName: commenterName ?? null,
      }),
    });
  } catch (error) {
    // A request limit: nothing was sent. The account pauses, and the
    // follow-up goes out after the pause.
    if (isMetaThrottle(error)) {
      const pause = await pauseAccountForLimit({
        instagramAccountId,
        workspaceId: automation.workspaceId,
        account: automation.instagramAccount.username,
        error,
      });
      return holdFollowUpForPause(job, automation, pause.resumeAt);
    }
    console.log(
      "[DM Worker] Failed to send follow-up message:",
      formatError(error)
    );
  }
}

/**
 * The follow-up meets its account's pause, before anything was sent: it goes
 * out after the pause, as followup_<campaign>_<person>_pause_<n>, while
 * Instagram's window from the person's last tap or DM (their contact) is
 * still open then. Best effort, like the follow-up itself: what keeps it
 * from waiting is logged, and this job never fails. The follow-up has no
 * claim, so a BullMQ retry next to a copy that was queued after all could
 * send it twice.
 */
async function holdFollowUpForPause(
  job: Job<ProcessFollowUpJob>,
  automation: { id: string; workspaceId: string; instagramAccountId: string },
  resumeAt: number
): Promise<void> {
  try {
    const contact = await prisma.contact.findUnique({
      where: {
        instagramAccountId_igsid: {
          instagramAccountId: automation.instagramAccountId,
          igsid: job.data.userId,
        },
        workspaceId: automation.workspaceId,
      },
      select: { lastInteractionAt: true },
    });
    const outcome = await holdConversation({
      name: FOLLOWUP_JOB_NAME,
      data: job.data,
      baseJobId: `followup_${automation.id}_${job.data.userId}`,
      instagramAccountId: job.data.instagramAccountId,
      resumeAt,
      windowFrom: latestTime(contact?.lastInteractionAt),
    });
    if (outcome === "window-closed") {
      console.log(
        `[DM Worker] Follow-up not sent: the messaging window closes before the account's pause ends (${formatPauseTime(resumeAt)})`,
        job.id
      );
    } else if (outcome === "capped") {
      console.log(
        "[DM Worker] Follow-up not sent:",
        pauseGaveUpMessage(resumeAt),
        job.id
      );
    }
  } catch (error) {
    console.error(
      "[DM Worker] Follow-up not put back for the account's pause:",
      formatError(error)
    );
  }
}

// When the DM behind a message job arrived (epoch ms): a copy queued for the
// account's pause carries it, the webhook's own job was queued on arrival.
function messageTime(job: Job<ProcessMessageJob>): number {
  return job.data.receivedAt ?? job.timestamp ?? Date.now();
}

/**
 * The reply to a DM meets its account's pause, before anything was sent: the
 * pause was found, or Instagram refused the follow check or the reply with a
 * request limit (sendClaimedPostback gave the reply's claim back, as for any
 * refusal). The whole DM waits for the end of the pause, as
 * message_<account>_<mid>_pause_<n> (the webhook job's id plus the wait): the
 * copy answers it for every campaign again, and each reply's claim and DmLog
 * row keep one that went out from going out twice. Meanwhile this campaign's
 * row shows PENDING with the next try.
 *
 * A closed window and "capped" log the reply FAILED: the caller moves on to
 * the next campaign after the first and fails the job after the second, as
 * after a refused send.
 */
async function holdMessageForPause({
  job,
  contact,
  row,
  resumeAt,
  error,
}: {
  job: Job<ProcessMessageJob>;
  contact: ContactSummary | null;
  /** The reply's DmLog row as this job would create it. */
  row: Prisma.DmLogUncheckedCreateInput;
  resumeAt: number;
  /** What Instagram answered, if it was asked. */
  error?: unknown;
}): Promise<ConversationHold> {
  const { instagramAccountId, messageId } = job.data;
  const outcome = await holdConversation({
    name: MESSAGE_JOB_NAME,
    data: { ...job.data, receivedAt: messageTime(job) },
    baseJobId: `message_${instagramAccountId}_${Buffer.from(messageId).toString("base64url")}`,
    instagramAccountId,
    resumeAt,
    windowFrom: latestTime(contact?.lastInteractionAt, messageTime(job)),
    beforeQueue: (reason) => markDmLogWaiting(row, reason),
  });
  if (outcome === "held") return outcome;

  const gaveUp = pauseGaveUpMessage(resumeAt);
  const errorMessage =
    outcome === "window-closed"
      ? pauseWindowClosedMessage(resumeAt)
      : error
        ? `${gaveUp}. ${formatError(error)}`
        : gaveUp;
  const attempts = outcome === "capped" ? { attempts: job.attemptsMade + 1 } : {};
  await prisma.dmLog.upsert({
    where: {
      automationId_commentId: {
        automationId: row.automationId,
        commentId: row.commentId,
      },
    },
    create: { ...row, status: "FAILED", errorMessage, ...attempts },
    update: { status: "FAILED", errorMessage, ...attempts },
  });
  return outcome;
}

/**
 * A DM's copy, queued for the account's pause, answers it for the campaigns
 * that answer it now. A campaign that no longer does (paused, its DM
 * trigger switched off, its keywords changed, or its account connected
 * anew) leaves its reply waiting for the pause (PENDING): that reply is
 * logged FAILED. Only the copies would settle it, and while it waits the
 * campaign's read fallback for the person stands back (processPostback).
 * Runs before the copy answers anything, so it holds whichever way the copy
 * ends.
 */
async function settleUnansweredDm(
  job: Job<ProcessMessageJob>,
  answering: string[]
): Promise<void> {
  const { instagramAccountId, accountConnectionId, messageId } = job.data;
  await prisma.dmLog.updateMany({
    where: {
      commentId: `dm:${messageId}`,
      status: "PENDING",
      // This DM's account only, the connection its job is bound to as for
      // its campaigns (connectionScope).
      ...(accountConnectionId
        ? { instagramAccountId: accountConnectionId }
        : { instagramAccount: { instagramId: instagramAccountId } }),
      ...(answering.length > 0 ? { automationId: { notIn: answering } } : {}),
    },
    data: { status: "FAILED", errorMessage: PAUSE_CAMPAIGN_CHANGED_MESSAGE },
  });
}

/**
 * Reply to an inbound DM whose text matches a campaign's keywords.
 *
 * The user has messaged us, so the conversation is already open: this path
 * skips the opening DM (which exists to work around private-reply limits from
 * comments) and delivers the reveal directly, honouring the follow gate.
 * Dedup is per inbound message id, so each message triggers at most one reply.
 */
async function processMessage(job: Job<ProcessMessageJob>): Promise<void> {
  const { instagramAccountId, messageId, messageText, senderId } = job.data;

  const automations = await prisma.automation.findMany({
    where: {
      ...connectionScope(job.data),
      dmTriggerEnabled: true,
      isActive: true,
      instagramAccount: { instagramId: instagramAccountId },
    },
    include: {
      instagramAccount: true,
      workspace: true,
      trackedLinks: {
        select: { slug: true, label: true, destinationUrl: true },
        orderBy: TRACKED_LINK_ORDER,
      },
    },
    orderBy: { createdAt: "asc" },
  });

  // Every inbound DM records its sender as a contact, whether or not a
  // campaign answers it: the DM opens Instagram's 24-hour messaging window,
  // which later messages to this person depend on.
  const contact = await recordMessageSender(job, automations[0]);
  // The name the contact has stored. A DM carries no handle, so a name found
  // below is stored once, not again for every matching campaign.
  let contactName = contact?.username ?? null;

  const dedupeId = `dm:${messageId}`;

  // The campaigns that answer this DM, in order, each with its keyword.
  const answering = automations.flatMap((automation) => {
    const matchResult = automation.matchAnyWord
      ? { matched: true, matchedKeyword: null }
      : matchKeywords(
          messageText,
          automation.keywords,
          automation.wholeWordMatch
        );
    return matchResult.matched
      ? [{ automation, matchedKeyword: matchResult.matchedKeyword }]
      : [];
  });

  if (job.data.pauseRequeue) {
    await settleUnansweredDm(
      job,
      answering.map(({ automation }) => automation.id)
    );
  }

  for (const { automation, matchedKeyword } of answering) {
    const existingLog = await prisma.dmLog.findUnique({
      where: {
        automationId_commentId: {
          automationId: automation.id,
          commentId: dedupeId,
        },
      },
    });

    // Already replied to this message (or deliberately skipped it) — a retry
    // of the job must not send a second DM.
    if (
      existingLog?.status === "SENT" ||
      existingLog?.status === "SKIPPED_PLAN_LIMIT" ||
      existingLog?.dmDeliveryUnconfirmed
    ) {
      continue;
    }

    const logBase = {
      workspaceId: automation.workspaceId,
      automationId: automation.id,
      instagramAccountId: automation.instagramAccountId,
      commenterId: senderId,
      commentText: messageText,
      commentId: dedupeId,
      matchedKeyword,
    };

    if (!hasInstagramCredentials(automation.instagramAccount)) {
      await prisma.dmLog.upsert({
        where: {
          automationId_commentId: {
            automationId: automation.id,
            commentId: dedupeId,
          },
        },
        create: {
          ...logBase,
          status: "FAILED",
          errorMessage: "No Instagram access token available",
        },
        update: {
          status: "FAILED",
          errorMessage: "No Instagram access token available",
        },
      });
      continue;
    }

    let accessToken: InstagramContext;
    try {
      accessToken = await createInstagramContext(
        automation.instagramAccount,
        `${job.id}:${automation.id}`
      );
    } catch {
      await prisma.dmLog.upsert({
        where: {
          automationId_commentId: {
            automationId: automation.id,
            commentId: dedupeId,
          },
        },
        create: {
          ...logBase,
          status: "FAILED",
          errorMessage: "Failed to decrypt Instagram access token",
        },
        update: {
          status: "FAILED",
          errorMessage: "Failed to decrypt Instagram access token",
        },
      });
      continue;
    }

    // Meta refuses this account's calls for a request limit (the account is
    // paused): nothing is looked up, checked, reserved, claimed or sent. The
    // DM waits for the end of the pause, and its copy answers it for this
    // campaign and the ones after it.
    const pausedUntil = await checkAccountPause(instagramAccountId);
    if (pausedUntil !== null) {
      const outcome = await holdMessageForPause({
        job,
        contact,
        row: { ...logBase, commenterName: contactName },
        resumeAt: pausedUntil,
      });
      if (outcome === "held") return;
      if (outcome === "window-closed") continue;
      throw new AccountPausedError(pauseGaveUpMessage(pausedUntil), pausedUntil);
    }

    // Personalize {username}. The messages webhook carries only the sender's
    // IGSID, so the handle is recovered from an earlier send or read live.
    const commenterName = await resolveRecipientName({
      context: accessToken,
      workspaceId: automation.workspaceId,
      recipientId: senderId,
      instagramAccountRowId: automation.instagramAccountId,
    });
    // A contact stored without a name keeps the one found here, for the
    // contact list and the next message, which then needs no lookup. Best
    // effort: the reply does not depend on it.
    if (contact && commenterName && commenterName !== contactName) {
      contactName = commenterName;
      await prisma.contact
        .updateMany({
          where: { id: contact.id },
          data: { username: commenterName },
        })
        .catch((error) =>
          console.error(
            "[DM Worker] Failed to store the contact's name:",
            formatError(error)
          )
        );
    }

    // Follow gate: anyone not confirmed as a follower gets the prompt instead of
    // the link, with the same `followcheck:` button that re-verifies on tap.
    // `null` (unverifiable) prompts too — this is first contact, exactly like a
    // comment, so it follows processComment's fail-closed rule rather than the
    // postback path's fail-open one. Fail-open is only safe after a tap, where
    // the user has already claimed to follow; here it would hand the link to
    // anyone whose status the API happens not to resolve.
    let sendFollowPrompt = false;
    if (automation.requireFollow) {
      let follows: boolean | null;
      try {
        // A request limit is thrown rather than read as unknown, which would
        // send the follow prompt to someone who may well follow.
        follows = await getUserFollowStatus({
          context: accessToken,
          recipientId: senderId,
          throwOnLimit: true,
        });
      } catch (error) {
        if (!isMetaThrottle(error)) throw error;
        const pause = await pauseAccountForLimit({
          instagramAccountId,
          workspaceId: automation.workspaceId,
          account: automation.instagramAccount.username,
          error,
        });
        const outcome = await holdMessageForPause({
          job,
          contact,
          row: { ...logBase, commenterName },
          resumeAt: pause.resumeAt,
          error,
        });
        if (outcome === "held") return;
        if (outcome === "window-closed") continue;
        throw error;
      }
      sendFollowPrompt =
        accessToken.provider === "ZERNIO"
          ? follows === false
          : follows !== true;
    }

    const usage = await reserveWorkspaceDMSend(automation.workspaceId);
    if (!usage.allowed) {
      await prisma.dmLog.upsert({
        where: {
          automationId_commentId: {
            automationId: automation.id,
            commentId: dedupeId,
          },
        },
        create: {
          ...logBase,
          status: "SKIPPED_PLAN_LIMIT",
          errorMessage: `Monthly DM limit reached (${usage.limit})`,
        },
        update: {
          status: "SKIPPED_PLAN_LIMIT",
          errorMessage: `Monthly DM limit reached (${usage.limit})`,
        },
      });
      continue;
    }

    // A durable claim per account, campaign and inbound message, taken before
    // Instagram is called. The DmLog check above only sees rows that were
    // written: a retry after a send whose log write failed, or the same
    // message redelivered once BullMQ no longer remembers its job id, used to
    // send the reply a second time.
    const operationId = createHash("sha256")
      .update(JSON.stringify([
        automation.instagramAccountId,
        "dm",
        automation.id,
        messageId,
      ]))
      .digest("hex");

    // The claim stays outside the send's error handling, like the comment
    // claim. A database error on it means nothing was sent: the reservation is
    // released (the retry takes its own) and the error is rethrown as it is,
    // so BullMQ retries the job. Read as a send error it would count as an
    // unknown delivery and end the job for good, with the reply never sent.
    let claimed: boolean;
    try {
      claimed = await claimPostbackDelivery(operationId);
    } catch (error) {
      await releaseWorkspaceDMReservation(
        automation.workspaceId,
        usage.periodStart
      );
      throw error;
    }
    if (!claimed) {
      // An earlier run sent this reply, or may have: never send it again.
      await releaseWorkspaceDMReservation(
        automation.workspaceId,
        usage.periodStart
      );
      continue;
    }

    let linkSent = false;
    try {
      await sendClaimedPostback({
        operationId,
        send: () =>
          sendFollowPrompt
            ? sendDirectMessageWithButton({
                context: accessToken,
                instagramAccountId: automation.instagramAccount.instagramId,
                userId: senderId,
                text: renderMessageWithoutLink({
                  message:
                    automation.followPromptMessage ||
                    "Almost there! Follow me and tap the button below to grab your link 💛",
                  commenterName,
                }),
                buttonTitle:
                  automation.followPromptButtonLabel || "I'm following ✅",
                payload: `followcheck:${automation.id}`,
              })
            : sendRevealDirectMessage({
                accessToken: accessToken,
                automation: automation,
                userId: senderId,
                commenterName: commenterName,
                context: "message trigger",
              }),
      });
      // The follow prompt carries no link, so nothing follows it yet: the tap
      // on its button delivers the link and schedules the follow-up.
      linkSent = !sendFollowPrompt;

      await prisma.dmLog.upsert({
        where: {
          automationId_commentId: {
            automationId: automation.id,
            commentId: dedupeId,
          },
        },
        create: {
          ...logBase,
          commenterName,
          status: "SENT",
          dmSentAt: new Date(),
        },
        update: {
          status: "SENT",
          dmSentAt: new Date(),
          errorMessage: null,
        },
      });
    } catch (originalError) {
      const error = classifySendError(originalError);
      // Like a button tap: the reservation is kept when Instagram may have
      // delivered the reply, and an unknown outcome ends the job without a
      // retry (see processJob), since a retry could only send it again.
      if (isConfirmedSendRejection(error)) {
        await releaseWorkspaceDMReservation(
          automation.workspaceId,
          usage.periodStart
        );
      }
      // A request limit proves nothing was sent: the account pauses, and the
      // DM waits for the end of the pause, its claim and reservation back as
      // for any refusal. A refusal whose claim could not be given back only
      // pauses the account: a copy would find the claim and send nothing.
      const limit = metaLimitOf(originalError);
      if (limit) {
        const pause = await pauseAccountForLimit({
          instagramAccountId,
          workspaceId: automation.workspaceId,
          account: automation.instagramAccount.username,
          error: limit,
        });
        if (isMetaThrottle(error)) {
          const outcome = await holdMessageForPause({
            job,
            contact,
            row: { ...logBase, commenterName },
            resumeAt: pause.resumeAt,
            error,
          });
          if (outcome === "held") return;
          if (outcome === "window-closed") continue;
          throw error;
        }
      }
      await prisma.dmLog.upsert({
        where: {
          automationId_commentId: {
            automationId: automation.id,
            commentId: dedupeId,
          },
        },
        create: {
          ...logBase,
          commenterName,
          status: "FAILED",
          attempts: job.attemptsMade + 1,
          errorMessage: formatError(error),
          dmDeliveryUnconfirmed: isDeliveryUnconfirmed(error),
        },
        update: {
          status: "FAILED",
          attempts: job.attemptsMade + 1,
          errorMessage: formatError(error),
          dmDeliveryUnconfirmed: isDeliveryUnconfirmed(error),
        },
      });
      throw error;
    }

    // Outside the send's try block, so a failure here can never mark the
    // delivered reply FAILED or retry the job into a second send.
    if (linkSent) {
      await afterLinkDelivered({
        automation,
        userId: senderId,
        commenterName,
        contactId: contact?.id ?? null,
        via: "dm",
        interactionAt: messageTime(job),
        triggerId: messageId,
      });
    }
  }
}

/**
 * Record the sender of an inbound DM as a contact, stamped with the time of
 * the DM. A campaign that may answer it already names the account; without
 * one the account is looked up. Best effort, like every contact write on a
 * send path: a failure is logged and the DM is still handled.
 */
async function recordMessageSender(
  job: Job<ProcessMessageJob>,
  campaign: { instagramAccountId: string; workspaceId: string } | undefined
): Promise<ContactSummary | null> {
  const { instagramAccountId, accountConnectionId, senderId } = job.data;
  try {
    const account = campaign
      ? { id: campaign.instagramAccountId, workspaceId: campaign.workspaceId }
      : await prisma.instagramAccount.findUnique({
          where: { instagramId: instagramAccountId },
          select: { id: true, workspaceId: true },
        });
    // A job bound to a connection that has since been replaced is not
    // credited to the new one, just as its campaigns are not (connectionScope).
    if (
      !account ||
      (accountConnectionId && account.id !== accountConnectionId)
    ) {
      return null;
    }
    return await ensureContactSafe({
      workspaceId: account.workspaceId,
      instagramAccountId: account.id,
      igsid: senderId,
      interactionAt: new Date(messageTime(job)),
    });
  } catch (error) {
    console.error(
      "[DM Worker] Failed to record the DM sender:",
      formatError(error)
    );
    return null;
  }
}

async function dispatchJob(job: Job<DmQueueJob>): Promise<void> {
  if (job.name === POSTBACK_JOB_NAME) {
    return processPostback(job as Job<ProcessPostbackJob>);
  }
  if (job.name === FOLLOWUP_JOB_NAME) {
    return processFollowUp(job as Job<ProcessFollowUpJob>);
  }
  if (job.name === MESSAGE_JOB_NAME) {
    return processMessage(job as Job<ProcessMessageJob>);
  }
  if (job.name === OFFER_JOB_NAME) {
    return processOffer(job as Job<ProcessOfferJob>);
  }
  // Every other name used to fall through to processComment. A job type this
  // worker does not know yet (one added by a newer release, still delayed in
  // Redis when the worker is rolled back) would then be read as a comment.
  // Ignore it instead. A job without a name still counts as a comment.
  if (job.name && job.name !== COMMENT_JOB_NAME) {
    console.warn("[DM Worker] Ignoring unknown job", job.name, job.id);
    return;
  }
  return processComment(job as Job<ProcessCommentJob>);
}

/**
 * Sends Meta answered with an error but may well have delivered anyway.
 *
 * Meta returns the generic code 1 OAuthException on /messages *after* the DM
 * has reached the recipient — observed in production: a user tapped the reply's
 * button 30 seconds after a send this worker had already marked FAILED. Logging
 * that as a plain failure is harmful twice over: the job is retried (up to
 * BACKOFF_DELAYS.length times, each retry another copy in the same inbox), and
 * the comment never satisfies the reconciler's "handled" test, so every sweep
 * re-enqueues it for the whole lookback window. Together that sent one person
 * dozens of identical DMs.
 *
 * Flagging it as unconfirmed instead is exactly what dmDeliveryUnconfirmed is
 * for: the sweep's dedup already treats that as handled, and processComment
 * skips a DM whose delivery is unconfirmed. The trade-off is deliberate — a
 * code 1 that really did fail means that person gets no DM and can comment
 * again, which is far better than spamming someone who already received it.
 */
async function processJob(job: Job<DmQueueJob>): Promise<void> {
  try {
    await dispatchJob(job);
  } catch (error) {
    // formatError() takes unknown; isDeliveryUnconfirmed() is a type guard on
    // Error subclasses, but keep using formatError() for a consistent message
    // format across every UnrecoverableError thrown from this worker.
    if (isDeliveryUnconfirmed(error))
      throw new UnrecoverableError(formatError(error));
    throw error;
  }
}

async function recordWorkerFailure(
  job: Job<DmQueueJob> | undefined,
  error: Error
) {
  try {
    const instagramAccountId = job?.data.instagramAccountId;
    const commentId =
      job && "commentId" in job.data ? job.data.commentId : null;
    const account = instagramAccountId
      ? await prisma.instagramAccount.findUnique({
          where: { instagramId: instagramAccountId },
          select: { workspaceId: true },
        })
      : null;

    await prisma.operationalEvent.create({
      data: {
        workspaceId: account?.workspaceId ?? null,
        source: "WORKER",
        level: "ERROR",
        message: `DM worker job ${job?.id ?? "unknown"} failed: ${error.message}`,
        payload: {
          jobId: job?.id ?? null,
          attemptsMade: job?.attemptsMade ?? null,
          instagramAccountId: instagramAccountId ?? null,
          commentId,
        },
      },
    });

    await recordWorkerAlert({
      level: "error",
      message: error.message,
      jobId: job?.id,
      instagramAccountId,
      commentId: commentId ?? undefined,
    });
  } catch (recordError) {
    console.error(
      "[DM Worker] Failed to record worker failure:",
      formatError(recordError)
    );
  }
}

export function createDMWorker(): Worker<DmQueueJob> {
  const worker = new Worker<DmQueueJob>("dm-processing", processJob, {
    connection: getRedisConnection(),
    concurrency: 5,
    settings: {
      backoffStrategy: (attemptsMade: number) =>
        BACKOFF_DELAYS[Math.min(attemptsMade - 1, BACKOFF_DELAYS.length - 1)],
    },
  });

  worker.on("completed", (job) => {
    console.log(`[DM Worker] Job ${job.id} completed`);
  });

  worker.on("failed", (job, err) => {
    console.error(
      `[DM Worker] Job ${job?.id} failed (attempt ${job?.attemptsMade}):`,
      err.message
    );
    void recordWorkerFailure(job, err);
  });

  worker.on("error", (err) => {
    console.error("[DM Worker] Worker error:", err.message);
    void prisma.operationalEvent
      .create({
        data: {
          source: "WORKER",
          level: "ERROR",
          message: `DM worker process error: ${err.message}`,
          payload: { name: err.name },
        },
      })
      .catch((recordError) => {
        console.error(
          "[DM Worker] Failed to record worker process error:",
          formatError(recordError)
        );
      });
  });

  return worker;
}

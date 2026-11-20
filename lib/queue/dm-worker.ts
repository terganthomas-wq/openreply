import {
  classifySendError,
  hasLegacyUnconfirmedDelivery,
  isConfirmedSendRejection,
  isDeliveryUnconfirmed,
} from "@/lib/instagram/delivery-errors";
import { claimCommentDelivery, MAX_COMMENT_SEND_ATTEMPTS } from "./comment-delivery";
import { afterLinkDelivered } from "./after-delivery";
import {
  claimPostbackDelivery,
  formatError,
  isTemplateRejection,
  logWorkerEvent,
  sendClaimedPostback,
  sendPostbackOnce,
} from "./send-helpers";
import { isQuestionComment } from "@/lib/automation/question-filter";
import { ensureContactSafe, type ContactSummary } from "@/lib/contacts/store";
import { OFFER_PAYLOAD_PREFIX } from "@/lib/offers/schedule";
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

// When the tap behind a postback job happened (epoch ms). A follow re-check
// carries the time of the tap it repeats; a tap is its own job's timestamp.
function tapTime(job: Job<ProcessPostbackJob>): number {
  return job.data.tappedAt ?? job.timestamp ?? Date.now();
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

  const automations = await prisma.automation.findMany({
    where: {
      ...connectionScope(job.data),
      // Match campaigns bound to this specific post, plus any-post campaigns.
      // A comment left on an ad carries the ad's own media id, while the
      // campaign is bound to the post the ad was created from, so both ids
      // have to be considered or the comment is dropped without a trace.
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
    include: {
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
    },
    orderBy: { createdAt: "asc" },
  });

  // Campaigns bound to the commented post go before any-post campaigns. Only
  // the first campaign to send can use the comment's one private reply, and a
  // campaign set up for this very post is the one meant to answer it. Bound is
  // read from postId, not matchAnyPost, which an edit can leave set next to a
  // post. The sort is stable, so the oldest campaign of each group stays first.
  const boundToThisPost = (postId: string | null) =>
    Boolean(postId) && (postId === mediaId || postId === originalMediaId);
  automations.sort(
    (a, b) =>
      Number(boundToThisPost(b.postId)) - Number(boundToThisPost(a.postId))
  );

  // Recorded once per job, by the first campaign with work to do for this
  // comment. Undefined until then, null when that write failed.
  let contactId: string | null | undefined;

  for (const automation of automations) {
    // A campaign can leave questions to a human. The raw text is checked: the
    // keyword matcher turns the question mark into a space.
    if (automation.ignoreQuestionComments && isQuestionComment(commentText)) {
      continue;
    }

    // "Any word" campaigns fire on every comment; otherwise require a keyword hit.
    const matchResult = automation.matchAnyWord
      ? { matched: true, matchedKeyword: null }
      : matchKeywords(
          commentText,
          automation.keywords,
          automation.wholeWordMatch
        );

    if (!matchResult.matched) {
      continue;
    }

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
    // the public reply belongs to that campaign.
    if (
      existingLog?.status === "SKIPPED_PLAN_LIMIT" ||
      existingLog?.status === "SKIPPED_DEDUP"
    ) {
      continue;
    }
    if (
      !needsDm &&
      (!dmWentOut || alreadyPublicReplied || existingLog?.publicReplyDeliveryUnconfirmed || !automation.publicReplyEnabled)
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
      const replyPool =
        automation.publicReplyMessages.length > 0
          ? automation.publicReplyMessages
          : automation.publicReplyMessage
            ? [automation.publicReplyMessage]
            : [];
      if (
        !automation.publicReplyEnabled ||
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
    // promises a message that never comes.
    const privateReplyUsedBy = await prisma.dmLog.findFirst({
      where: {
        commentId,
        status: "SENT",
        automationId: { not: automation.id },
      },
      select: { automation: { select: { name: true } } },
    });
    if (privateReplyUsedBy) {
      await prisma.dmLog.update({
        where: {
          automationId_commentId: { automationId: automation.id, commentId },
        },
        data: {
          status: "SKIPPED_DEDUP",
          matchedKeyword: matchResult.matchedKeyword,
          errorMessage: `Another campaign (${privateReplyUsedBy.automation?.name ?? "unknown"}) already sent the one private reply Instagram allows for this comment`,
        },
      });
      continue;
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
            jobId: `comment_${instagramAccountId}_${commentId}_retry_${requeueAttempt + 1}`,
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
      const alreadyFollows = await getUserFollowStatus({
        context: accessToken,
        recipientId: commenterId,
      });
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
      claimed = await claimCommentDelivery(automation.id, commentId, "dm");
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
      await prisma.dmLog.update({
        where: { automationId_commentId: { automationId: automation.id, commentId } },
        data: {
          status: delivered ? "SENT" : "FAILED",
          ...(delivered ? { dmSentAt: new Date() } : {}),
          errorMessage: formatError(sendError),
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
async function sendFollowRecheckAck({
  context,
  instagramAccountId,
  automationId,
  userId,
  operationId,
}: {
  context: InstagramContext;
  instagramAccountId: string;
  automationId: string;
  userId: string;
  operationId: string | null;
}): Promise<void> {
  const message = process.env.FOLLOW_RECHECK_ACK_MESSAGE?.trim();
  if (!message) return;
  try {
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
    console.log(
      "[DM Worker] Failed to send follow re-check acknowledgement:",
      formatError(error),
    );
  }
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
    if (
      existingReveal?.status === "SENT" ||
      existingReveal?.dmDeliveryUnconfirmed
    )
      return;
  }

  let accessToken: InstagramContext;
  try {
    accessToken = await createInstagramContext(
      automation.instagramAccount,
      `${job.id}:${automation.id}`,
    );
  } catch {
    return;
  }

  // Personalize {username}. The postback carries only the tapper's IGSID.
  const commenterName = await resolveRecipientName({
    context: accessToken,
    workspaceId: automation.workspaceId,
    recipientId: userId,
    instagramAccountRowId: automation.instagramAccountId,
  });

  // The tapper becomes, or stays, a contact. A tap opens Instagram's 24-hour
  // messaging window, so it stamps the tap's time. A read fallback is no
  // interaction, and a re-check repeats a tap that was stamped already.
  const realTap = !fallback && !job.data.followRecheck;
  const contact = await ensureContactSafe({
    workspaceId: automation.workspaceId,
    instagramAccountId: automation.instagramAccountId,
    igsid: userId,
    username: commenterName,
    interactionAt: realTap ? new Date(job.timestamp ?? Date.now()) : null,
  });

  // This tap, by Instagram's message id. A follow re-check carries the mid
  // of the tap it repeats, and a redelivered webhook the same mid again.
  const tapId = job.data.mid ?? job.id ?? payload;
  const operationId = createHash("sha256")
    .update(JSON.stringify([
      automation.instagramAccountId,
      automation.id,
      userId,
      tapId,
    ]))
    .digest("hex");

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
    const follows = await getUserFollowStatus({
      context: accessToken,
      recipientId: userId,
    });
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
        console.log(
          "[DM Worker] Failed to re-send follow prompt:",
          formatError(error),
        );
      }
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
      update: { status: "SKIPPED_PLAN_LIMIT" },
    });
    return;
  }

  try {
    const delivered = await sendPostbackOnce({
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
    if (!delivered) {
      await releaseWorkspaceDMReservation(
        automation.workspaceId,
        usage.periodStart,
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
        formatError(error),
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
        errorMessage: formatError(error),
        dmDeliveryUnconfirmed: isDeliveryUnconfirmed(error),
      },
      update: {
        status: "FAILED",
        errorMessage: formatError(error),
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
    console.log(
      "[DM Worker] Failed to send follow-up message:",
      formatError(error)
    );
  }
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

  for (const automation of automations) {
    const matchResult = automation.matchAnyWord
      ? { matched: true, matchedKeyword: null }
      : matchKeywords(
          messageText,
          automation.keywords,
          automation.wholeWordMatch
        );

    if (!matchResult.matched) continue;

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
      matchedKeyword: matchResult.matchedKeyword,
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
      const follows = await getUserFollowStatus({
        context: accessToken,
        recipientId: senderId,
      });
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
        interactionAt: job.timestamp ?? Date.now(),
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
      interactionAt: new Date(job.timestamp ?? Date.now()),
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

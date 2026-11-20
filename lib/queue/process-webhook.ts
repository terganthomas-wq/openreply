import { prisma } from '@/lib/db/client';
import { COMMENT_JOB_NAME, getDMQueue, MESSAGE_JOB_NAME, POSTBACK_JOB_NAME } from '@/lib/queue/client';
import { parseCommentEvents, parseMessageEvents, parsePostbackEvents, parseReadEvents } from '@/lib/meta/webhook';
import { Prisma, type InstagramProvider } from '@/app/generated/prisma/client';

const OPENING_DM_READ_FALLBACK_DELAY_MS = 5 * 60 * 1000;
type InstagramPayload = Parameters<typeof parseCommentEvents>[0];

// DmLog rows that stand for something other than a comment carry a prefix in
// place of the comment id: "reveal:<user>" for a link a button tap delivered,
// "dm:<mid>" for the answer to a DM keyword.
function isCommentRow(commentId: string): boolean {
  return !commentId.startsWith('reveal:') && !commentId.startsWith('dm:');
}

export async function processInstagramWebhook({ payload: incoming, provider, workspaceId }: {
  payload: InstagramPayload; provider: InstagramProvider; workspaceId?: string;
}) {
  if (incoming.object !== 'instagram' || !Array.isArray(incoming.entry)) return;
  // Every DM the account sends comes back as an echo, which the parsers drop.
  // A payload that holds nothing else would still cost an account lookup and a
  // WebhookEvent insert and update, and wake the database for nothing. Nothing
  // reads such a row: Diagnostics shows failed events only, and the sweep
  // reads comment payloads.
  const hasWork = [parseCommentEvents, parsePostbackEvents, parseMessageEvents, parseReadEvents]
    .some((parse) => parse(incoming).length > 0);
  if (!hasWork) return;
  const accounts = await prisma.instagramAccount.findMany({
    where: { instagramId: { in: incoming.entry.map(e => e.id) }, provider, ...(workspaceId ? { workspaceId } : {}) },
    select: { id: true, instagramId: true, workspaceId: true },
  });
  const accountMap = new Map(accounts.map(a => [a.instagramId, a]));
  const allowed = new Set(accountMap.keys());
  const payload = { ...incoming, entry: incoming.entry.filter(e => allowed.has(e.id)) };
  if (!payload.entry.length) return;
  const webhookEvent = await prisma.webhookEvent.create({
    data: {
      object:
        typeof payload === "object" && payload && "object" in payload
          ? String(payload.object)
          : null,
      payload: payload as unknown as Prisma.InputJsonValue,
      ...(workspaceId ? { workspaceId } : {}),
      status: "PENDING",
    },
  });

  try {
    const commentEvents = parseCommentEvents(
      payload as Parameters<typeof parseCommentEvents>[0]
    );
    const queue = getDMQueue();

    for (const event of commentEvents) {
      const account = accountMap.get(event.instagramAccountId);
      if (!account) continue;

      await queue.add(
        COMMENT_JOB_NAME,
        {
          instagramAccountId: event.instagramAccountId,
          accountConnectionId: accountMap.get(event.instagramAccountId)?.id,
          commentId: event.commentId,
          commentText: event.commentText,
          commenterId: event.commenterId,
          commenterName: event.commenterName,
          mediaId: event.mediaId,
          originalMediaId: event.originalMediaId,
          source: "WEBHOOK",
        },
        {
          jobId: `comment_${event.instagramAccountId}_${event.commentId}`,
        }
      );

      if (account) {
        await prisma.webhookEvent.update({
          where: { id: webhookEvent.id },
          data: { workspaceId: account.workspaceId },
        });
      }
    }

    // Button taps from opening DMs → deliver the reveal message.
    const postbackEvents = parsePostbackEvents(
      payload as Parameters<typeof parsePostbackEvents>[0]
    );

    for (const event of postbackEvents) {
      await queue.add(
        POSTBACK_JOB_NAME,
        {
          instagramAccountId: event.instagramAccountId,
          accountConnectionId: accountMap.get(event.instagramAccountId)?.id,
          userId: event.userId,
          payload: event.payload,
          mid: event.mid,
        },
        {
          // BullMQ forbids ":" in custom job ids, and the payload is
          // "reveal:<id>", so build with underscores and strip any colons.
          jobId: `postback_${event.instagramAccountId}_${event.userId}_${(
            event.mid ?? event.payload
          ).replace(/:/g, "_")}`,
        }
      );
    }

    // Inbound DMs → keyword-triggered autoreply.
    const messageEvents = parseMessageEvents(
      payload as Parameters<typeof parseMessageEvents>[0]
    );

    for (const event of messageEvents) {
      const account = accountMap.get(event.instagramAccountId);
      if (!account) continue;

      await queue.add(
        MESSAGE_JOB_NAME,
        {
          instagramAccountId: event.instagramAccountId,
          accountConnectionId: accountMap.get(event.instagramAccountId)?.id,
          messageId: event.messageId,
          messageText: event.messageText,
          senderId: event.senderId,
        },
        {
          // Message ids can contain characters BullMQ rejects in a job id (":"
          // in particular). base64url encodes into exactly the allowed alphabet
          // and stays injective — substituting invalid characters would let two
          // distinct mids collapse onto one job id, silently dropping a reply.
          jobId: `message_${event.instagramAccountId}_${Buffer.from(
            event.messageId
          ).toString("base64url")}`,
        }
      );

      if (account) {
        await prisma.webhookEvent.update({
          where: { id: webhookEvent.id },
          data: { workspaceId: account.workspaceId },
        });
      }
    }

    // If a user reads the opening DM and never taps the button, deliver the
    // same next-step DM after five minutes. The worker no-ops this delayed job
    // if a real button tap has already delivered the reveal.
    const readEvents = parseReadEvents(
      payload as Parameters<typeof parseReadEvents>[0]
    );

    for (const event of readEvents) {
      const openingLogs = await prisma.dmLog.findMany({
        where: {
          commenterId: event.userId,
          status: "SENT",
          automation: {
            isActive: true,
            openingDmEnabled: true,
            instagramAccount: {
              instagramId: event.instagramAccountId,
            },
          },
        },
        select: {
          commentId: true,
          automation: {
            select: {
              id: true,
            },
          },
        },
      });

      // A tap that delivered the link leaves a SENT "reveal:<user>" row, and
      // the fallback job returns as soon as it reads that row. So does a DM
      // keyword the campaign answered ("dm:<mid>"): the person typed the
      // keyword instead of tapping. Every later message this person reads
      // sends another receipt, so skip those campaigns here rather than queue
      // jobs that only wake the database to do nothing. The rows come with
      // the query above; no extra query.
      const revealedAutomationIds = new Set(
        openingLogs
          .filter(
            (log) =>
              log.commentId === `reveal:${event.userId}` ||
              log.commentId.startsWith('dm:')
          )
          .map((log) => log.automation.id)
      );
      const scheduledAutomationIds = new Set<string>();
      for (const log of openingLogs) {
        const automation = log.automation;
        // Only a comment's row means an opening DM went out. A DM keyword is
        // answered in the conversation the person started, with the link or
        // with a follow prompt whose own button delivers it. There is no
        // opening DM to fall back from, and a fallback would send the link a
        // second time.
        if (!isCommentRow(log.commentId)) continue;
        if (revealedAutomationIds.has(automation.id)) continue;
        if (scheduledAutomationIds.has(automation.id)) continue;
        scheduledAutomationIds.add(automation.id);

        await queue.add(
          POSTBACK_JOB_NAME,
          {
            instagramAccountId: event.instagramAccountId,
          accountConnectionId: accountMap.get(event.instagramAccountId)?.id,
            userId: event.userId,
            payload: `reveal:${automation.id}`,
            fallback: true,
          },
          {
            delay: OPENING_DM_READ_FALLBACK_DELAY_MS,
            jobId: `read_fallback_${event.instagramAccountId}_${event.userId}_${automation.id}`,
          }
        );
      }
    }

    await prisma.webhookEvent.update({
      where: { id: webhookEvent.id },
      data: {
        status: "PROCESSED",
        processedAt: new Date(),
      },
    });

    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    await prisma.webhookEvent.update({
      where: { id: webhookEvent.id },
      data: {
        status: "FAILED",
        errorMessage: message,
        processedAt: new Date(),
      },
    });

    throw error;
  }
}

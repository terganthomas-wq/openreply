/**
 * Contacts (R1, R2, R10, R18): the people who commented a keyword, tapped a
 * button or sent a DM, one per connected account, with their tags. The
 * Contacts page lists and filters them and shows one person's history;
 * owners and admins delete a contact on request (data deletion).
 *
 * Dashboard only: contacts are personal data, so the service API (v1, MCP)
 * never exposes them. Every query names the workspace (R18): an id from
 * another workspace is a 404 like a missing one.
 */

import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@/app/generated/prisma/client";
import { getCurrentWorkspaceId } from "@/lib/auth";
import {
  buildContactTimeline,
  HISTORY_CLICK_LIMIT,
  HISTORY_MESSAGE_LIMIT,
} from "@/lib/contacts/history";
import {
  CONTACTS_MAX_PAGE_SIZE,
  CONTACTS_PAGE_SIZE,
  contactSearchTerm,
  positiveIntParam,
} from "@/lib/contacts/query";
import { prisma } from "@/lib/db/client";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

// Read-your-writes: a deleted contact must be gone from the list at once, so
// never cache this at the route or CDN layer.
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

function fail(status: number, error: string) {
  return NextResponse.json(
    { success: false, error },
    { status, headers: NO_STORE }
  );
}

function respond(data: unknown) {
  return NextResponse.json({ success: true, data }, { headers: NO_STORE });
}

/** Every tag of the workspace by name, with how many contacts have it. */
async function tagCounts(workspaceId: string) {
  const rows = await prisma.contactTag.groupBy({
    by: ["tag"],
    where: { workspaceId },
    _count: { _all: true },
    orderBy: { tag: "asc" },
  });
  return rows.map((row) => ({ tag: row.tag, count: row._count._all }));
}

async function listContacts(params: URLSearchParams, workspaceId: string) {
  const page = positiveIntParam(params.get("page"), 1);
  const limit = Math.min(
    CONTACTS_MAX_PAGE_SIZE,
    positiveIntParam(params.get("limit"), CONTACTS_PAGE_SIZE)
  );
  const term = contactSearchTerm(params.get("q"));
  // Tag names are stored trimmed (lib/contacts/store.ts) and matched whole.
  const tag = params.get("tag")?.trim() ?? "";
  const account = params.get("instagramAccountId");

  const where: Prisma.ContactWhereInput = {
    workspaceId,
    ...(account && account !== "all" ? { instagramAccountId: account } : {}),
    ...(tag ? { tags: { some: { tag } } } : {}),
    // A handle by any part and in any case; an Instagram-scoped id only whole.
    ...(term
      ? {
          OR: [
            { username: { contains: term, mode: "insensitive" } },
            { igsid: term },
          ],
        }
      : {}),
  };

  const [contacts, total, tags] = await Promise.all([
    prisma.contact.findMany({
      where,
      // "Last seen" first; the id keeps contacts seen in the same
      // millisecond on one page.
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        igsid: true,
        username: true,
        instagramAccountId: true,
        lastInteractionAt: true,
        createdAt: true,
        updatedAt: true,
        instagramAccount: { select: { username: true } },
        tags: {
          select: { tag: true, createdAt: true },
          orderBy: [{ createdAt: "desc" }, { tag: "asc" }],
        },
      },
    }),
    prisma.contact.count({ where }),
    // The tag filter's options come with the first page of a search; the
    // page keeps them while it moves on.
    page === 1 ? tagCounts(workspaceId) : null,
  ]);

  return respond({
    contacts,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    ...(tags ? { tagCounts: tags } : {}),
  });
}

async function contactHistory(id: string) {
  // The role, too: only owners and admins see the delete button.
  const context = await getCurrentWorkspaceContext();
  if (!context) return fail(401, "Unauthorized");
  const { workspaceId } = context;

  const contact = await prisma.contact.findFirst({
    where: { id, workspaceId },
    select: {
      id: true,
      igsid: true,
      username: true,
      instagramAccountId: true,
      recipientHash: true,
      lastInteractionAt: true,
      createdAt: true,
      updatedAt: true,
      instagramAccount: { select: { username: true } },
    },
  });
  if (!contact) return fail(404, "Contact not found");

  const [tags, offers, messages, clicks] = await Promise.all([
    prisma.contactTag.findMany({
      where: { workspaceId, contactId: contact.id },
      orderBy: [{ createdAt: "asc" }, { tag: "asc" }],
      select: { id: true, tag: true, createdAt: true },
    }),
    prisma.contactOffer.findMany({
      where: { workspaceId, contactId: contact.id },
      orderBy: [{ offeredAt: "desc" }, { id: "asc" }],
      select: {
        id: true,
        offerId: true,
        automationId: true,
        offeredAt: true,
        pitchSentAt: true,
        interestedAt: true,
        sentAt: true,
        sentVia: true,
        reminderSentAt: true,
        clickedAt: true,
        stoppedAt: true,
        stopReason: true,
        offer: { select: { name: true, archivedAt: true } },
        automation: { select: { name: true } },
      },
    }),
    // Comments, button taps (reveal:<igsid>) and DMs (dm:<mid>). The IGSID
    // only means something per account, hence both.
    prisma.dmLog.findMany({
      where: {
        workspaceId,
        instagramAccountId: contact.instagramAccountId,
        commenterId: contact.igsid,
      },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      // One more than shown says whether older ones exist.
      take: HISTORY_MESSAGE_LIMIT + 1,
      select: {
        id: true,
        commentId: true,
        commentText: true,
        status: true,
        createdAt: true,
        automationId: true,
        automation: { select: { name: true } },
      },
    }),
    // Clicks on campaign links sent to this person: the links carry their
    // ?r= token (offer links record clickedAt on the offer row instead). The
    // token alone names them, as an IGSID differs per account; a click's own
    // account is the campaign's at click time, not always the sender's.
    prisma.linkClick.findMany({
      where: { workspaceId, recipientHash: contact.recipientHash },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: HISTORY_CLICK_LIMIT + 1,
      select: {
        id: true,
        createdAt: true,
        automationId: true,
        automation: { select: { name: true } },
        trackedLink: { select: { destinationUrl: true } },
      },
    }),
  ]);

  return respond({
    contact: {
      id: contact.id,
      igsid: contact.igsid,
      username: contact.username,
      instagramAccountId: contact.instagramAccountId,
      account: contact.instagramAccount.username,
      lastInteractionAt: contact.lastInteractionAt,
      createdAt: contact.createdAt,
      updatedAt: contact.updatedAt,
    },
    tags: tags.map(({ tag, createdAt }) => ({ tag, createdAt })),
    offers,
    timeline: buildContactTimeline({
      messages: messages.slice(0, HISTORY_MESSAGE_LIMIT),
      offers,
      tags,
      clicks: clicks.slice(0, HISTORY_CLICK_LIMIT),
    }),
    truncated: {
      messages: messages.length > HISTORY_MESSAGE_LIMIT,
      clicks: clicks.length > HISTORY_CLICK_LIMIT,
    },
    canManage: canManageWorkspace(context.role),
  });
}

/**
 * ?id= is one contact with their history, ?view=tags the workspace's tags
 * with counts (the campaign editor suggests them), anything else the list:
 * q (a handle or an IGSID), tag, instagramAccountId ("all" for every
 * account), page and limit (at most 50).
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const id = params.get("id");
  if (id) return contactHistory(id);

  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) return fail(401, "Unauthorized");

  if (params.get("view") === "tags") {
    return respond({ tagCounts: await tagCounts(workspaceId) });
  }
  return listContacts(params, workspaceId);
}

/**
 * Deletes a contact on request (GDPR), for owners and admins: the contact,
 * and with it their tags and offer rows (cascade), and their clicks on
 * campaign links. Their DM log rows stay, anonymised (no IGSID, name or
 * text), because the campaigns' counts and the comment dedupe stand on them:
 * the comment ids are kept, so the reconciler, which hands back every keyword
 * comment of the last 72 hours that no row marks as handled, does not answer
 * a handled comment again. Button-tap ids (reveal:<igsid>) hold the IGSID
 * and are rewritten. Offer jobs still queued for the person find no row and
 * end. A comment whose DM is still being retried (failed, attempts left) can
 * still be answered, which records the person anew.
 *
 * What Diagnostics keeps of the person goes as well. The worker's events
 * (OperationalEvent) name them by IGSID (userId) and handle (commenterName),
 * and failed jobs by job ids that hold the IGSID: those keys are removed and
 * the IGSID in a job id or message becomes "deleted", while what the event
 * says about the campaign or offer stays; a payload that would still name
 * them is dropped. The workspace's events are matched by the IGSID, which
 * Instagram gives per account, so it names this person. The raw webhook
 * payloads (WebhookEvent) hold their comments and DMs word for word: those
 * of this account that name the IGSID are emptied, the rows (status, error,
 * time) stay. Meta stores button taps and read receipts without a
 * workspace, so those count when they name the account.
 */
export async function DELETE(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) return fail(401, "Unauthorized");
  if (!canManageWorkspace(context.role)) {
    return fail(403, "Only owners and admins can delete contacts");
  }
  const { workspaceId } = context;

  const id = request.nextUrl.searchParams.get("id");
  if (!id) return fail(400, "Missing contact ID");

  const contact = await prisma.contact.findFirst({
    where: { id, workspaceId },
    select: {
      id: true,
      instagramAccountId: true,
      igsid: true,
      recipientHash: true,
      instagramAccount: { select: { instagramId: true } },
    },
  });
  if (!contact) return fail(404, "Contact not found");

  const { igsid } = contact;
  // Ids appear in webhook JSON as quoted strings ("id": "1784…").
  const quotedIgsid = JSON.stringify(igsid);
  const quotedAccountId = JSON.stringify(contact.instagramAccount.instagramId);

  // One transaction: a half-done deletion would leave the person findable.
  const [anonymisedLogs, deletedClicks, anonymisedEvents, clearedWebhookEvents] =
    await prisma.$transaction([
      prisma.$executeRaw`UPDATE "DmLog" SET "commenterId" = 'deleted', "commenterName" = NULL, "commentText" = '', "commentId" = CASE WHEN "commentId" LIKE 'reveal:%' THEN 'deleted:' || "id" ELSE "commentId" END WHERE "workspaceId" = ${workspaceId} AND "instagramAccountId" = ${contact.instagramAccountId} AND "commenterId" = ${igsid}`,
      prisma.linkClick.deleteMany({
        where: { workspaceId, recipientHash: contact.recipientHash },
      }),
      // A payload that does not name them stays; one that is no object, or
      // that still names them once the keys and the job id are gone, goes.
      prisma.$executeRaw`UPDATE "OperationalEvent"
        SET "message" = replace("message", ${igsid}, 'deleted'),
          "payload" = CASE
            WHEN strpos(COALESCE("payload"::text, ''), ${igsid}) = 0 THEN "payload"
            WHEN jsonb_typeof("payload") <> 'object' THEN NULL
            WHEN strpos(("payload" - 'userId' - 'commenterName' - 'commenterId' - 'jobId')::text, ${igsid}) > 0 THEN NULL
            ELSE ("payload" - 'userId' - 'commenterName' - 'commenterId')
              || CASE WHEN jsonb_typeof("payload" -> 'jobId') = 'string'
                THEN jsonb_build_object('jobId', replace("payload" ->> 'jobId', ${igsid}, 'deleted'))
                ELSE '{}'::jsonb END
          END
        WHERE "workspaceId" = ${workspaceId}
          AND (strpos("message", ${igsid}) > 0 OR strpos(COALESCE("payload"::text, ''), ${igsid}) > 0)`,
      prisma.$executeRaw`UPDATE "WebhookEvent" SET "payload" = '{}'::jsonb WHERE ("workspaceId" = ${workspaceId} OR "workspaceId" IS NULL) AND strpos("payload"::text, ${quotedAccountId}) > 0 AND strpos("payload"::text, ${quotedIgsid}) > 0`,
      prisma.contact.delete({ where: { id: contact.id, workspaceId } }),
    ]);

  return respond({
    deleted: true,
    anonymisedLogs,
    deletedClicks: deletedClicks.count,
    anonymisedEvents,
    clearedWebhookEvents,
  });
}

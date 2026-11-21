/**
 * Lead-magnet offers (R3, R13): the Offers page lists, creates, edits,
 * pauses, reorders and deletes them here.
 *
 * Offers belong to the workspace, never to a campaign, and every query here
 * names the workspace (R18): an id from another workspace is a 404 like a
 * missing one. Every member may read them; owners and admins change them.
 *
 * A card image uploaded in the editor (app/api/offers/image) is deleted
 * once an edit replaces or removes it, or the offer is deleted for good,
 * after the response and best effort (lib/offers/image.ts). An archived
 * offer keeps its image: the cards already sent may still show it.
 */

import { after, NextRequest, NextResponse } from "next/server";
import type { z } from "zod";
import type { Offer } from "@/app/generated/prisma/client";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import {
  deleteUnusedOfferImage,
  isOfferImageUploadEnabled,
  isUploadedOfferImage,
} from "@/lib/offers/image";
import { OFFER_ORDER } from "@/lib/offers/schedule";
import {
  offerInputSchema,
  offerOrderSchema,
  offerPatchSchema,
} from "@/lib/offers/schema";
import { isUniqueViolation } from "@/lib/queue/send-helpers";
import { buildOfferUrl } from "@/lib/tracking/message";
import { generateTrackedLinkSlug } from "@/lib/tracking/server";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

// Read-your-writes: an offer saved in the editor must be on the Offers page
// at once, so never cache this at the route or CDN layer.
export const dynamic = "force-dynamic";

/** How far people got with an offer (R10), counted on its ContactOffer rows. */
type OfferFunnel = {
  offered: number;
  interested: number;
  sent: number;
  clicked: number;
  stopped: number;
};

const EMPTY_FUNNEL: OfferFunnel = {
  offered: 0,
  interested: 0,
  sent: 0,
  clicked: 0,
  stopped: 0,
};

function fail(status: number, error: string) {
  return NextResponse.json({ success: false, error }, { status });
}

function invalidInput(error: z.ZodError) {
  return NextResponse.json(
    { success: false, error: "Invalid input", details: error.flatten() },
    { status: 400 }
  );
}

// A malformed body is invalid input, not a server error.
function readBody(request: NextRequest): Promise<unknown> {
  return request.json().catch(() => null);
}

/** The offer with the link its card and reminder buttons lead to. */
function withLink(offer: Offer) {
  return { ...offer, trackedUrl: buildOfferUrl(offer.linkSlug) };
}

/**
 * The workspace an owner or admin changes offers in, or the response that
 * turns the request away.
 */
async function writableWorkspace(): Promise<
  { workspaceId: string } | { response: NextResponse }
> {
  const context = await getCurrentWorkspaceContext();
  if (!context) return { response: fail(401, "Unauthorized") };
  if (!canManageWorkspace(context.role)) {
    return { response: fail(403, "Only owners and admins can manage offers") };
  }
  return { workspaceId: context.workspaceId };
}

// An offer of this workspace that is still on the Offers page. Archived
// offers are history: neither edited nor deleted again.
function findCurrentOffer(workspaceId: string, id: string) {
  return prisma.offer.findFirst({
    where: { id, workspaceId, archivedAt: null },
    select: { id: true, cardImageUrl: true },
  });
}

/**
 * After the response: deletes the card image an offer no longer shows, if
 * this workspace uploaded it and no other offer shows it. Links to images
 * hosted elsewhere are left alone, and nothing is deleted while no Blob
 * store is set up.
 */
function deleteImageLater(workspaceId: string, url: string | null | undefined) {
  if (!isOfferImageUploadEnabled() || !isUploadedOfferImage(url, workspaceId)) {
    return;
  }
  after(() => deleteUnusedOfferImage(workspaceId, url));
}

export async function GET(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) return fail(401, "Unauthorized");

  // Offers deleted after they were offered stay archived; only on request.
  const withArchived = request.nextUrl.searchParams.get("archived") === "1";
  const [offers, stages] = await Promise.all([
    prisma.offer.findMany({
      where: { workspaceId, ...(withArchived ? {} : { archivedAt: null }) },
      orderBy: OFFER_ORDER,
    }),
    // Every offer's funnel in one query: counting a column counts the rows
    // where it is set.
    prisma.contactOffer.groupBy({
      by: ["offerId"],
      where: { workspaceId },
      _count: {
        _all: true,
        interestedAt: true,
        sentAt: true,
        clickedAt: true,
        stoppedAt: true,
      },
    }),
  ]);

  const funnels = new Map<string, OfferFunnel>(
    stages.map(({ offerId, _count }) => [
      offerId,
      {
        offered: _count._all,
        interested: _count.interestedAt,
        sent: _count.sentAt,
        clicked: _count.clickedAt,
        stopped: _count.stoppedAt,
      },
    ])
  );

  return NextResponse.json(
    {
      success: true,
      data: offers.map((offer) => ({
        ...withLink(offer),
        funnel: funnels.get(offer.id) ?? EMPTY_FUNNEL,
      })),
      // Whether the editor can upload card images (a Vercel Blob store is
      // connected); without it the editor shows the image-URL field.
      imageUploadEnabled: isOfferImageUploadEnabled(),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST(request: NextRequest) {
  const access = await writableWorkspace();
  if ("response" in access) return access.response;
  const { workspaceId } = access;

  const parsed = offerInputSchema.safeParse(await readBody(request));
  if (!parsed.success) return invalidInput(parsed.error);

  // A new offer goes to the end of the default order.
  const { _max } = await prisma.offer.aggregate({
    where: { workspaceId, archivedAt: null },
    _max: { position: true },
  });
  const position = (_max.position ?? -1) + 1;

  const create = () =>
    prisma.offer.create({
      data: {
        ...parsed.data,
        workspaceId,
        position,
        // The public part of /o/<slug>, unique across all workspaces.
        linkSlug: generateTrackedLinkSlug(),
      },
    });

  let offer: Offer;
  try {
    offer = await create();
  } catch (error) {
    // The only unique key besides the id: a slug that is taken already.
    if (!isUniqueViolation(error)) throw error;
    offer = await create();
  }

  return NextResponse.json(
    { success: true, data: withLink(offer) },
    { status: 201 }
  );
}

export async function PATCH(request: NextRequest) {
  const access = await writableWorkspace();
  if ("response" in access) return access.response;
  const { workspaceId } = access;

  const id = request.nextUrl.searchParams.get("id");
  if (!id) return fail(400, "Missing offer ID");

  // The pause switch ({ isActive } alone) or the whole offer. Content is read
  // at send time, so an edit applies to every later message (R13).
  const parsed = offerPatchSchema.safeParse(await readBody(request));
  if (!parsed.success) return invalidInput(parsed.error);

  const existing = await findCurrentOffer(workspaceId, id);
  if (!existing) return fail(404, "Offer not found");

  const offer = await prisma.offer.update({
    where: { id: existing.id, workspaceId },
    data: parsed.data,
  });

  // A whole offer names its image (null for none); the pause switch keeps
  // it. Another image, or none, replaced the stored one.
  if (
    "cardImageUrl" in parsed.data &&
    parsed.data.cardImageUrl !== existing.cardImageUrl
  ) {
    deleteImageLater(workspaceId, existing.cardImageUrl);
  }

  return NextResponse.json({ success: true, data: withLink(offer) });
}

/** The workspace's default order: { order } lists every current offer once. */
export async function PUT(request: NextRequest) {
  const access = await writableWorkspace();
  if ("response" in access) return access.response;
  const { workspaceId } = access;

  const parsed = offerOrderSchema.safeParse(await readBody(request));
  if (!parsed.success) return invalidInput(parsed.error);
  const { order } = parsed.data;

  // The whole list, each offer once. A partial list, a stale one or a
  // foreign id would leave positions that tie or skip an offer.
  const current = await prisma.offer.findMany({
    where: { workspaceId, archivedAt: null },
    select: { id: true },
  });
  const ids = new Set(current.map((offer) => offer.id));
  if (
    order.length !== ids.size ||
    new Set(order).size !== order.length ||
    order.some((id) => !ids.has(id))
  ) {
    return fail(400, "The order must list every offer exactly once");
  }

  // One transaction, so the order never shows half saved.
  await prisma.$transaction(
    order.map((id, position) =>
      prisma.offer.updateMany({
        where: { id, workspaceId },
        data: { position },
      })
    )
  );

  return NextResponse.json({ success: true, data: { order } });
}

export async function DELETE(request: NextRequest) {
  const access = await writableWorkspace();
  if ("response" in access) return access.response;
  const { workspaceId } = access;

  const id = request.nextUrl.searchParams.get("id");
  if (!id) return fail(400, "Missing offer ID");

  const existing = await prisma.offer.findFirst({
    where: { id, workspaceId, archivedAt: null },
    select: { id: true, firstOfferedAt: true, cardImageUrl: true },
  });
  if (!existing) return fail(404, "Offer not found");

  // An offer someone already got is archived, not deleted: its funnel stays
  // and the card links already sent keep redirecting. The worker checks
  // archivedAt before every message, so its running sequences stop. One
  // nobody got goes for good. Whether anyone got it is read from the mark
  // the worker sets before the first ContactOffer row, which outlives the
  // rows: disconnecting an account deletes its contacts and their offers,
  // while the links stay in their inboxes. Rows written without the mark
  // count as well.
  const used =
    existing.firstOfferedAt !== null ||
    (await prisma.contactOffer.count({ where: { workspaceId, offerId: id } })) >
      0;
  const [, campaignsWithoutOffers] = await prisma.$transaction([
    used
      ? prisma.offer.update({
          where: { id, workspaceId },
          data: { archivedAt: new Date(), isActive: false },
        })
      : prisma.offer.delete({ where: { id, workspaceId } }),
    // A campaign's own order lists the only offers it may start. Once its
    // last one is gone the list is empty, which reads as the workspace's
    // default order, and the campaign would start offers nobody picked for
    // it. Its offers are switched off instead: it keeps sending its link
    // (Weg 1), its editor shows offers off, and the response names it, so
    // the Offers page can say which campaigns need new offers. Before the
    // cleanup below, which empties the list.
    prisma.automation.updateManyAndReturn({
      where: { workspaceId, offersEnabled: true, offerIds: { equals: [id] } },
      data: { offersEnabled: false },
      select: { id: true, name: true },
    }),
    // A campaign's custom order holds plain ids, with no foreign key to
    // clean up after the offer: take this one out of every campaign of the
    // workspace.
    prisma.$executeRaw`UPDATE "Automation" SET "offerIds" = array_remove("offerIds", ${id}) WHERE "workspaceId" = ${workspaceId} AND ${id} = ANY("offerIds")`,
  ]);

  // Gone for good, so its image goes too. An archived offer keeps it: the
  // cards already sent may still show it.
  if (!used) deleteImageLater(workspaceId, existing.cardImageUrl);

  return NextResponse.json({
    success: true,
    data: { deleted: true, archived: used, campaignsWithoutOffers },
  });
}

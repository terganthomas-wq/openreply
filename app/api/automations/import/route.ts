import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import {
  newCampaignData,
  offersExist,
  uniqueOfferIds,
} from "@/lib/campaigns/create";
import { createAutomationSchema } from "@/lib/campaigns/schema";
import { getWorkspaceInstagramAccount } from "@/lib/instagram-accounts";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

// A row is a campaign as the create route takes it (lib/campaigns/schema.ts)
// and goes through the same schema, so an imported campaign is checked like
// one made in the editor and gets the same defaults. Only the keys this
// import reads itself are declared here; every other key passes through to
// that schema. The older import format keeps working: trackedUrl for the
// link, a public reply message alone switches the public reply on, the name
// may be left out, and an empty name, goal or post URL counts as none.
const importRowSchema = z.looseObject({
  // An imported campaign answers comments on this one post.
  postId: z.string().min(1),
  postUrl: z.string().optional().nullable(),
  name: z.string().optional().nullable(),
  goal: z.string().optional().nullable(),
  keywords: z.array(z.string()).optional(),
  trackedUrl: z.string().optional().nullable(),
  publicReplyMessage: z.string().optional().nullable(),
});

const importSchema = z.object({
  instagramAccountId: z.string().min(1),
  campaigns: z.array(importRowSchema).min(1).max(200),
});

function toCampaignInput(row: z.infer<typeof importRowSchema>) {
  const { trackedUrl, ...fields } = row;
  const publicReply = (fields.publicReplyMessage ?? "").trim();
  return {
    ...fields,
    name:
      (fields.name ?? "").trim() ||
      `Imported: ${fields.keywords?.[0] ?? fields.postId}`,
    goal: (fields.goal ?? "").trim() || null,
    // An empty cell is no URL.
    postUrl: fields.postUrl?.trim() || null,
    // The post is the import's, whatever else a row says.
    pendingNextReel: false,
    matchAnyPost: false,
    publicReplyEnabled: fields.publicReplyEnabled ?? Boolean(publicReply),
    publicReplyMessage: publicReply || null,
    // The older key only ever took web links; anything else meant no link.
    trackedDestinationUrl:
      fields.trackedDestinationUrl ??
      (trackedUrl && /^https?:\/\//i.test(trackedUrl) ? trackedUrl : undefined),
  };
}

export async function POST(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }
  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Only owners and admins can import campaigns" },
      { status: 403 }
    );
  }

  const body = await request.json();
  const parsed = importSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        success: false,
        error: "Invalid import data",
        details: parsed.error.flatten(),
      },
      { status: 400 }
    );
  }

  // Every row is checked before anything is written, so an import is taken
  // whole or not at all, as before. The errors name the row.
  const rows = parsed.data.campaigns.map((campaign, index) => ({
    row: index + 1,
    postId: campaign.postId,
    result: createAutomationSchema.safeParse(toCampaignInput(campaign)),
  }));
  const invalidRows = rows.flatMap(({ row, result }) =>
    result.success ? [] : [{ row, ...result.error.flatten() }]
  );
  if (invalidRows.length > 0) {
    return NextResponse.json(
      { success: false, error: "Invalid import data", details: invalidRows },
      { status: 400 }
    );
  }
  const campaigns = rows.flatMap(({ row, postId, result }) =>
    result.success ? [{ row, postId, data: result.data }] : []
  );

  const account = await getWorkspaceInstagramAccount(
    context.workspaceId,
    parsed.data.instagramAccountId
  );
  if (!account) {
    return NextResponse.json(
      { success: false, error: "Instagram account not found" },
      { status: 400 }
    );
  }

  // One query for the offers of every row.
  const offerIds = uniqueOfferIds(campaigns.flatMap((c) => c.data.offerIds));
  if (!(await offersExist(context.workspaceId, offerIds))) {
    return NextResponse.json(
      { success: false, error: "Unknown offer" },
      { status: 400 }
    );
  }

  const existing = await prisma.automation.findMany({
    where: { instagramAccountId: account.id },
    select: { postId: true },
  });
  const usedPostIds = new Set(existing.map((a) => a.postId));

  const created: { name: string; postId: string }[] = [];
  const skipped: { row: number; reason: string }[] = [];

  for (const { row, postId, data } of campaigns) {
    if (usedPostIds.has(postId)) {
      skipped.push({ row, reason: "a campaign already exists for this post" });
      continue;
    }

    // The same row the create route writes (lib/campaigns/create.ts).
    await prisma.automation.create({
      data: newCampaignData(data, {
        workspaceId: context.workspaceId,
        instagramAccountId: account.id,
      }),
    });

    usedPostIds.add(postId);
    created.push({ name: data.name, postId });
  }

  return NextResponse.json({
    success: true,
    data: { created, skipped },
  });
}

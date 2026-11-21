/**
 * The workspace's message defaults (R14, R18): the texts new campaigns open
 * with in the editor and those new offers start from. Shape and validation:
 * lib/campaigns/message-defaults.ts.
 *
 * Every member reads them; owners and admins change them. A workspace that
 * has none gets the built-in set of the reader's interface language (German
 * today) on its first read, written once: the write only takes a column that
 * is still NULL, so it never replaces defaults someone saved meanwhile. A
 * language without a built-in set reads null and writes nothing, and the
 * editor opens as before.
 */

import { NextRequest, NextResponse } from "next/server";
import type { z } from "zod";
import { Prisma } from "@/app/generated/prisma/client";
import {
  builtInMessageDefaults,
  EMPTY_MESSAGE_DEFAULTS,
  isMessageDefaultsSection,
  mergeMessageDefaults,
  messageDefaultsSchema,
  messageDefaultsUpdateSchema,
  parseMessageDefaults,
  resetMessageDefaultsSection,
  type MessageDefaults,
} from "@/lib/campaigns/message-defaults";
import { prisma } from "@/lib/db/client";
import { getI18n } from "@/lib/i18n/server";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
  type WorkspaceContext,
} from "@/lib/workspace-access";

// Read-your-writes: texts saved as defaults must open the next new campaign,
// so never cache this at the route or CDN layer.
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

function respond(defaults: MessageDefaults | null, canManage: boolean) {
  return NextResponse.json(
    { success: true, data: { defaults, canManage } },
    { headers: NO_STORE }
  );
}

function fail(status: number, error: string) {
  return NextResponse.json(
    { success: false, error },
    { status, headers: NO_STORE }
  );
}

// The shape of error.flatten(), but keyed by the whole path: flatten() keeps
// only the first segment, which here is just "campaign" or "offer".
function invalidInput(error: z.ZodError) {
  const formErrors: string[] = [];
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    if (issue.path.length === 0) {
      formErrors.push(issue.message);
      continue;
    }
    const field = issue.path.map(String).join(".");
    (fieldErrors[field] ??= []).push(issue.message);
  }
  return NextResponse.json(
    {
      success: false,
      error: "Invalid input",
      details: { formErrors, fieldErrors },
    },
    { status: 400, headers: NO_STORE }
  );
}

/**
 * The workspace an owner or admin changes the defaults of, or the response
 * that turns the request away.
 */
async function writableWorkspace(): Promise<
  { context: WorkspaceContext } | { response: NextResponse }
> {
  const context = await getCurrentWorkspaceContext();
  if (!context) return { response: fail(401, "Unauthorized") };
  if (!canManageWorkspace(context.role)) {
    return {
      response: fail(403, "Only owners and admins can change the default texts"),
    };
  }
  return { context };
}

// The built-in set for the language the request's interface uses.
async function builtInForRequest() {
  const { locale } = await getI18n();
  return builtInMessageDefaults(locale);
}

export async function GET() {
  const context = await getCurrentWorkspaceContext();
  if (!context) return fail(401, "Unauthorized");
  const canManage = canManageWorkspace(context.role);

  // Saved defaults that this version cannot read count as none.
  const stored = parseMessageDefaults(context.workspace.messageDefaults);
  if (stored) return respond(stored, canManage);

  const seed = await builtInForRequest();
  if (!seed) return respond(null, canManage);

  // Once per workspace, and only into a NULL column: a concurrent first read
  // or an admin's save in the meantime is never overwritten.
  const { count } = await prisma.workspace.updateMany({
    where: {
      id: context.workspaceId,
      messageDefaults: { equals: Prisma.DbNull },
    },
    data: { messageDefaults: seed },
  });
  if (count > 0) return respond(seed, canManage);

  // The column was no longer NULL: show what it holds now, or the built-in
  // set while it holds something unreadable (an admin's save replaces it).
  const current = await prisma.workspace.findUnique({
    where: { id: context.workspaceId },
    select: { messageDefaults: true },
  });
  return respond(
    parseMessageDefaults(current?.messageDefaults) ?? seed,
    canManage
  );
}

/**
 * Saves { campaign?, offer? }, field by field over the saved defaults, else
 * over the built-in set the workspace would be seeded with, else over empty
 * defaults. The merged whole is checked before it is saved.
 */
export async function PUT(request: NextRequest) {
  const access = await writableWorkspace();
  if ("response" in access) return access.response;
  const { context } = access;

  // A malformed body is invalid input, not a server error.
  const parsed = messageDefaultsUpdateSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!parsed.success) return invalidInput(parsed.error);

  const base =
    parseMessageDefaults(context.workspace.messageDefaults) ??
    (await builtInForRequest()) ??
    EMPTY_MESSAGE_DEFAULTS;
  const merged = messageDefaultsSchema.safeParse(
    mergeMessageDefaults(base, parsed.data)
  );
  if (!merged.success) return invalidInput(merged.error);

  await prisma.workspace.update({
    where: { id: context.workspaceId },
    data: { messageDefaults: merged.data },
  });
  return respond(merged.data, true);
}

/**
 * Back to the built-in set. ?section=campaign (the campaign editor's reset)
 * or ?section=offer resets that part alone, to the built-in set of the
 * reader's language or, without one, to empty defaults, and keeps the other
 * part as saved: both live in the one column. Without a section, or when
 * nothing saved is left to keep (resetMessageDefaultsSection), the column
 * goes back to NULL, so the next read seeds it again in the reader's
 * language. The response carries the defaults new campaigns and offers now
 * start from.
 */
export async function DELETE(request: NextRequest) {
  const access = await writableWorkspace();
  if ("response" in access) return access.response;
  const { context } = access;

  const section = request.nextUrl.searchParams.get("section");
  if (section !== null && !isMessageDefaultsSection(section)) {
    return fail(400, 'The section is "campaign" or "offer"');
  }

  const builtIn = await builtInForRequest();
  const kept = section
    ? resetMessageDefaultsSection(
        parseMessageDefaults(context.workspace.messageDefaults),
        section,
        builtIn
      )
    : null;
  if (kept) {
    // The kept section was valid when saved and the reset one is built in;
    // checked all the same, like every write of this column.
    const checked = messageDefaultsSchema.safeParse(kept);
    if (!checked.success) return invalidInput(checked.error);
    await prisma.workspace.update({
      where: { id: context.workspaceId },
      data: { messageDefaults: checked.data },
    });
    return respond(checked.data, true);
  }

  await prisma.workspace.update({
    where: { id: context.workspaceId },
    data: { messageDefaults: Prisma.DbNull },
  });
  return respond(builtIn, true);
}

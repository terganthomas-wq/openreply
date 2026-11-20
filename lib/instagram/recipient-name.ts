import { prisma } from "@/lib/db/client";
import type { InstagramContext } from "./context";
import { getRecipientUsername } from "./read-analytics";

/**
 * The name to render `{username}` with for someone reached by DM or by a
 * button tap. Those two webhooks carry only the sender's IGSID, so the handle
 * has to be recovered.
 *
 * A stored name is preferred, since it costs no API call. Given the connected
 * account's row id, the contact comes first: a single lookup by its unique
 * key, holding the handle of the person's latest comment or one found for them
 * earlier. Failing that, the newest DmLog row that has a name is used. Only
 * rows that actually have one count: a row saved on an earlier nameless send
 * would otherwise be taken as the answer and keep the fallback in place for
 * good. Failing both, the handle is read live, which happens on first contact.
 *
 * The DmLog search covers the workspace rather than one campaign, because an
 * IGSID is the same person across that workspace's campaigns. Both lookups
 * stop at the workspace, so a name never crosses between workspaces on a
 * shared instance.
 */
export async function resolveRecipientName({
  context,
  workspaceId,
  recipientId,
  instagramAccountRowId,
}: {
  context: InstagramContext;
  workspaceId: string;
  recipientId: string;
  instagramAccountRowId?: string;
}): Promise<string | null> {
  if (instagramAccountRowId) {
    const contact = await prisma.contact.findUnique({
      where: {
        instagramAccountId_igsid: {
          instagramAccountId: instagramAccountRowId,
          igsid: recipientId,
        },
        workspaceId,
      },
      select: { username: true },
    });
    if (contact?.username) return contact.username;
  }

  const named = await prisma.dmLog.findFirst({
    where: {
      workspaceId,
      commenterId: recipientId,
      commenterName: { not: null },
    },
    orderBy: { createdAt: "desc" },
    select: { commenterName: true },
  });
  if (named?.commenterName) return named.commenterName;

  return getRecipientUsername({ context, recipientId });
}

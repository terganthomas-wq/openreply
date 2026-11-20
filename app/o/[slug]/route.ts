/**
 * The link behind an offer's card and reminder buttons: /o/<linkSlug>?r=<token>.
 *
 * It belongs to the offer, not to a campaign, so deleting a campaign never
 * breaks a card already sent, and an archived offer keeps redirecting. The
 * destination is read on every request, so an edited link applies to cards
 * sent before the edit too.
 */

import { after, NextRequest, NextResponse, userAgent } from "next/server";
import { prisma } from "@/lib/db/client";
import { recordOfferClick } from "@/lib/offers/click";
import { parseRecipientToken } from "@/lib/tracking/server";

type OfferRedirectProps = {
  params: Promise<{ slug: string }>;
};

// Meta's link fetchers that userAgent().isBot does not know; it does know
// facebookexternalhit.
const META_FETCHERS = /Facebot|meta-externalagent|meta-externalfetcher/i;

/**
 * Whether a person opened the link. Next answers HEAD with this GET handler,
 * and link previews, crawlers and Meta's own fetchers request it too; none
 * of those is a click. Browsers always send a user agent.
 */
function isPersonClicking(request: NextRequest): boolean {
  const agent = request.headers.get("user-agent") ?? "";
  return (
    request.method === "GET" &&
    agent.trim() !== "" &&
    !userAgent(request).isBot &&
    !META_FETCHERS.test(agent)
  );
}

export async function GET(request: NextRequest, { params }: OfferRedirectProps) {
  const { slug } = await params;
  const offer = await prisma.offer.findUnique({
    where: { linkSlug: slug },
    select: {
      id: true,
      workspaceId: true,
      destinationUrl: true,
      tagClicked: true,
    },
  });

  if (!offer) {
    return NextResponse.redirect(new URL("/", request.url), { status: 302 });
  }

  const token = parseRecipientToken(new URL(request.url).searchParams.get("r"));
  if (token && isPersonClicking(request)) {
    // After the response: recording the click adds no wait to the redirect,
    // and a failed write never costs the person the link.
    after(() =>
      recordOfferClick({
        workspaceId: offer.workspaceId,
        offerId: offer.id,
        tagClicked: offer.tagClicked,
        token,
      }).catch((error) => {
        console.error("[Offer redirect] Click not recorded:", error);
      })
    );
  }

  return NextResponse.redirect(offer.destinationUrl, { status: 302 });
}

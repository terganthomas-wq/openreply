/**
 * The link behind an offer's card and reminder buttons: /o/<linkSlug>?r=<token>.
 *
 * It belongs to the offer, not to a campaign, so deleting a campaign never
 * breaks a card already sent, and an archived offer keeps redirecting. The
 * destination is read on every request, so an edited link applies to cards
 * sent before the edit too.
 *
 * An offer that reports sign-ups (signupTrackingEnabled) adds the person's
 * own code to the destination as ig=<code> (lib/offers/signup-token.ts), so
 * the landing page can report who signed up. Without that switch, or when
 * the link's token belongs to nobody who got the offer, the destination goes
 * out exactly as typed, and a lookup that fails never costs the person the
 * link.
 */

import { after, NextRequest, NextResponse, userAgent } from "next/server";
import { prisma } from "@/lib/db/client";
import { recordOfferClick } from "@/lib/offers/click";
import { errorKind, signupTokenFor } from "@/lib/offers/signup-token";
import { withSignupToken } from "@/lib/offers/signup-link";
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

/**
 * The destination with the person's sign-up code, or as typed when there is
 * none. The code is looked up before the redirect, as it is part of it; any
 * failure sends the destination as typed.
 */
async function destinationFor(
  offer: {
    id: string;
    workspaceId: string;
    destinationUrl: string;
    signupTrackingEnabled: boolean;
  },
  token: string | null
): Promise<string> {
  if (!offer.signupTrackingEnabled || !token) return offer.destinationUrl;
  try {
    const code = await signupTokenFor({
      workspaceId: offer.workspaceId,
      offerId: offer.id,
      recipientHash: token,
    });
    return code ? withSignupToken(offer.destinationUrl, code) : offer.destinationUrl;
  } catch (error) {
    // The kind only: a database error's message may quote the code.
    console.error("[Offer redirect] Sign-up code not added:", errorKind(error));
    return offer.destinationUrl;
  }
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
      signupTrackingEnabled: true,
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

  return NextResponse.redirect(await destinationFor(offer, token), {
    status: 302,
  });
}

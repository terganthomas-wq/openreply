/**
 * Uploads an offer's card image (spec D2): POST multipart/form-data with the
 * image in the field "file".
 *
 * Owners and admins only, like every change to offers. The image goes into
 * the folder of the signed-in workspace, never one the request names. What
 * the file is comes from its first bytes, not from its name or declared
 * type: JPEG, PNG and WebP pass; anything else, an SVG or an HTML page
 * called cover.jpg included, is refused. At most 5 MB.
 *
 * The answer carries the image's public URL, which the editor puts into the
 * offer's card image; nothing is saved on an offer here. Saving the offer
 * with another image, or none, later deletes this one (app/api/offers).
 *
 * Without BLOB_READ_WRITE_TOKEN (no Vercel Blob store connected) it answers
 * 503 and the editor shows the plain image-URL field instead. On Vercel a
 * function takes request bodies of up to 4.5 MB: the platform refuses a
 * larger one with its own 413 before this code runs.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  detectOfferImageType,
  offerImageToken,
  storeOfferImage,
} from "@/lib/offers/image";
import { OFFER_IMAGE_MAX_BYTES } from "@/lib/offers/schema";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

// Room for the multipart boundaries and the part's headers around the file.
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const BODY_MAX_BYTES = OFFER_IMAGE_MAX_BYTES + MULTIPART_OVERHEAD_BYTES;

const NOT_SET_UP =
  "Image upload is not set up: connect a Vercel Blob store to the project, which sets BLOB_READ_WRITE_TOKEN, or use a link to the image instead";
const TOO_LARGE = "The image is larger than 5 MB";
const NO_FILE = 'Send the image as multipart/form-data in the field "file"';
const NOT_AN_IMAGE = "Only JPEG, PNG and WebP images can be uploaded";

function fail(status: number, error: string) {
  return NextResponse.json({ success: false, error }, { status });
}

/**
 * The request body, or null once it passes `limit` bytes. A declared length
 * over the limit is refused unread. Without one the body is read to its end
 * but nothing past the limit is kept, so a client cannot make the server
 * hold more. The stream is not cancelled half-way: undici may then still
 * push a chunk into the closed stream, an unhandled rejection.
 */
async function readBody(
  request: NextRequest,
  limit: number
): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!request.body) return new Uint8Array(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size <= limit) chunks.push(value);
  }
  if (size > limit) return null;

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function POST(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) return fail(401, "Unauthorized");
  if (!canManageWorkspace(context.role)) {
    return fail(403, "Only owners and admins can manage offers");
  }

  const token = offerImageToken();
  if (!token) return fail(503, NOT_SET_UP);

  const body = await readBody(request, BODY_MAX_BYTES);
  if (!body) return fail(413, TOO_LARGE);

  let form: FormData;
  try {
    form = await new Response(body, {
      headers: { "Content-Type": request.headers.get("content-type") ?? "" },
    }).formData();
  } catch {
    return fail(400, NO_FILE);
  }
  const file = form.get("file");
  if (!file || typeof file === "string" || file.size === 0) {
    return fail(400, NO_FILE);
  }
  if (file.size > OFFER_IMAGE_MAX_BYTES) return fail(413, TOO_LARGE);

  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = detectOfferImageType(bytes);
  if (!type) return fail(415, NOT_AN_IMAGE);

  let url: string;
  try {
    url = await storeOfferImage({
      workspaceId: context.workspaceId,
      bytes,
      type,
      token,
    });
  } catch (error) {
    console.error("[Offer image] Upload to Vercel Blob failed:", error);
    return fail(502, "The image could not be stored. Try again.");
  }

  return NextResponse.json({ success: true, data: { url } }, { status: 201 });
}

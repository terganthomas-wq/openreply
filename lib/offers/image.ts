/**
 * Card images uploaded in the offer editor (spec D2), kept in Vercel Blob.
 *
 * POST /api/offers/image tells what a file is from its first bytes (JPEG,
 * PNG or WebP, whatever its name or declared type say), stores it publicly
 * in the folder of the signed-in workspace with a random suffix and answers
 * with its URL. The offer keeps that URL as its card image, like a pasted
 * link: the worker sends it to Instagram, which downloads the image itself.
 *
 * An image no offer uses any more is deleted, best effort: when an edit
 * replaces or removes it, and when an offer nobody got is deleted. Only an
 * image this workspace uploaded is ever deleted (a public Vercel Blob URL
 * under offers/<workspaceId>/), and only once no offer of the workspace
 * refers to it, archived ones included: an archived offer keeps its image,
 * as the cards already sent may still show it. A link to an image hosted
 * anywhere else is never touched.
 *
 * Everything here needs BLOB_READ_WRITE_TOKEN, which a Vercel Blob store
 * connected to the project sets. Without it the upload answers 503, the
 * editor shows the plain image-URL field and nothing is deleted.
 */

import { del, put } from "@vercel/blob";
import { prisma } from "@/lib/db/client";
import type { OFFER_IMAGE_TYPES } from "@/lib/offers/schema";

/** What an uploaded file turned out to be, and how it is stored. */
export interface OfferImageType {
  contentType: (typeof OFFER_IMAGE_TYPES)[number];
  extension: "jpg" | "png" | "webp";
}

const JPEG: OfferImageType = { contentType: "image/jpeg", extension: "jpg" };
const PNG: OfferImageType = { contentType: "image/png", extension: "png" };
const WEBP: OfferImageType = { contentType: "image/webp", extension: "webp" };

const bytesOf = (text: string) => [...text].map((char) => char.charCodeAt(0));

// The first bytes of each type: JPEG's start-of-image marker, PNG's
// eight-byte signature, and the RIFF container that names WEBP at byte 8.
const JPEG_START = [0xff, 0xd8, 0xff];
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const RIFF = bytesOf("RIFF");
const WEBP_FORM = bytesOf("WEBP");

function hasBytes(bytes: Uint8Array, expected: readonly number[], offset = 0) {
  return (
    bytes.length >= offset + expected.length &&
    expected.every((byte, i) => bytes[offset + i] === byte)
  );
}

/**
 * The image type a file's content shows, or null for anything else. SVG,
 * GIF, HTML or a PDF called cover.jpg all come back null.
 */
export function detectOfferImageType(bytes: Uint8Array): OfferImageType | null {
  if (hasBytes(bytes, JPEG_START)) return JPEG;
  if (hasBytes(bytes, PNG_SIGNATURE)) return PNG;
  if (hasBytes(bytes, RIFF) && hasBytes(bytes, WEBP_FORM, 8)) return WEBP;
  return null;
}

/** The token of the connected Blob store, or null while none is set up. */
export function offerImageToken(): string | null {
  return process.env.BLOB_READ_WRITE_TOKEN?.trim() || null;
}

/** Whether the editor can upload card images here. */
export function isOfferImageUploadEnabled(): boolean {
  return offerImageToken() !== null;
}

/** The folder of a workspace's card images in the store. */
export function offerImageFolder(workspaceId: string): string {
  return `offers/${workspaceId}/`;
}

// A public blob: https://<store id>.public.blob.vercel-storage.com/<path>.
const PUBLIC_BLOB_HOST = /^[a-z0-9][a-z0-9-]*\.public\.blob\.vercel-storage\.com$/;

/**
 * Whether a card image URL is an image this workspace uploaded: a public
 * Vercel Blob URL in the workspace's folder. Nothing else is ever deleted.
 * The URL parser resolves "..", so a path cannot climb out of the folder,
 * and a deletion only ever reaches the store the token belongs to.
 */
export function isUploadedOfferImage(
  url: string | null | undefined,
  workspaceId: string
): url is string {
  if (!url || !workspaceId) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const folder = `/offers/${encodeURIComponent(workspaceId)}/`;
  return (
    parsed.protocol === "https:" &&
    parsed.port === "" &&
    parsed.username === "" &&
    parsed.password === "" &&
    PUBLIC_BLOB_HOST.test(parsed.hostname) &&
    parsed.pathname.startsWith(folder) &&
    parsed.pathname.length > folder.length
  );
}

/**
 * Stores an image whose type detectOfferImageType found, as
 * offers/<workspaceId>/cover-<random>.<ext>, and returns its public URL.
 * Throws when the store refuses it.
 */
export async function storeOfferImage({
  workspaceId,
  bytes,
  type,
  token,
}: {
  workspaceId: string;
  bytes: Uint8Array;
  type: OfferImageType;
  token: string;
}): Promise<string> {
  const blob = await put(
    `${offerImageFolder(workspaceId)}cover.${type.extension}`,
    Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    {
      access: "public",
      // A new name for every upload: a replaced image never shows up again
      // from a cache, and no upload overwrites another.
      addRandomSuffix: true,
      // From the content, never from what the browser declared.
      contentType: type.contentType,
      // Named explicitly: without it the library would prefer a Vercel OIDC
      // token where BLOB_STORE_ID is set as well.
      token,
    }
  );
  return blob.url;
}

/**
 * Deletes a card image no offer uses any more, best effort: called once an
 * edit replaced or removed it, or an offer was deleted for good. Skips any
 * URL that is not this workspace's upload and any image another offer of
 * the workspace still shows, archived ones included. Never throws: the
 * offer is saved already, and a leftover image only takes up space.
 */
export async function deleteUnusedOfferImage(
  workspaceId: string,
  url: string
): Promise<void> {
  if (!isUploadedOfferImage(url, workspaceId)) return;
  const token = offerImageToken();
  if (!token) return;
  try {
    const stillUsed = await prisma.offer.count({
      where: { workspaceId, cardImageUrl: url },
    });
    if (stillUsed > 0) return;
    await del(url, { token });
  } catch (error) {
    console.warn("[Offer image] Could not delete an image no offer uses:", error);
  }
}

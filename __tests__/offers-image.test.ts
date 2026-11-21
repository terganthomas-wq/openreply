/**
 * Card image upload (spec D2): POST /api/offers/image, and the rules for
 * deleting an image no offer uses any more (lib/offers/image.ts). Vercel
 * Blob is mocked, so nothing here reaches a store. What the Offers API does
 * with an edited or deleted offer's image is in offers-api.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockPut, mockDel, mockCount, mockContext } = vi.hoisted(() => ({
  mockPut: vi.fn(),
  mockDel: vi.fn(),
  mockCount: vi.fn(),
  mockContext: vi.fn(),
}));

vi.mock("@vercel/blob", () => ({ put: mockPut, del: mockDel }));

vi.mock("@/lib/db/client", () => ({
  prisma: { offer: { count: mockCount } },
}));

vi.mock("@/lib/auth", () => ({
  getCurrentUserId: vi.fn(),
  getCurrentWorkspaceId: vi.fn(),
}));

// The real role check; only the signed-in context is replaced.
vi.mock("@/lib/workspace-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/workspace-access")>()),
  getCurrentWorkspaceContext: mockContext,
}));

import { POST } from "../app/api/offers/image/route";
import {
  deleteUnusedOfferImage,
  detectOfferImageType,
  isOfferImageUploadEnabled,
  isUploadedOfferImage,
} from "../lib/offers/image";
import { OFFER_IMAGE_MAX_BYTES } from "../lib/offers/schema";

const WORKSPACE = "workspace_123";
// Shaped like a read-write token; a local test value, never a real one.
const TOKEN = "vercel_blob_rw_teststore_localtestvalue";
const STORE = "https://teststore.public.blob.vercel-storage.com";
const UPLOADED = `${STORE}/offers/${WORKSPACE}/cover-AbC123xYz.jpg`;

const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

// The first bytes of each kind of file.
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...ascii("JFIF")];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, ...ascii("IHDR")];
const WEBP = [...ascii("RIFF"), 0x24, 0, 0, 0, ...ascii("WEBPVP8 ")];

/** A file that starts with `head`, `size` bytes long. */
function fileBytes(head: number[], size = 256): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(Math.max(size, head.length));
  bytes.set(head);
  return bytes;
}

function imageFile(
  head: number[],
  { name = "cover.jpg", type = "image/jpeg", size = 256 } = {}
) {
  return new File([fileBytes(head, size)], name, { type });
}

/** POST /api/offers/image with `file` in the field "file", as the editor sends it. */
function upload(
  file: File | string | null,
  {
    fields = {},
    headers,
    query = "",
  }: {
    fields?: Record<string, string>;
    headers?: Record<string, string>;
    query?: string;
  } = {}
) {
  const form = new FormData();
  if (file !== null) form.append("file", file);
  for (const [name, value] of Object.entries(fields)) form.append(name, value);
  return POST(
    new NextRequest(`https://app.example.com/api/offers/image${query}`, {
      method: "POST",
      body: form,
      headers,
    })
  );
}

function putCall() {
  expect(mockPut).toHaveBeenCalledTimes(1);
  const [pathname, body, options] = mockPut.mock.calls[0];
  return { pathname, body: body as Buffer, options };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", TOKEN);
  mockContext.mockResolvedValue({ workspaceId: WORKSPACE, role: "OWNER" });
  // As Vercel Blob answers: the pathname with its random suffix.
  mockPut.mockImplementation(async (pathname: string) => ({
    url: `${STORE}/${pathname.replace("/cover.", "/cover-AbC123xYz.")}`,
  }));
  mockDel.mockResolvedValue(undefined);
  mockCount.mockResolvedValue(0);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/offers/image: who may upload", () => {
  it("answers 401 without a workspace", async () => {
    mockContext.mockResolvedValue(null);

    const response = await upload(imageFile(JPEG));

    expect(response.status).toBe(401);
    expect(mockPut).not.toHaveBeenCalled();
  });

  it("refuses a member, like every other change to offers", async () => {
    mockContext.mockResolvedValue({ workspaceId: WORKSPACE, role: "MEMBER" });

    const response = await upload(imageFile(JPEG));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      success: false,
      error: "Only owners and admins can manage offers",
    });
    expect(mockPut).not.toHaveBeenCalled();
  });

  it("lets an admin upload", async () => {
    mockContext.mockResolvedValue({ workspaceId: WORKSPACE, role: "ADMIN" });

    const response = await upload(imageFile(JPEG));

    expect(response.status).toBe(201);
  });

  it.each([
    ["missing", ""],
    ["blank", "   "],
  ])(
    "answers 503 with what to set up while BLOB_READ_WRITE_TOKEN is %s",
    async (_case, token) => {
      vi.stubEnv("BLOB_READ_WRITE_TOKEN", token);

      const response = await upload(imageFile(JPEG));

      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/BLOB_READ_WRITE_TOKEN/);
      expect(body.error).toMatch(/Vercel Blob store/);
      expect(mockPut).not.toHaveBeenCalled();
    }
  );
});

describe("POST /api/offers/image: what is stored", () => {
  it("stores a JPEG publicly in the workspace's folder, with a random suffix, and answers with its URL", async () => {
    const file = imageFile(JPEG);

    const response = await upload(file);

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ success: true, data: { url: UPLOADED } });
    const { pathname, body, options } = putCall();
    expect(pathname).toBe(`offers/${WORKSPACE}/cover.jpg`);
    expect(options).toEqual({
      access: "public",
      addRandomSuffix: true,
      contentType: "image/jpeg",
      token: TOKEN,
    });
    expect(new Uint8Array(body)).toEqual(new Uint8Array(await file.arrayBuffer()));
  });

  it.each([
    ["a PNG", PNG, "image/png", "png"],
    ["a WebP image", WEBP, "image/webp", "webp"],
  ])("stores %s under its own type", async (_case, head, contentType, extension) => {
    const response = await upload(imageFile(head, { name: `cover.${extension}`, type: contentType }));

    expect(response.status).toBe(201);
    const { pathname, options } = putCall();
    expect(pathname).toBe(`offers/${WORKSPACE}/cover.${extension}`);
    expect(options.contentType).toBe(contentType);
  });

  it.each([
    ["a PNG named photo.jpg and declared a JPEG", imageFile(PNG, { name: "photo.jpg", type: "image/jpeg" }), "png", "image/png"],
    ["a JPEG the browser could not name", imageFile(JPEG, { name: "upload", type: "" }), "jpg", "image/jpeg"],
    ["a WebP image declared as bytes", imageFile(WEBP, { name: "x.bin", type: "application/octet-stream" }), "webp", "image/webp"],
  ])(
    "tells the type from the content, not the name or declared type: %s",
    async (_case, file, extension, contentType) => {
      const response = await upload(file);

      expect(response.status).toBe(201);
      const { pathname, options } = putCall();
      expect(pathname).toBe(`offers/${WORKSPACE}/cover.${extension}`);
      expect(options.contentType).toBe(contentType);
    }
  );

  it.each([
    ["an SVG called cover.jpg", ascii('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
    ["an HTML page called cover.jpg", ascii("<!doctype html><html><body>hi</body></html>")],
    ["a GIF", ascii("GIF89a")],
    ["a PDF", ascii("%PDF-1.7")],
    ["a RIFF file that is not WebP", [...ascii("RIFF"), 0x24, 0, 0, 0, ...ascii("WAVEfmt ")]],
    ["a file cut off after the start of a PNG signature", [0x89, 0x50, 0x4e, 0x47]],
  ])("refuses %s with 415", async (_case, head) => {
    const response = await upload(
      new File([new Uint8Array(head)], "cover.jpg", { type: "image/jpeg" })
    );

    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({
      success: false,
      error: "Only JPEG, PNG and WebP images can be uploaded",
    });
    expect(mockPut).not.toHaveBeenCalled();
  });

  it("takes the folder from the session, never from the request", async () => {
    const response = await upload(imageFile(PNG, { name: "../../workspace_other/cover.png", type: "image/png" }), {
      fields: { workspaceId: "workspace_other", pathname: "offers/workspace_other/x.png" },
      query: "?workspaceId=workspace_other",
    });

    expect(response.status).toBe(201);
    expect(putCall().pathname).toBe(`offers/${WORKSPACE}/cover.png`);
  });

  it("answers 502 when the store refuses the image", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    mockPut.mockRejectedValue(new Error("Vercel Blob: store suspended"));

    const response = await upload(imageFile(JPEG));

    expect(response.status).toBe(502);
    expect((await response.json()).success).toBe(false);
    expect(logged).toHaveBeenCalled();
  });
});

describe("POST /api/offers/image: size and form", () => {
  it("takes an image of exactly 5 MB", async () => {
    const response = await upload(imageFile(JPEG, { size: OFFER_IMAGE_MAX_BYTES }));

    expect(response.status).toBe(201);
    expect(putCall().body.byteLength).toBe(OFFER_IMAGE_MAX_BYTES);
  });

  it.each([
    ["one byte over 5 MB", OFFER_IMAGE_MAX_BYTES + 1],
    // Past the room left for the form around the file: reading stops there.
    ["far over 5 MB", OFFER_IMAGE_MAX_BYTES + 512 * 1024],
  ])("refuses an image %s with 413", async (_case, size) => {
    const response = await upload(imageFile(JPEG, { size }));

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      success: false,
      error: "The image is larger than 5 MB",
    });
    expect(mockPut).not.toHaveBeenCalled();
  });

  it("refuses a body that declares more than the limit without reading it", async () => {
    const response = await upload(imageFile(JPEG), {
      headers: { "content-length": String(20 * 1024 * 1024) },
    });

    expect(response.status).toBe(413);
    expect(mockPut).not.toHaveBeenCalled();
  });

  it.each([
    ["no file field", null],
    ["a text in the file field", "https://cdn.example.com/cover.jpg"],
    ["an empty file", new File([], "cover.jpg", { type: "image/jpeg" })],
  ])("answers 400 to %s", async (_case, file) => {
    const response = await upload(file);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      success: false,
      error: 'Send the image as multipart/form-data in the field "file"',
    });
    expect(mockPut).not.toHaveBeenCalled();
  });

  it("answers 400 to a body that is not a form", async () => {
    const response = await POST(
      new NextRequest("https://app.example.com/api/offers/image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: "cover.jpg" }),
      })
    );

    expect(response.status).toBe(400);
    expect(mockPut).not.toHaveBeenCalled();
  });
});

describe("detectOfferImageType", () => {
  it("reads JPEG, PNG and WebP from the first bytes and nothing else", () => {
    expect(detectOfferImageType(fileBytes(JPEG))).toEqual({ contentType: "image/jpeg", extension: "jpg" });
    expect(detectOfferImageType(fileBytes(PNG))).toEqual({ contentType: "image/png", extension: "png" });
    expect(detectOfferImageType(fileBytes(WEBP))).toEqual({ contentType: "image/webp", extension: "webp" });
    expect(detectOfferImageType(new Uint8Array(0))).toBeNull();
    expect(detectOfferImageType(new Uint8Array([0xff, 0xd8]))).toBeNull();
    expect(detectOfferImageType(new Uint8Array(ascii("RIFF")))).toBeNull();
  });
});

describe("isOfferImageUploadEnabled", () => {
  it("is on only while a Blob token is set", () => {
    expect(isOfferImageUploadEnabled()).toBe(true);
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "  ");
    expect(isOfferImageUploadEnabled()).toBe(false);
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
    expect(isOfferImageUploadEnabled()).toBe(false);
  });
});

describe("isUploadedOfferImage", () => {
  it.each([
    ["a JPEG", UPLOADED],
    ["a WebP image", `${STORE}/offers/${WORKSPACE}/cover-Q9w8e7.webp`],
  ])("knows %s in the workspace's folder", (_case, url) => {
    expect(isUploadedOfferImage(url, WORKSPACE)).toBe(true);
  });

  it.each([
    ["no image", null],
    ["an empty field", ""],
    ["not a URL", "cover.jpg"],
    ["an image hosted elsewhere", "https://cdn.example.com/guide-cover.jpg"],
    ["a Google Drive link", "https://drive.google.com/file/d/1AbC/view?usp=sharing"],
    ["the same path on another host", `https://cdn.example.com/offers/${WORKSPACE}/cover-AbC123xYz.jpg`],
    ["a host that only starts like a store", `https://teststore.public.blob.vercel-storage.com.evil.example/offers/${WORKSPACE}/cover.jpg`],
    ["a store host in the path", `https://evil.example/teststore.public.blob.vercel-storage.com/offers/${WORKSPACE}/cover.jpg`],
    ["a private store", `https://teststore.private.blob.vercel-storage.com/offers/${WORKSPACE}/cover.jpg`],
    ["plain http", `http://teststore.public.blob.vercel-storage.com/offers/${WORKSPACE}/cover.jpg`],
    ["a URL with credentials", `https://user:secret@teststore.public.blob.vercel-storage.com/offers/${WORKSPACE}/cover.jpg`],
    ["a URL with a port", `https://teststore.public.blob.vercel-storage.com:8443/offers/${WORKSPACE}/cover.jpg`],
    ["another workspace's upload", `${STORE}/offers/workspace_other/cover-AbC123xYz.jpg`],
    ["a workspace whose id starts with this one", `${STORE}/offers/${WORKSPACE}0/cover-AbC123xYz.jpg`],
    ["the folder itself", `${STORE}/offers/${WORKSPACE}/`],
    ["a file outside the offers folder", `${STORE}/avatars/${WORKSPACE}/cover.jpg`],
    ["a path that climbs out of the folder", `${STORE}/offers/${WORKSPACE}/../workspace_other/cover.jpg`],
    ["an encoded climb out of the folder", `${STORE}/offers/${WORKSPACE}/%2e%2e/workspace_other/cover.jpg`],
  ])("never takes %s for an upload", (_case, url) => {
    expect(isUploadedOfferImage(url, WORKSPACE)).toBe(false);
  });

  it("needs a workspace", () => {
    expect(isUploadedOfferImage(UPLOADED, "")).toBe(false);
  });
});

describe("deleteUnusedOfferImage", () => {
  it("deletes an upload no offer of the workspace shows any more, archived ones included", async () => {
    await deleteUnusedOfferImage(WORKSPACE, UPLOADED);

    // No archivedAt filter: an archived offer's cards may still show it.
    expect(mockCount).toHaveBeenCalledWith({
      where: { workspaceId: WORKSPACE, cardImageUrl: UPLOADED },
    });
    expect(mockDel).toHaveBeenCalledTimes(1);
    expect(mockDel).toHaveBeenCalledWith(UPLOADED, { token: TOKEN });
  });

  it("keeps an upload another offer still shows", async () => {
    mockCount.mockResolvedValue(1);

    await deleteUnusedOfferImage(WORKSPACE, UPLOADED);

    expect(mockDel).not.toHaveBeenCalled();
  });

  it.each([
    ["an image hosted elsewhere", "https://cdn.example.com/guide-cover.jpg"],
    ["another workspace's upload", `${STORE}/offers/workspace_other/cover-AbC123xYz.jpg`],
  ])("never touches %s", async (_case, url) => {
    await deleteUnusedOfferImage(WORKSPACE, url);

    expect(mockCount).not.toHaveBeenCalled();
    expect(mockDel).not.toHaveBeenCalled();
  });

  it("deletes nothing while no Blob store is connected", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");

    await deleteUnusedOfferImage(WORKSPACE, UPLOADED);

    expect(mockCount).not.toHaveBeenCalled();
    expect(mockDel).not.toHaveBeenCalled();
  });

  it.each([
    ["the store", () => mockDel.mockRejectedValue(new Error("Vercel Blob: service unavailable"))],
    ["the database", () => mockCount.mockRejectedValue(new Error("connection lost"))],
  ])("never throws when %s fails: the file is only left behind", async (_case, fail) => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    fail();

    await expect(deleteUnusedOfferImage(WORKSPACE, UPLOADED)).resolves.toBeUndefined();
    expect(warned).toHaveBeenCalled();
  });
});

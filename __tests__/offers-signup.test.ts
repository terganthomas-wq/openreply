/**
 * Sign-up feedback from an offer's landing page: the personal code on the
 * link (ig=), and POST /api/offers/signup, where the landing page's server
 * reports the sign-up with a key that may only do that.
 *
 * The code must be random and URL-safe and go into the destination without
 * touching the rest of the address. The callback must take only the key's
 * workspace and only offers that report sign-ups, record a sign-up once
 * (time and tag together), queue the chat confirmation once, answer at once
 * and never write the code or the key to a log.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockEval, mockQueueAdd } = vi.hoisted(() => ({
  mockPrisma: {
    serviceKey: { findUnique: vi.fn(), update: vi.fn() },
    contactOffer: { findFirst: vi.fn(), updateMany: vi.fn() },
    contactTag: { createMany: vi.fn() },
    operationalEvent: { create: vi.fn() },
    $transaction: vi.fn(),
  },
  mockEval: vi.fn(),
  mockQueueAdd: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
// The service keys' rate limiter (lib/integrations/auth.ts).
vi.mock("ioredis", () => ({
  default: class {
    status = "ready";
    eval = mockEval;
    listenerCount() {
      return 1;
    }
  },
}));
vi.mock("@/lib/queue/client", () => ({
  getDMQueue: () => ({ add: mockQueueAdd }),
  OFFER_JOB_NAME: "process-offer",
}));

import { POST } from "../app/api/offers/signup/route";
import { hashServiceToken } from "../lib/integrations/auth";
import { recordSignup } from "../lib/offers/signup";
import {
  parseSignupToken,
  SIGNUP_CALLBACK_PATH,
  SIGNUP_TOKEN_PATTERN,
  withSignupToken,
} from "../lib/offers/signup-link";
import { newSignupToken, signupTokenFor } from "../lib/offers/signup-token";
import { buildSignupCallbackUrl } from "../lib/tracking/message";

const KEY = `orp_${"k".repeat(43)}`;
const CODE = "AbCdEfGhIjKlMnOpQrStUv-_"; // 24 base64url characters
const signupKey = {
  id: "key_signups",
  workspaceId: "workspace_123",
  scopes: ["signups:write"],
  expiresAt: new Date("2099-01-01"),
  revokedAt: null,
};

/** The row recordSignup finds for CODE. */
function reportedRow(overrides: Record<string, unknown> = {}, offer: Record<string, unknown> = {}) {
  return {
    id: "co_1",
    contactId: "contact_1",
    signedUpAt: null,
    offer: {
      tagSignedUp: "Guide eingetragen",
      signupMessage: "Danke fürs Eintragen! 📩",
      ...offer,
    },
    contact: {
      instagramAccountId: "account_row_1",
      instagramAccount: { instagramId: "ig_456" },
    },
    ...overrides,
  };
}

function report(body: unknown, headers: Record<string, string> = {}) {
  return POST(
    new Request(`https://app.example.com${SIGNUP_CALLBACK_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${KEY}`,
        "content-type": "application/json",
        ...headers,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    })
  );
}

// Everything the route and its helpers wrote to the console.
function logged(...spies: ReturnType<typeof vi.spyOn>[]): string {
  return JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("REDIS_URL", "redis://localhost:6379");
  vi.stubEnv("NEXTAUTH_URL", "https://app.example.com");
  mockEval.mockReset().mockResolvedValue(1);
  mockPrisma.serviceKey.findUnique.mockReset().mockResolvedValue(signupKey);
  mockPrisma.serviceKey.update.mockReset().mockResolvedValue(signupKey);
  mockPrisma.contactOffer.findFirst.mockReset().mockResolvedValue(reportedRow());
  mockPrisma.contactOffer.updateMany.mockReset().mockResolvedValue({ count: 1 });
  mockPrisma.contactTag.createMany.mockReset().mockResolvedValue({ count: 1 });
  mockPrisma.operationalEvent.create.mockReset().mockResolvedValue({});
  // An interactive transaction, run on the same mocks.
  mockPrisma.$transaction
    .mockReset()
    .mockImplementation(async (run: (tx: typeof mockPrisma) => unknown) => run(mockPrisma));
  mockQueueAdd.mockReset().mockResolvedValue({});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the sign-up code", () => {
  it("is 24 random base64url characters, 144 bits", () => {
    const codes = new Set(Array.from({ length: 200 }, () => newSignupToken()));
    expect(codes.size).toBe(200);
    for (const code of codes) {
      expect(code).toMatch(/^[A-Za-z0-9_-]{24}$/);
      expect(Buffer.from(code, "base64url")).toHaveLength(18);
    }
  });

  it("is told apart from a recipient token and a service key by its shape", () => {
    expect(parseSignupToken(CODE)).toBe(CODE);
    expect(parseSignupToken(newSignupToken())).not.toBeNull();
    for (const value of [
      "",
      "AbCdEfGhIjKlMnOpQrSt_-", // a recipient token (?r=): 22 characters
      `${CODE}x`,
      CODE.slice(1),
      "AbCdEfGhIjKlMnOpQrStUv+/", // base64, not base64url
      "AbCdEfGhIjKlMnOpQrStUv=_",
      ` ${CODE.slice(1)}`,
      KEY,
      null,
      undefined,
      12345,
      { token: CODE },
    ]) {
      expect(parseSignupToken(value), String(value)).toBeNull();
    }
    expect(SIGNUP_TOKEN_PATTERN.test(CODE)).toBe(true);
  });
});

describe("withSignupToken", () => {
  it("adds ig to a destination without a query", () => {
    expect(withSignupToken("https://example.com/guide", CODE)).toBe(
      `https://example.com/guide?ig=${CODE}`
    );
  });

  it("keeps the query as typed, its order and encoding included, and the fragment", () => {
    expect(
      withSignupToken(
        "https://landing.example/de/guide?utm_source=instagram&q=a%20b&path=/x/y&flag#formular",
        CODE
      )
    ).toBe(
      `https://landing.example/de/guide?utm_source=instagram&q=a%20b&path=/x/y&flag&ig=${CODE}#formular`
    );
  });

  it("replaces an ig the link carried already, also written escaped", () => {
    expect(withSignupToken("https://example.com/?ig=old&a=1&ig=older", CODE)).toBe(
      `https://example.com/?a=1&ig=${CODE}`
    );
    expect(withSignupToken("https://example.com/?i%67=old&b=2", CODE)).toBe(
      `https://example.com/?b=2&ig=${CODE}`
    );
    // Only ig itself: a parameter that merely starts with it stays.
    expect(withSignupToken("https://example.com/?igloo=1", CODE)).toBe(
      `https://example.com/?igloo=1&ig=${CODE}`
    );
  });

  it("leaves no empty parameter behind", () => {
    expect(withSignupToken("https://example.com/?", CODE)).toBe(
      `https://example.com/?ig=${CODE}`
    );
    expect(withSignupToken("https://example.com/?a=1&&b=2&", CODE)).toBe(
      `https://example.com/?a=1&b=2&ig=${CODE}`
    );
  });

  it("works for a Google Drive share link", () => {
    expect(
      withSignupToken("https://drive.google.com/file/d/1AbC/view?usp=sharing", CODE)
    ).toBe(`https://drive.google.com/file/d/1AbC/view?usp=sharing&ig=${CODE}`);
  });

  it("throws for a destination that is no URL, for the redirect to catch", () => {
    expect(() => withSignupToken("not a url", CODE)).toThrow();
  });
});

describe("the callback address", () => {
  it("is the app's public address plus the route", () => {
    expect(buildSignupCallbackUrl()).toBe("https://app.example.com/api/offers/signup");
    expect(buildSignupCallbackUrl("https://dm.example.org/")).toBe(
      "https://dm.example.org/api/offers/signup"
    );
  });
});

describe("the code for a click (signupTokenFor)", () => {
  const click = { workspaceId: "workspace_123", offerId: "offer_1", recipientHash: "r_token" };

  it("looks for the newest row of this offer for the link's recipient, in the workspace", async () => {
    mockPrisma.contactOffer.findFirst.mockResolvedValue({ id: "co_1", signupToken: CODE });

    expect(await signupTokenFor(click)).toBe(CODE);
    expect(mockPrisma.contactOffer.findFirst).toHaveBeenCalledWith({
      where: { workspaceId: "workspace_123", offerId: "offer_1", contact: { recipientHash: "r_token" } },
      orderBy: [{ offeredAt: "desc" }, { id: "desc" }],
      select: { id: true, signupToken: true },
    });
    // A row that has its code keeps it.
    expect(mockPrisma.contactOffer.updateMany).not.toHaveBeenCalled();
  });

  it("creates the code on the first click, only into an empty column", async () => {
    mockPrisma.contactOffer.findFirst.mockResolvedValue({ id: "co_1", signupToken: null });

    const code = await signupTokenFor(click);

    expect(code).toMatch(SIGNUP_TOKEN_PATTERN);
    expect(mockPrisma.contactOffer.updateMany).toHaveBeenCalledWith({
      where: { id: "co_1", workspaceId: "workspace_123", signupToken: null },
      data: { signupToken: code },
    });
  });

  it("takes the code a click at the same moment wrote first", async () => {
    mockPrisma.contactOffer.findFirst
      .mockResolvedValueOnce({ id: "co_1", signupToken: null })
      .mockResolvedValueOnce({ signupToken: CODE });
    mockPrisma.contactOffer.updateMany.mockResolvedValue({ count: 0 });

    expect(await signupTokenFor(click)).toBe(CODE);
    expect(mockPrisma.contactOffer.findFirst).toHaveBeenLastCalledWith({
      where: { id: "co_1", workspaceId: "workspace_123" },
      select: { signupToken: true },
    });
  });

  it("has none for a recipient who did not get the offer", async () => {
    mockPrisma.contactOffer.findFirst.mockResolvedValue(null);

    expect(await signupTokenFor(click)).toBeNull();
    expect(mockPrisma.contactOffer.updateMany).not.toHaveBeenCalled();
  });
});

describe("POST /api/offers/signup: who may report", () => {
  it("needs a service key", async () => {
    for (const authorization of ["", "Bearer nope", `Basic ${KEY}`]) {
      const response = await report({ token: CODE }, { authorization });
      expect(response.status).toBe(401);
    }
    expect(mockPrisma.contactOffer.findFirst).not.toHaveBeenCalled();
  });

  it("refuses an expired, revoked or unknown key", async () => {
    for (const stored of [null, { ...signupKey, revokedAt: new Date() }, { ...signupKey, expiresAt: new Date(0) }]) {
      mockPrisma.serviceKey.findUnique.mockResolvedValueOnce(stored);
      expect((await report({ token: CODE })).status).toBe(401);
    }
    expect(mockPrisma.serviceKey.findUnique).toHaveBeenCalledWith({
      where: { tokenHash: hashServiceToken(KEY) },
    });
    expect(mockPrisma.contactOffer.findFirst).not.toHaveBeenCalled();
  });

  it("refuses campaign keys: only signups:write reports sign-ups", async () => {
    for (const scopes of [["campaigns:read"], ["campaigns:read", "campaigns:write"], ["campaigns:write"]]) {
      mockPrisma.serviceKey.findUnique.mockResolvedValueOnce({ ...signupKey, scopes });
      const response = await report({ token: CODE });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "Missing scope: signups:write" });
    }
    expect(mockPrisma.contactOffer.findFirst).not.toHaveBeenCalled();
  });

  it("refuses a request from a browser page of another origin", async () => {
    const response = await report({ token: CODE }, { origin: "https://landing.example" });

    expect(response.status).toBe(403);
    expect(mockPrisma.serviceKey.findUnique).not.toHaveBeenCalled();
  });

  it("is rate limited per key, as the other service endpoints are", async () => {
    mockEval.mockResolvedValueOnce(121);
    expect((await report({ token: CODE })).status).toBe(429);
    mockEval.mockRejectedValueOnce(new Error("redis down"));
    expect((await report({ token: CODE })).status).toBe(503);
    expect(mockPrisma.contactOffer.findFirst).not.toHaveBeenCalled();
    expect(mockEval).toHaveBeenCalledWith(expect.any(String), 1, "integration-rate:key_signups");
  });
});

describe("POST /api/offers/signup: the body", () => {
  it.each([
    ["an empty object", {}],
    ["a number", { token: 42 }],
    ["a code that is too short", { token: CODE.slice(2) }],
    ["a recipient token", { token: "AbCdEfGhIjKlMnOpQrSt_-" }],
    ["a code with other characters", { token: "AbCdEfGhIjKlMnOpQrSt%20x" }],
    ["another field besides the code", { token: CODE, email: "a@example.com" }],
    ["a list", [CODE]],
    ["a bare string", JSON.stringify(CODE)],
    ["null", "null"],
    ["broken JSON", "{token:"],
  ])("answers 400 to %s and looks nothing up", async (_case, body) => {
    const response = await report(body);

    expect(response.status).toBe(400);
    expect(mockPrisma.contactOffer.findFirst).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("answers 415 without the JSON content type and 413 to a large body", async () => {
    expect((await report({ token: CODE }, { "content-type": "text/plain" })).status).toBe(415);
    expect((await report({ token: CODE, padding: "x".repeat(2000) })).status).toBe(413);
    expect(mockPrisma.contactOffer.findFirst).not.toHaveBeenCalled();
  });
});

describe("POST /api/offers/signup: recording", () => {
  it("records the first report: the time and the tag in one transaction, then queues the confirmation", async () => {
    const steps: string[] = [];
    mockPrisma.$transaction.mockImplementation(async (run: (tx: typeof mockPrisma) => unknown) => {
      steps.push("begin");
      const result = await run(mockPrisma);
      steps.push("commit");
      return result;
    });
    mockPrisma.contactOffer.updateMany.mockImplementation(async () => {
      steps.push("signedUpAt");
      return { count: 1 };
    });
    mockPrisma.contactTag.createMany.mockImplementation(async () => {
      steps.push("tag");
      return { count: 1 };
    });
    mockQueueAdd.mockImplementation(async () => {
      steps.push("queue");
      return {};
    });

    const response = await report({ token: CODE });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ data: { alreadyRecorded: false } });
    expect(steps).toEqual(["begin", "signedUpAt", "tag", "commit", "queue"]);

    // Only the key's workspace, only offers that report sign-ups.
    expect(mockPrisma.contactOffer.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          workspaceId: "workspace_123",
          signupToken: CODE,
          offer: { signupTrackingEnabled: true },
        },
      })
    );
    expect(mockPrisma.contactOffer.updateMany).toHaveBeenCalledWith({
      where: { id: "co_1", workspaceId: "workspace_123", signedUpAt: null },
      data: { signedUpAt: expect.any(Date) },
    });
    expect(mockPrisma.contactTag.createMany).toHaveBeenCalledWith({
      data: [{ workspaceId: "workspace_123", contactId: "contact_1", tag: "Guide eingetragen" }],
      skipDuplicates: true,
    });
    // The confirmation is a job: the answer never waits for Instagram. Its
    // data carries ids only, never the code.
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    expect(mockQueueAdd).toHaveBeenCalledWith(
      "process-offer",
      {
        workspaceId: "workspace_123",
        accountConnectionId: "account_row_1",
        instagramAccountId: "ig_456",
        phase: "signup",
        contactOfferId: "co_1",
      },
      { jobId: "offer_co_1_signup", removeOnComplete: true }
    );
    expect(JSON.stringify(mockQueueAdd.mock.calls)).not.toContain(CODE);
  });

  it("changes nothing for a code reported before", async () => {
    mockPrisma.contactOffer.findFirst.mockResolvedValue(
      reportedRow({ signedUpAt: new Date("2026-11-21T08:07:00.000Z") })
    );

    const response = await report({ token: CODE });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { alreadyRecorded: true } });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.contactOffer.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.contactTag.createMany).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("adds no tag and queues nothing when a report at the same moment recorded it", async () => {
    mockPrisma.contactOffer.updateMany.mockResolvedValue({ count: 0 });

    const response = await report({ token: CODE });

    expect(await response.json()).toEqual({ data: { alreadyRecorded: true } });
    expect(mockPrisma.contactTag.createMany).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it.each([
    ["without a confirmation text", null],
    ["with an empty confirmation text", "   "],
  ])("tags only, %s", async (_case, signupMessage) => {
    mockPrisma.contactOffer.findFirst.mockResolvedValue(reportedRow({}, { signupMessage }));

    const response = await report({ token: CODE });

    expect(await response.json()).toEqual({ data: { alreadyRecorded: false } });
    expect(mockPrisma.contactTag.createMany).toHaveBeenCalledTimes(1);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("answers 404 to a code it does not know: another workspace's, of an offer that stopped reporting, or of a deleted contact", async () => {
    mockPrisma.contactOffer.findFirst.mockResolvedValue(null);

    const response = await report({ token: CODE });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Unknown token" });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("keeps the sign-up and says so in Diagnostics when the confirmation cannot be queued", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockQueueAdd.mockRejectedValue(new Error("Connection is closed."));

    const response = await report({ token: CODE });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { alreadyRecorded: false } });
    expect(mockPrisma.contactTag.createMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.operationalEvent.create).toHaveBeenCalledWith({
      data: {
        workspaceId: "workspace_123",
        source: "SYSTEM",
        level: "WARNING",
        message: "Sign-up confirmation not queued",
        payload: { contactOfferId: "co_1", error: "Connection is closed." },
      },
    });
    expect(logged(consoleError)).not.toContain(CODE);
  });

  it("never writes the code or the key to a log, not even when the database fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Prisma's messages can quote the query, the code included.
    const failure = Object.assign(
      new Error(`Invalid prisma.contactOffer.findFirst() invocation: { signupToken: "${CODE}" }`),
      { name: "PrismaClientKnownRequestError", code: "P1001" }
    );
    mockPrisma.contactOffer.findFirst.mockRejectedValue(failure);

    const response = await report({ token: CODE });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Internal error" });
    expect(consoleError).toHaveBeenCalledWith(
      "[Sign-up] Report failed:",
      "PrismaClientKnownRequestError P1001"
    );
    const output = logged(consoleError, consoleLog, consoleWarn);
    expect(output).not.toContain(CODE);
    expect(output).not.toContain(KEY);
  });
});

describe("recordSignup", () => {
  it("tells the three outcomes apart", async () => {
    expect(await recordSignup("workspace_123", CODE)).toEqual({
      status: "recorded",
      confirmation: "queued",
    });
    mockPrisma.contactOffer.findFirst.mockResolvedValueOnce(
      reportedRow({ signedUpAt: new Date() })
    );
    expect(await recordSignup("workspace_123", CODE)).toEqual({ status: "alreadyRecorded" });
    mockPrisma.contactOffer.findFirst.mockResolvedValueOnce(null);
    expect(await recordSignup("workspace_123", CODE)).toEqual({ status: "unknown" });
    mockPrisma.contactOffer.findFirst.mockResolvedValueOnce(
      reportedRow({}, { signupMessage: null })
    );
    expect(await recordSignup("workspace_123", CODE)).toEqual({
      status: "recorded",
      confirmation: "none",
    });
  });
});

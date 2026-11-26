import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { mockPrisma, mockExchange, mockQueueAdd } = vi.hoisted(() => ({
  mockPrisma: {
    workspaceMember: { findFirst: vi.fn() },
    instagramAccount: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn(),
    },
    operationalEvent: { create: vi.fn() },
  },
  mockExchange: vi.fn(),
  mockQueueAdd: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
// The reconnect asks the worker for the catch-up of the missed comments.
vi.mock("@/lib/queue/client", () => ({
  getDMQueue: () => ({ add: mockQueueAdd }),
  CATCH_UP_JOB_NAME: "process-catch-up",
}));
vi.mock("@/lib/auth", () => ({
  auth: vi.fn(async () => ({ user: { id: "user" } })),
}));
vi.mock("@/lib/workspace-access", () => ({ canManageWorkspace: () => true }));
vi.mock("@/lib/instagram-accounts", () => ({
  canConnectInstagramAccount: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/lib/meta/oauth", () => ({
  verifyOAuthState: () => ({ workspaceId: "workspace", ts: Date.now() }),
  exchangeCodeForToken: mockExchange,
  encryptToken: (value: string) => `enc:${value}`,
}));

import { GET } from "../app/api/instagram/callback/route";

const fetchMock = vi.fn();
function respond(body: unknown) {
  fetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(body), { status: 200 })
  );
}
function callback() {
  return GET(
    new NextRequest("https://app.test/api/instagram/callback?code=c&state=s")
  );
}
const urls = () => fetchMock.mock.calls.map(([url]) => String(url));

beforeEach(() => {
  vi.clearAllMocks();
  // Drop queued responses too, so one test's leftovers never feed the next.
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("NEXTAUTH_URL", "https://app.test");
  mockPrisma.workspaceMember.findFirst.mockResolvedValue({ role: "OWNER" });
  mockPrisma.instagramAccount.findUnique.mockResolvedValue(null);
  mockPrisma.operationalEvent.create.mockResolvedValue({});
  mockQueueAdd.mockResolvedValue({ id: "job" });
});
afterEach(() => vi.unstubAllEnvs());

describe("Instagram OAuth callback", () => {
  it("connects through Instagram Login exactly as before when Unified login is not configured", async () => {
    vi.stubEnv("INSTAGRAM_APP_SECRET", "ig-secret");
    mockExchange.mockResolvedValue({ accessToken: "short", userId: "1" });
    respond({ access_token: "long", expires_in: 5184000 });
    respond({ id: "app-scoped", user_id: "ig1", username: "shop" });
    respond({ success: true });

    const response = await callback();

    expect(response.headers.get("location")).toBe(
      "https://app.test/dashboard?connected=true"
    );
    expect(urls()[0]).toMatch(/^https:\/\/graph\.instagram\.com\/v[\d.]+\/access_token\?/);
    expect(urls()[1]).toMatch(/^https:\/\/graph\.instagram\.com\/v[\d.]+\/me\?/);
    expect(urls()[2]).toMatch(/^https:\/\/graph\.instagram\.com\/v[\d.]+\/ig1\/subscribed_apps$/);
    expect(mockPrisma.instagramAccount.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        instagramId: "ig1",
        accessToken: "enc:long",
        metaLogin: "INSTAGRAM",
        tokenExpiresAt: expect.any(Date),
      }),
    });
  });

  it("connects every account a Unified login granted, on graph.facebook.com", async () => {
    vi.stubEnv("META_LOGIN_CONFIG_ID", "config");
    vi.stubEnv("META_APP_ID", "app");
    vi.stubEnv("FACEBOOK_APP_SECRET", "secret");
    mockExchange.mockResolvedValue({ accessToken: "suat", userId: "" });
    respond({ data: { expires_at: 0 } });
    respond({ data: [{ id: "ig1" }, { id: "ig2" }] });
    respond({ id: "ig1", username: "one" });
    respond({ success: true });
    respond({ id: "ig2", username: "two" });
    respond({ success: true });

    const response = await callback();

    expect(response.headers.get("location")).toBe(
      "https://app.test/dashboard?connected=true"
    );
    expect(urls().every((url) => url.startsWith("https://graph.facebook.com/"))).toBe(true);
    expect(urls()[0]).toContain("/debug_token?");
    expect(urls()[0]).toContain("access_token=app%7Csecret");
    expect(urls()[1]).toContain("/me/assigned_instagram_accounts?");
    expect(urls()[2]).toContain("/ig1?");
    expect(urls()[2]).not.toContain("user_id");
    expect(urls()[3]).toMatch(/\/ig1\/subscribed_apps$/);
    expect(urls()[4]).toContain("/ig2?");
    expect(mockPrisma.instagramAccount.create).toHaveBeenCalledTimes(2);
    expect(mockPrisma.instagramAccount.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        instagramId: "ig2",
        username: "two",
        accessToken: "enc:suat",
        metaLogin: "UNIFIED",
        // A token that never expires stores no expiry.
        tokenExpiresAt: null,
        webhookSubscribed: true,
      }),
    });
  });

  it("moves an existing Instagram Login account to Unified login when it reconnects", async () => {
    vi.stubEnv("META_LOGIN_CONFIG_ID", "config");
    vi.stubEnv("META_APP_ID", "app");
    vi.stubEnv("FACEBOOK_APP_SECRET", "secret");
    mockExchange.mockResolvedValue({ accessToken: "suat", userId: "" });
    mockPrisma.instagramAccount.findUnique.mockResolvedValue({ id: "row" });
    mockPrisma.instagramAccount.updateMany.mockResolvedValue({ count: 1 });
    respond({ data: { expires_at: 1_900_000_000 } });
    respond({ data: [{ id: "ig1" }] });
    respond({ id: "ig1", username: "one" });
    respond({ success: true });

    await callback();

    expect(mockPrisma.instagramAccount.updateMany).toHaveBeenCalledWith({
      where: { id: "row", workspaceId: "workspace", provider: "META" },
      data: expect.objectContaining({
        metaLogin: "UNIFIED",
        accessToken: "enc:suat",
        tokenExpiresAt: new Date(1_900_000_000 * 1000),
      }),
    });
  });

  // A1: the reconnect ends a lost-connection incident at once.
  describe("an account whose connection was lost", () => {
    const lostAt = new Date("2026-11-25T16:45:00.000Z");

    function unifiedReconnect() {
      vi.stubEnv("META_LOGIN_CONFIG_ID", "config");
      vi.stubEnv("META_APP_ID", "app");
      vi.stubEnv("FACEBOOK_APP_SECRET", "secret");
      mockExchange.mockResolvedValue({ accessToken: "suat", userId: "" });
      respond({ data: { expires_at: 0 } });
      respond({ data: [{ id: "ig1" }] });
      respond({ id: "ig1", username: "one" });
      respond({ success: true });
    }

    it("ends the incident and keeps its start for the catch-up", async () => {
      mockPrisma.instagramAccount.findUnique.mockResolvedValue({
        id: "row",
        workspaceId: "workspace",
        instagramId: "ig1",
        username: "one",
        connectionLostAt: lostAt,
        connectionCheckFailedAt: lostAt,
        connectionCatchUpFrom: null,
      });
      mockPrisma.instagramAccount.updateMany.mockResolvedValue({ count: 1 });
      unifiedReconnect();

      const response = await callback();

      expect(response.headers.get("location")).toBe(
        "https://app.test/dashboard?connected=true"
      );
      // First the new token, then the incident, on the same row.
      expect(mockPrisma.instagramAccount.updateMany).toHaveBeenCalledTimes(2);
      expect(mockPrisma.instagramAccount.updateMany).toHaveBeenNthCalledWith(2, {
        where: { id: "row", connectionLostAt: lostAt },
        data: {
          connectionLostAt: null,
          connectionLostReason: null,
          connectionCheckFailedAt: null,
          connectionAlertCount: 0,
          connectionRecoveredAt: expect.any(Date),
          connectionCatchUpFrom: lostAt,
        },
      });
      expect(mockPrisma.operationalEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          workspaceId: "workspace",
          source: "SYSTEM",
          level: "INFO",
          payload: expect.objectContaining({
            kind: "connection-back",
            account: "one",
            via: "reconnect",
            lostAt: lostAt.toISOString(),
            catchUpFrom: lostAt.toISOString(),
          }),
        }),
      });
      // A1 catch-up: the worker gets the job, under the id the check and the
      // worker's sweep use too, so it runs once.
      expect(mockQueueAdd).toHaveBeenCalledTimes(1);
      expect(mockQueueAdd).toHaveBeenCalledWith(
        "process-catch-up",
        { accountConnectionId: "row", instagramAccountId: "ig1" },
        {
          jobId: `catchup_row_${lostAt.getTime()}`,
          delay: 0,
          removeOnComplete: true,
          removeOnFail: true,
        }
      );
    });

    it("still connects when the catch-up cannot be queued", async () => {
      mockPrisma.instagramAccount.findUnique.mockResolvedValue({
        id: "row",
        workspaceId: "workspace",
        instagramId: "ig1",
        username: "one",
        connectionLostAt: lostAt,
        connectionCheckFailedAt: lostAt,
        connectionCatchUpFrom: null,
      });
      mockPrisma.instagramAccount.updateMany.mockResolvedValue({ count: 1 });
      mockQueueAdd.mockRejectedValueOnce(new Error("Connection is closed."));
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      unifiedReconnect();

      const response = await callback();

      expect(response.headers.get("location")).toBe(
        "https://app.test/dashboard?connected=true"
      );
      // The worker's next sweep asks for it again.
      expect(error).toHaveBeenCalledWith(
        "[Connection check] Could not queue the catch-up:",
        "Connection is closed."
      );
      error.mockRestore();
    });

    it("still connects when the incident cannot be ended", async () => {
      mockPrisma.instagramAccount.findUnique
        .mockResolvedValueOnce({ id: "row" })
        .mockRejectedValueOnce(new Error("Connection terminated unexpectedly"));
      mockPrisma.instagramAccount.updateMany.mockResolvedValue({ count: 1 });
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      unifiedReconnect();

      const response = await callback();

      expect(response.headers.get("location")).toBe(
        "https://app.test/dashboard?connected=true"
      );
      expect(error).toHaveBeenCalledWith(
        "[Instagram Callback] Could not end the connection incident:",
        "Connection terminated unexpectedly"
      );
      error.mockRestore();
    });

    it("has nothing to end for a newly connected account", async () => {
      unifiedReconnect();
      await callback();
      expect(mockPrisma.instagramAccount.create).toHaveBeenCalledTimes(1);
      expect(mockPrisma.instagramAccount.updateMany).not.toHaveBeenCalled();
      expect(mockQueueAdd).not.toHaveBeenCalled();
    });
  });

  it("explains a Unified login that granted no Instagram account", async () => {
    vi.stubEnv("META_LOGIN_CONFIG_ID", "config");
    vi.stubEnv("META_APP_ID", "app");
    vi.stubEnv("FACEBOOK_APP_SECRET", "secret");
    mockExchange.mockResolvedValue({ accessToken: "suat", userId: "" });
    respond({ data: { expires_at: 0 } });
    respond({ data: [] });

    const response = await callback();

    expect(response.headers.get("location")).toContain("instagram=failed");
    expect(decodeURIComponent(response.headers.get("location")!)).toContain(
      "business_management"
    );
    expect(mockPrisma.instagramAccount.create).not.toHaveBeenCalled();
  });
});

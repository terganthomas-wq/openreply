/**
 * The worker's manual-send path (forceAutomationId, M1) with a mocked
 * database: which campaign it loads, that it skips the matching, labels its
 * claim "(manuell)", decides the public reply as the job says, keeps the
 * follow gate, and names its copies apart from the automatic job's. The real
 * claims and the races run in manual-send.db.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockPrisma,
  mockSendPrivateReply,
  mockSendPrivateReplyWithButton,
  mockSendCommentReply,
  mockGetUserFollowStatus,
  mockMatchKeywords,
  mockQueueAdd,
  redis,
} = vi.hoisted(() => ({
  mockPrisma: {
    automation: { findMany: vi.fn(), findFirst: vi.fn() },
    dmLog: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    instagramAccount: { findUnique: vi.fn() },
    operationalEvent: { create: vi.fn() },
    contact: { upsert: vi.fn(), updateMany: vi.fn() },
    contactTag: { createMany: vi.fn() },
  },
  mockSendPrivateReply: vi.fn(),
  mockSendPrivateReplyWithButton: vi.fn(),
  mockSendCommentReply: vi.fn(),
  mockGetUserFollowStatus: vi.fn(),
  mockMatchKeywords: vi.fn(),
  mockQueueAdd: vi.fn(),
  redis: { current: null as unknown },
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/meta/client", () => ({
  sendPrivateReply: mockSendPrivateReply,
  sendPrivateReplyWithButton: mockSendPrivateReplyWithButton,
  sendCommentReply: mockSendCommentReply,
  getUserFollowStatus: mockGetUserFollowStatus,
  MetaApiError: class MetaApiError extends Error {
    code: number;
    constructor(code: number, _subcode: unknown, _trace: unknown, message: string) {
      super(message);
      this.code = code;
    }
  },
  TokenExpiredError: class TokenExpiredError extends Error {},
  RateLimitError: class RateLimitError extends Error {},
}));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: () => "decrypted_token" }));
vi.mock("@/lib/utils/keyword-matcher", () => ({ matchKeywords: mockMatchKeywords }));
vi.mock("@/lib/utils/rate-limiter", () => ({
  reserveDMSlot: async () => ({
    allowed: true,
    currentCount: 1,
    remainingDMs: 749,
    shouldRequeue: false,
    requeueDelayMs: 0,
    shouldSkip: false,
    reserved: true,
  }),
  releaseDMSlot: async () => 0,
}));
vi.mock("@/lib/billing/usage", () => ({
  reserveWorkspaceDMSend: async () => ({
    allowed: true,
    reserved: true,
    remaining: 100,
    limit: 2000,
    periodStart: new Date("2026-11-01T00:00:00.000Z"),
  }),
  releaseWorkspaceDMReservation: async () => ({ count: 1 }),
}));
vi.mock("@/lib/ops/worker-health", () => ({ recordWorkerAlert: vi.fn() }));
vi.mock("@/lib/queue/client", () => ({
  getDMQueue: () => ({ add: mockQueueAdd, remove: vi.fn() }),
  getRedisConnection: () => redis.current,
  COMMENT_JOB_NAME: "process-comment",
  POSTBACK_JOB_NAME: "process-postback",
  FOLLOWUP_JOB_NAME: "process-followup",
  MESSAGE_JOB_NAME: "process-message",
  OFFER_JOB_NAME: "process-offer",
  CATCH_UP_JOB_NAME: "process-catch-up",
}));
vi.mock("bullmq", () => ({
  Worker: function MockWorker(_name: string, processor: unknown) {
    (globalThis as Record<string, unknown>).__manualWorker = processor;
    return { on: vi.fn(), close: vi.fn() };
  },
  UnrecoverableError: class UnrecoverableError extends Error {},
}));

import { createDMWorker } from "../lib/queue/dm-worker";
import { FakeRedis } from "./helpers/fake-redis";

const CAMPAIGN = {
  id: "c_guide",
  workspaceId: "workspace_1",
  instagramAccountId: "account_1",
  name: "Guide",
  postId: "media_other",
  matchAnyPost: false,
  isActive: false,
  keywords: ["GUIDE"],
  matchAnyWord: false,
  wholeWordMatch: true,
  ignoreQuestionComments: true,
  dmMessage: "Hier ist dein Guide",
  openingDmEnabled: false,
  openingDmMessage: null,
  openingDmButtonLabel: null,
  linkButtonLabel: null,
  requireFollow: false,
  followPromptMessage: null,
  followPromptButtonLabel: null,
  publicReplyEnabled: false,
  publicReplyMessage: null,
  publicReplyMessages: ["Schau in deine DMs"],
  deliveryTag: null,
  followUpEnabled: false,
  followUpMessage: null,
  followUpDelayMinutes: 0,
  offersEnabled: false,
  offerDelayHours: 0,
  instagramAccount: {
    id: "account_1",
    instagramId: "ig_1",
    username: "studio",
    accessToken: "encrypted",
    provider: "META",
    metaLogin: "INSTAGRAM",
    workspaceId: "workspace_1",
    zernioAccountId: null,
  },
  workspace: { id: "workspace_1" },
  trackedLinks: [],
};

function manualJob(data: Record<string, unknown> = {}) {
  return {
    name: "process-comment",
    id: "manual_ig_1_comment_1_c_guide_0",
    attemptsMade: 0,
    data: {
      instagramAccountId: "ig_1",
      accountConnectionId: "account_1",
      commentId: "comment_1",
      commentText: "Wo bekomme ich den Guide?",
      commenterId: "person_1",
      commenterName: "anna",
      mediaId: "media_1",
      source: "MANUAL",
      forceAutomationId: "c_guide",
      publicReplyOverride: false,
      ...data,
    },
  };
}

function run(job: unknown): Promise<void> {
  createDMWorker();
  const processor = (globalThis as Record<string, unknown>).__manualWorker as (
    job: unknown
  ) => Promise<void>;
  return processor(job);
}

// The DM claim: the one write that sets dmDeliveryUnconfirmed.
function claimCall() {
  return mockPrisma.dmLog.updateMany.mock.calls.find(
    ([args]) => args.data?.dmDeliveryUnconfirmed === true && args.data?.attempts
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  redis.current = new FakeRedis();
  mockQueueAdd.mockReset().mockResolvedValue({});
  mockPrisma.automation.findFirst.mockReset().mockResolvedValue(CAMPAIGN);
  mockPrisma.automation.findMany.mockReset().mockResolvedValue([]);
  mockPrisma.dmLog.findUnique.mockReset().mockResolvedValue(null);
  mockPrisma.dmLog.findFirst.mockReset().mockResolvedValue(null);
  mockPrisma.dmLog.findMany.mockReset().mockResolvedValue([]);
  mockPrisma.dmLog.upsert.mockReset().mockResolvedValue({});
  mockPrisma.dmLog.update.mockReset().mockResolvedValue({});
  mockPrisma.dmLog.updateMany.mockReset().mockResolvedValue({ count: 1 });
  mockPrisma.instagramAccount.findUnique.mockReset().mockResolvedValue({ workspaceId: "workspace_1" });
  mockPrisma.operationalEvent.create.mockReset().mockResolvedValue({});
  mockPrisma.contact.upsert.mockReset().mockResolvedValue({
    id: "contact_1",
    username: "anna",
    lastInteractionAt: null,
  });
  mockSendPrivateReply.mockReset().mockResolvedValue({ recipient_id: "p", message_id: "m" });
  mockSendPrivateReplyWithButton.mockReset().mockResolvedValue({ recipient_id: "p", message_id: "m" });
  mockSendCommentReply.mockReset().mockResolvedValue({ id: "reply" });
  mockGetUserFollowStatus.mockReset().mockResolvedValue(true);
  mockMatchKeywords.mockReset().mockReturnValue({ matched: false, matchedKeyword: null });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("DM worker — a manual send (forceAutomationId)", () => {
  it("loads exactly the named campaign on the comment's account, active or not, any post", async () => {
    await run(manualJob());

    expect(mockPrisma.automation.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.automation.findFirst).toHaveBeenCalledWith({
      where: {
        id: "c_guide",
        instagramAccountId: "account_1",
        instagramAccount: { instagramId: "ig_1" },
      },
      include: expect.objectContaining({ instagramAccount: true, workspace: true }),
    });
    // A question the campaign would leave to a human, without a keyword
    // match: neither is asked.
    expect(mockMatchKeywords).not.toHaveBeenCalled();
    expect(mockSendPrivateReply).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "decrypted_token" }),
      "ig_1",
      "comment_1",
      "Hier ist dein Guide"
    );
  });

  it("records the row as (manuell), in the claim itself", async () => {
    await run(manualJob());

    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ matchedKeyword: "(manuell)", status: "PENDING" }),
      })
    );
    expect(claimCall()?.[0]).toEqual({
      where: {
        automationId: "c_guide",
        commentId: "comment_1",
        status: { not: "SENT" },
        dmDeliveryUnconfirmed: false,
        attempts: { lt: 3 },
      },
      data: {
        dmDeliveryUnconfirmed: true,
        attempts: { increment: 1 },
        status: "PENDING",
        errorMessage: null,
        matchedKeyword: "(manuell)",
      },
    });
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "SENT" }) })
    );
  });

  it("posts the public reply when the owner asks, though the campaign has it off", async () => {
    await run(manualJob({ publicReplyOverride: true }));
    expect(mockSendCommentReply).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: "decrypted_token" }),
      "comment_1",
      "Schau in deine DMs"
    );
  });

  it("posts no public reply when the owner switched it off, and closes it for later jobs", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue({ ...CAMPAIGN, publicReplyEnabled: true });
    await run(manualJob({ publicReplyOverride: false }));

    expect(mockSendCommentReply).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.updateMany).toHaveBeenCalledWith({
      where: {
        automationId: "c_guide",
        commentId: "comment_1",
        publicReplySentAt: null,
        publicReplyDeliveryUnconfirmed: false,
      },
      data: {
        publicReplyDeliveryUnconfirmed: true,
        publicReplyError: "Not posted: the public reply was switched off for this manual send",
      },
    });
  });

  it("keeps the follow gate: someone who does not follow gets the follow request", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue({ ...CAMPAIGN, requireFollow: true });
    mockGetUserFollowStatus.mockResolvedValue(false);

    await run(manualJob());

    expect(mockGetUserFollowStatus).toHaveBeenCalledTimes(1);
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockSendPrivateReplyWithButton).toHaveBeenCalledWith(
      expect.anything(),
      "ig_1",
      "comment_1",
      expect.any(String),
      expect.any(String),
      "followcheck:c_guide"
    );
  });

  it("stands back before it claims when another campaign's DM is out or on its way", async () => {
    mockPrisma.dmLog.findMany.mockResolvedValue([
      {
        status: "PENDING",
        dmDeliveryUnconfirmed: true,
        errorMessage: null,
        automation: { name: "Link" },
      },
    ]);
    await run(manualJob());

    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(claimCall()).toBeUndefined();
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith({
      where: { automationId_commentId: { automationId: "c_guide", commentId: "comment_1" } },
      data: expect.objectContaining({
        status: "SKIPPED_DEDUP",
        matchedKeyword: "(manuell)",
        errorMessage: expect.stringContaining("Another campaign (Link) is sending, or may have sent"),
      }),
    });
  });

  it("gives its claim back when another campaign claimed the comment meanwhile", async () => {
    // Nothing before the claim, another campaign's claim right after it.
    mockPrisma.dmLog.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { status: "PENDING", dmDeliveryUnconfirmed: true, errorMessage: null, automation: { name: "Link" } },
      ]);
    await run(manualJob());

    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.updateMany).toHaveBeenCalledWith({
      where: {
        automationId: "c_guide",
        commentId: "comment_1",
        status: { not: "SENT" },
        dmDeliveryUnconfirmed: true,
        attempts: { gt: 0 },
      },
      data: {
        dmDeliveryUnconfirmed: false,
        attempts: { decrement: 1 },
        status: "SKIPPED_DEDUP",
        errorMessage: expect.stringContaining("Not sent: another campaign (Link)"),
      },
    });
  });

  it("names its pause copy after itself, never after the automatic job", async () => {
    await (redis.current as FakeRedis).set("meta:pause:ig_1", String(Date.now() + 600_000), "PX", 600_000);
    await run(manualJob({ publicReplyOverride: true }));

    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    const [, data, options] = mockQueueAdd.mock.calls[0];
    expect(options.jobId).toBe("manual_ig_1_comment_1_c_guide_pause_1");
    expect(data).toMatchObject({ forceAutomationId: "c_guide", publicReplyOverride: true, pauseRequeue: 1 });
  });

  it("sends nothing for a campaign that is gone, and records it", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(null);
    await run(manualJob());

    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.upsert).not.toHaveBeenCalled();
    expect(mockPrisma.operationalEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace_1",
        level: "WARNING",
        message: expect.stringContaining("Manual send for comment comment_1 not sent"),
      }),
    });
  });
});

describe("DM worker — an automatic job next to a manual send", () => {
  const automatic = {
    name: "process-comment",
    id: "comment_ig_1_comment_1",
    attemptsMade: 0,
    data: {
      instagramAccountId: "ig_1",
      accountConnectionId: "account_1",
      commentId: "comment_1",
      commentText: "LINK",
      commenterId: "person_1",
      commenterName: "anna",
      mediaId: "media_1",
      source: "WEBHOOK",
    },
  };

  beforeEach(() => {
    mockPrisma.automation.findMany.mockResolvedValue([
      { ...CAMPAIGN, id: "c_link", name: "Link", isActive: true, matchAnyPost: true, postId: null },
    ]);
    mockMatchKeywords.mockReturnValue({ matched: true, matchedKeyword: "LINK" });
  });

  it("sends as before when no manual send holds the comment", async () => {
    await run(automatic);
    expect(mockSendPrivateReply).toHaveBeenCalledTimes(1);
    expect(mockPrisma.automation.findFirst).not.toHaveBeenCalled();
  });

  it("gives its claim back to a manual send on its way, for good", async () => {
    mockPrisma.dmLog.findFirst.mockImplementation(async (args: { where?: Record<string, unknown> }) =>
      args.where?.matchedKeyword === "(manuell)"
        ? { matchedKeyword: "(manuell)", automation: { name: "Guide" } }
        : null
    );
    await run(automatic);

    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "SKIPPED_DEDUP",
          attempts: { decrement: 1 },
          errorMessage: expect.stringContaining("sent by hand with another campaign (Guide)"),
        }),
      })
    );
    // Its copies keep the automatic job's names.
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });
});

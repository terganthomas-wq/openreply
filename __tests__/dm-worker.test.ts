import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  mockPrisma,
  mockSendPrivateReply,
  mockSendPrivateReplyWithLinkButton,
  mockSendPrivateReplyWithButton,
  mockGetUserFollowStatus,
  mockSendDirectMessageWithButton,
  mockSendDirectMessage,
  mockSendDirectMessageWithLinkButton,
  mockSendDirectMessageWithCard,
  mockDecryptToken,
  mockMatchKeywords,
  mockReserveDMSlot,
  mockReleaseDMSlot,
  mockQueueAdd,
  mockQueueRemove,
  mockReserveWorkspaceDMSend,
  mockReleaseWorkspaceDMReservation,
} = vi.hoisted(() => ({
  mockPrisma: {
    zernioConnection: { findUnique: vi.fn() },
    postbackDelivery: { create: vi.fn(), delete: vi.fn() },
    automation: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    dmLog: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn(),
    },
    instagramAccount: {
      findUnique: vi.fn(),
    },
    operationalEvent: {
      create: vi.fn(),
    },
    contact: {
      upsert: vi.fn(),
      updateMany: vi.fn(),
      findUnique: vi.fn(),
    },
    contactTag: {
      createMany: vi.fn(),
    },
    contactOffer: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    offer: {
      findMany: vi.fn(),
    },
  },
  mockSendPrivateReply: vi.fn(),
  mockSendPrivateReplyWithLinkButton: vi.fn(),
  mockSendPrivateReplyWithButton: vi.fn(),
  mockGetUserFollowStatus: vi.fn(),
  mockSendDirectMessageWithButton: vi.fn(),
  mockSendDirectMessage: vi.fn(),
  mockSendDirectMessageWithLinkButton: vi.fn(),
  mockSendDirectMessageWithCard: vi.fn(),
  mockDecryptToken: vi.fn(),
  mockMatchKeywords: vi.fn(),
  mockReserveDMSlot: vi.fn(),
  mockReleaseDMSlot: vi.fn(),
  mockQueueAdd: vi.fn(),
  mockQueueRemove: vi.fn(),
  mockReserveWorkspaceDMSend: vi.fn(),
  mockReleaseWorkspaceDMReservation: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  prisma: mockPrisma,
}));

vi.mock("@/lib/meta/client", () => ({
  sendPrivateReply: mockSendPrivateReply,
  sendPrivateReplyWithLinkButton: mockSendPrivateReplyWithLinkButton,
  sendPrivateReplyWithButton: mockSendPrivateReplyWithButton,
  getUserFollowStatus: mockGetUserFollowStatus,
  sendDirectMessageWithButton: mockSendDirectMessageWithButton,
  sendDirectMessage: mockSendDirectMessage,
  sendDirectMessageWithLinkButton: mockSendDirectMessageWithLinkButton,
  sendDirectMessageWithCard: mockSendDirectMessageWithCard,
  sendCommentReply: vi.fn(),
  MetaApiError: class MetaApiError extends Error {
    code: number;
    constructor(
      code: number,
      _subcode: number | undefined,
      _fbTraceId: string | undefined,
      message: string
    ) {
      super(message);
      this.code = code;
      this.name = "MetaApiError";
    }
  },
  TokenExpiredError: class TokenExpiredError extends Error {
    name = "TokenExpiredError";
  },
  RateLimitError: class RateLimitError extends Error {
    name = "RateLimitError";
  },
}));

vi.mock("@/lib/meta/oauth", () => ({
  decryptToken: mockDecryptToken,
}));

vi.mock("@/lib/utils/keyword-matcher", () => ({
  matchKeywords: mockMatchKeywords,
}));

vi.mock("@/lib/utils/rate-limiter", () => ({
  reserveDMSlot: mockReserveDMSlot,
  releaseDMSlot: mockReleaseDMSlot,
}));

vi.mock("@/lib/billing/usage", () => ({
  reserveWorkspaceDMSend: mockReserveWorkspaceDMSend,
  releaseWorkspaceDMReservation: mockReleaseWorkspaceDMReservation,
}));

vi.mock("@/lib/ops/worker-health", () => ({
  recordWorkerAlert: vi.fn(),
}));

vi.mock("@/lib/queue/client", () => ({
  getDMQueue: () => ({
    add: mockQueueAdd,
    remove: mockQueueRemove,
  }),
  getRedisConnection: vi.fn(),
  COMMENT_JOB_NAME: "process-comment",
  POSTBACK_JOB_NAME: "process-postback",
  FOLLOWUP_JOB_NAME: "process-followup",
  MESSAGE_JOB_NAME: "process-message",
  OFFER_JOB_NAME: "process-offer",
  CATCH_UP_JOB_NAME: "process-catch-up",
}));

// The real work after a delivered link, observed: tests can read what a
// delivery path reported (how the link went out, when the window opened).
vi.mock("../lib/queue/after-delivery", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../lib/queue/after-delivery")>();
  return { ...actual, afterLinkDelivered: vi.fn(actual.afterLinkDelivered) };
});

// The offer engine, observed the same way: its own suite covers what it does
// (offers-worker.test.ts); this one checks which jobs reach it.
vi.mock("../lib/offers/worker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/offers/worker")>();
  return {
    processOffer: vi.fn(actual.processOffer),
    processOfferTap: vi.fn(actual.processOfferTap),
  };
});

// The catch-up after a lost connection has tests of its own
// (connection-catch-up.test.ts); here only that the worker hands it its job.
const { mockRunCatchUp } = vi.hoisted(() => ({ mockRunCatchUp: vi.fn() }));
vi.mock("@/lib/instagram/connection-catch-up", () => ({
  runConnectionCatchUp: mockRunCatchUp,
}));

vi.mock("bullmq", () => {
  function MockWorker(_name: string, processor: unknown) {
    (global as Record<string, unknown>).__dmWorkerProcessor = processor;
    return {
      on: vi.fn(),
      close: vi.fn(),
    };
  }
  return {
    Worker: MockWorker,
    UnrecoverableError: class UnrecoverableError extends Error {
      name = "UnrecoverableError";
    },
  };
});

import { createHash } from "node:crypto";
import { MetaApiError, RateLimitError } from "@/lib/meta/client";
import { processOffer, processOfferTap } from "../lib/offers/worker";
import { afterLinkDelivered } from "../lib/queue/after-delivery";
import { createDMWorker } from "../lib/queue/dm-worker";
import { getRedisConnection } from "@/lib/queue/client";
import { hashRecipientId } from "@/lib/tracking/server";
import { FakeRedis } from "./helpers/fake-redis";

const usagePeriodStart = new Date("2026-05-01T00:00:00.000Z");

const mockAutomation = {
  id: "auto_789",
  workspaceId: "workspace_123",
  instagramAccountId: "ig_account_row_1",
  postId: "media_101",
  keywords: ["LINK", "PRICE"],
  dmMessage: "Hey {username}! Here is the link: https://example.com",
  isActive: true,
  wholeWordMatch: true,
  matchAnyPost: false,
  matchAnyWord: false,
  openingDmEnabled: false,
  openingDmMessage: null,
  openingDmButtonLabel: null,
  linkButtonLabel: null,
  publicReplyEnabled: false,
  publicReplyMessage: null,
  publicReplyMessages: [],
  instagramAccount: {
    id: "ig_account_row_1",
    instagramId: "ig_456",
    accessToken: "encrypted_token_abc",
  },
  workspace: {
    id: "workspace_123",
  },
  trackedLinks: [],
};

const mockJobData = {
  instagramAccountId: "ig_456",
  commentId: "comment_555",
  commentText: "I want the LINK!",
  commenterId: "commenter_999",
  commenterName: "commenter_user",
  mediaId: "media_101",
};

function getProcessor(): (job: {
  name?: string;
  data: typeof mockJobData | Record<string, unknown>;
  id: string;
  attemptsMade: number;
  timestamp?: number;
}) => Promise<void> {
  createDMWorker();
  return (global as Record<string, unknown>).__dmWorkerProcessor as (job: {
    name?: string;
    data: typeof mockJobData | Record<string, unknown>;
    id: string;
    attemptsMade: number;
    timestamp?: number;
  }) => Promise<void>;
}

function createMockJob(data: Record<string, unknown> = mockJobData) {
  return {
    data,
    id: "job_001",
    attemptsMade: 0,
  };
}

function createMockPostbackJob(
  data: Record<string, unknown> = {
    instagramAccountId: "ig_456",
    userId: "commenter_999",
    payload: "reveal:auto_789",
  }
) {
  return {
    name: "process-postback",
    data,
    id: "postback_job_001",
    attemptsMade: 0,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // An empty Redis: no account is paused for a Meta request limit.
  vi.mocked(getRedisConnection).mockReturnValue(new FakeRedis() as never);
  // clearAllMocks keeps implementations: a test that makes the queue fail must
  // not leave the next test with a failing queue.
  mockQueueAdd.mockReset();
  mockPrisma.postbackDelivery.create.mockReset().mockResolvedValue({});
  mockPrisma.postbackDelivery.delete.mockReset().mockResolvedValue({});

  mockPrisma.automation.findMany.mockResolvedValue([mockAutomation]);
  mockPrisma.automation.findFirst.mockResolvedValue(null);
  mockPrisma.dmLog.findUnique.mockResolvedValue(null);
  mockPrisma.dmLog.create.mockResolvedValue({});
  // Three different lookups share findFirst: the cross-campaign private-reply
  // check (keyed on status SENT), a read fallback's check for a DM keyword
  // the campaign answered, and the name lookup (keyed on a stored name).
  // Only the name lookup should resolve by default, or every comment would
  // look like a duplicate of an already-answered one and every read fallback
  // like one the DM trigger made pointless.
  mockPrisma.dmLog.findFirst.mockImplementation(
    async (args: { where?: { commenterName?: unknown } } = {}) =>
      args.where?.commenterName ? { commenterName: "commenter_user" } : null
  );
  mockPrisma.dmLog.upsert.mockResolvedValue({});
  mockPrisma.dmLog.update.mockReset().mockResolvedValue({});
  mockPrisma.dmLog.updateMany.mockReset().mockResolvedValue({ count: 1 });
  mockPrisma.instagramAccount.findUnique.mockResolvedValue({
    workspaceId: "workspace_123",
  });
  mockPrisma.operationalEvent.create.mockResolvedValue({});
  // Reset, not just cleared: a test that makes a contact write fail must not
  // leave the next one with a failing database.
  mockPrisma.contact.upsert.mockReset().mockResolvedValue({
    id: "contact_1",
    username: "commenter_user",
    lastInteractionAt: null,
  });
  mockPrisma.contact.updateMany.mockReset().mockResolvedValue({ count: 1 });
  mockPrisma.contact.findUnique.mockReset().mockResolvedValue(null);
  mockPrisma.contactTag.createMany.mockReset().mockResolvedValue({ count: 1 });
  mockPrisma.contactOffer.findUnique.mockReset().mockResolvedValue(null);
  mockPrisma.contactOffer.findFirst.mockReset().mockResolvedValue(null);
  mockPrisma.contactOffer.findMany.mockReset().mockResolvedValue([]);
  mockPrisma.contactOffer.create.mockReset();
  mockPrisma.contactOffer.updateMany.mockReset().mockResolvedValue({ count: 1 });
  mockPrisma.offer.findMany.mockReset().mockResolvedValue([]);
  mockQueueRemove.mockReset().mockResolvedValue(1);
  mockDecryptToken.mockReturnValue("decrypted_token");
  mockMatchKeywords.mockReturnValue({ matched: true, matchedKeyword: "LINK" });
  mockReserveWorkspaceDMSend.mockResolvedValue({
    allowed: true,
    reserved: true,
    remaining: 100,
    limit: 2000,
    periodStart: usagePeriodStart,
  });
  mockReserveDMSlot.mockResolvedValue({
    allowed: true,
    currentCount: 11,
    remainingDMs: 179,
    shouldRequeue: false,
    requeueDelayMs: 0,
    shouldSkip: false,
    reserved: true,
  });
  mockReleaseDMSlot.mockResolvedValue(0);
  mockReleaseWorkspaceDMReservation.mockResolvedValue({ count: 1 });
  mockSendPrivateReply.mockResolvedValue({
    recipient_id: "commenter_999",
    message_id: "msg_001",
  });
  mockSendPrivateReplyWithLinkButton.mockResolvedValue({
    recipient_id: "commenter_999",
    message_id: "msg_002",
  });
  mockSendPrivateReplyWithButton.mockResolvedValue({
    recipient_id: "commenter_999",
    message_id: "msg_003",
  });
  mockSendDirectMessageWithButton.mockResolvedValue({
    recipient_id: "commenter_999",
    message_id: "msg_004",
  });
  mockSendDirectMessage.mockResolvedValue({
    recipient_id: "commenter_999",
    message_id: "msg_005",
  });
  mockSendDirectMessageWithLinkButton.mockResolvedValue({
    recipient_id: "commenter_999",
    message_id: "msg_006",
  });
  mockGetUserFollowStatus.mockResolvedValue(true);
});


// An account connected through Instagram Login, as every pre-Unified-login row
// is: the worker hands its decrypted token to the Meta client with its login.
const META_AUTH = expect.objectContaining({
  accessToken: "decrypted_token",
  unifiedLogin: false,
});
describe("DM Worker — comments left on an ad", () => {
  it("also matches the organic post the ad was created from", async () => {
    const processor = getProcessor();

    // A boosted post: the comment carries the ad's media id, while the
    // campaign is bound to the post the ad was made from. Without the second
    // id in the query the comment matches nothing and is dropped silently.
    await processor(
      createMockJob({
        ...mockJobData,
        mediaId: "ad_media_999",
        originalMediaId: "media_101",
      })
    );

    expect(mockPrisma.automation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { postId: "ad_media_999" },
            { postId: "media_101" },
            { matchAnyPost: true },
          ],
        }),
      })
    );
    expect(mockSendPrivateReply).toHaveBeenCalled();
  });
});

describe("DM Worker — Full Pipeline", () => {
  it("should send a private reply for a matching comment", async () => {
    const processor = getProcessor();

    await processor(createMockJob());

    expect(mockPrisma.automation.findMany).toHaveBeenCalledWith({
      where: {
        OR: [{ postId: "media_101" }, { matchAnyPost: true }],
        isActive: true,
        instagramAccount: { instagramId: "ig_456" },
      },
      include: {
        instagramAccount: true,
        workspace: true,
        trackedLinks: {
          select: {
            slug: true,
            label: true,
            destinationUrl: true,
          },
          // Button order: position first, with createdAt and id only as
          // tie breakers, so tied rows can never come back swapped.
          orderBy: [{ position: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        },
      },
      orderBy: { createdAt: "asc" },
    });
    expect(mockMatchKeywords).toHaveBeenCalledWith(
      "I want the LINK!",
      ["LINK", "PRICE"],
      true
    );
    expect(mockReserveWorkspaceDMSend).toHaveBeenCalledWith("workspace_123");
    expect(mockReserveDMSlot).toHaveBeenCalledWith("ig_456", 0);
    // A successful send keeps its slot; the release path is failure-only.
    expect(mockReleaseDMSlot).not.toHaveBeenCalled();
    expect(mockDecryptToken).toHaveBeenCalledWith("encrypted_token_abc");
    expect(mockSendPrivateReply).toHaveBeenCalledWith(
      META_AUTH,
      "ig_456",
      "comment_555",
      "Hey commenter_user! Here is the link: https://example.com"
    );
    expect(mockReleaseWorkspaceDMReservation).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith({
      where: {
        automationId_commentId: {
          automationId: "auto_789",
          commentId: "comment_555",
        },
      },
      data: expect.objectContaining({ status: "SENT" }),
    });
  });

  it("should skip when no automations match the media", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);
    const processor = getProcessor();

    await processor(createMockJob());

    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.upsert).not.toHaveBeenCalled();
  });

  it("should skip when keywords do not match", async () => {
    mockMatchKeywords.mockReturnValue({ matched: false, matchedKeyword: null });
    const processor = getProcessor();

    await processor(createMockJob());

    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
  });

  it("should skip duplicate comments already sent", async () => {
    mockPrisma.dmLog.findUnique.mockResolvedValue({
      id: "existing_log",
      status: "SENT",
    });
    const processor = getProcessor();

    await processor(createMockJob());

    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
  });

  it("should skip when monthly plan limit is reached", async () => {
    mockReserveWorkspaceDMSend.mockResolvedValue({
      allowed: false,
      reserved: false,
      remaining: 0,
      limit: 100,
      periodStart: usagePeriodStart,
    });

    const processor = getProcessor();
    await processor(createMockJob());

    expect(mockReserveDMSlot).not.toHaveBeenCalled();
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "SKIPPED_PLAN_LIMIT" }),
      })
    );
  });

  it("should requeue and release monthly usage when rate limited", async () => {
    mockReserveDMSlot.mockResolvedValue({
      allowed: false,
      currentCount: 190,
      remainingDMs: 0,
      shouldRequeue: true,
      requeueDelayMs: 1800000,
      shouldSkip: false,
      reserved: false,
    });

    const processor = getProcessor();
    await processor(createMockJob());

    expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalledWith(
      "workspace_123",
      usagePeriodStart
    );
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockQueueAdd).toHaveBeenCalledWith(
      "process-comment",
      expect.objectContaining({
        commentId: "comment_555",
        requeueAttempt: 1,
      }),
      expect.objectContaining({
        delay: 1800000,
        jobId: "comment_ig_456_comment_555_retry_1",
      })
    );
  });

  it("should skip with SKIPPED_RATE_LIMIT after max requeue attempts", async () => {
    mockReserveDMSlot.mockResolvedValue({
      allowed: false,
      currentCount: 190,
      remainingDMs: 0,
      shouldRequeue: false,
      requeueDelayMs: 0,
      shouldSkip: true,
      reserved: false,
    });

    const processor = getProcessor();
    await processor(createMockJob());

    expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalledWith(
      "workspace_123",
      usagePeriodStart
    );
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "SKIPPED_RATE_LIMIT" }),
      })
    );
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
  });

  it("should log FAILED, release usage, and re-throw when private reply sending fails", async () => {
    const error = new RateLimitError("API Error");
    mockSendPrivateReply.mockRejectedValue(error);

    const processor = getProcessor();

    await expect(processor(createMockJob())).rejects.toThrow("API Error");
    expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalledWith(
      "workspace_123",
      usagePeriodStart
    );
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith({
      where: {
        automationId_commentId: {
          automationId: "auto_789",
          commentId: "comment_555",
        },
      },
      data: expect.objectContaining({
        status: "FAILED",
        errorMessage: "API Error",
      }),
    });
  });

  it("should handle missing access token", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...mockAutomation,
        instagramAccount: {
          ...mockAutomation.instagramAccount,
          accessToken: null,
        },
      },
    ]);

    const processor = getProcessor();
    await processor(createMockJob());

    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          status: "FAILED",
          errorMessage: "No Instagram access token available",
        }),
      })
    );
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
  });

  it("should use 'there' when commenter name is not available", async () => {
    const processor = getProcessor();
    const jobDataWithoutName = {
      instagramAccountId: mockJobData.instagramAccountId,
      commentId: mockJobData.commentId,
      commentText: mockJobData.commentText,
      commenterId: mockJobData.commenterId,
      mediaId: mockJobData.mediaId,
    };

    await processor(createMockJob(jobDataWithoutName as typeof mockJobData));

    expect(mockSendPrivateReply).toHaveBeenCalledWith(
      META_AUTH,
      "ig_456",
      "comment_555",
      "Hey there! Here is the link: https://example.com"
    );
  });

  it("should deliver tracked links as web_url buttons (one or two)", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...mockAutomation,
        dmMessage: "Hey {username}! Here is the offer: {link}",
        linkButtonLabel: "Get offer",
        trackedLinks: [
          {
            slug: "abc123",
            label: "Primary campaign link",
            destinationUrl: "https://example.com",
          },
          {
            slug: "def456",
            label: "Book a call",
            destinationUrl: "https://example.com/book",
          },
        ],
      },
    ]);

    const processor = getProcessor();
    await processor(createMockJob());

    // Primary button title comes from linkButtonLabel; the second from its
    // own stored label. Both point at their tracked /r/<slug> URLs, tagged
    // with the commenter's recipient token.
    const token = hashRecipientId(mockJobData.commenterId);
    expect(mockSendPrivateReplyWithLinkButton).toHaveBeenCalledWith(
      META_AUTH,
      "ig_456",
      "comment_555",
      "Hey commenter_user! Here is the offer:",
      [
        { title: "Get offer", url: `http://localhost:3000/r/abc123?r=${token}` },
        { title: "Book a call", url: `http://localhost:3000/r/def456?r=${token}` },
      ]
    );
  });

  it("should send a follow-gate prompt when a non-follower comments", async () => {
    mockGetUserFollowStatus.mockResolvedValue(false); // not following yet
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...mockAutomation,
        requireFollow: true,
        followPromptMessage: "Follow me first {username}, then tap 👇",
        followPromptButtonLabel: "I'm following ✅",
        trackedLinks: [
          {
            slug: "abc123",
            label: "Primary campaign link",
            destinationUrl: "https://example.com",
          },
        ],
      },
    ]);

    const processor = getProcessor();
    await processor(createMockJob());

    // The follow prompt goes out with a `followcheck:` postback button; the
    // link is NOT delivered yet.
    expect(mockSendPrivateReplyWithButton).toHaveBeenCalledWith(
      META_AUTH,
      "ig_456",
      "comment_555",
      "Follow me first commenter_user, then tap 👇",
      "I'm following ✅",
      "followcheck:auto_789"
    );
    expect(mockSendPrivateReplyWithLinkButton).not.toHaveBeenCalled();
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
  });

  it("should skip the prompt and send the link when the commenter already follows", async () => {
    mockGetUserFollowStatus.mockResolvedValue(true); // already following
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...mockAutomation,
        requireFollow: true,
        followPromptMessage: "Follow me first, then tap 👇",
        followPromptButtonLabel: "I'm following ✅",
        dmMessage: "Hey {username}! Here is the offer: {link}",
        linkButtonLabel: "Get offer",
        trackedLinks: [
          {
            slug: "abc123",
            label: "Primary campaign link",
            destinationUrl: "https://example.com",
          },
        ],
      },
    ]);

    const processor = getProcessor();
    await processor(createMockJob());

    // Confirmed follower: no prompt, link delivered right away.
    expect(mockSendPrivateReplyWithButton).not.toHaveBeenCalled();
    expect(mockSendPrivateReplyWithLinkButton).toHaveBeenCalledWith(
      META_AUTH,
      "ig_456",
      "comment_555",
      "Hey commenter_user! Here is the offer:",
      [
        {
          title: "Get offer",
          url: `http://localhost:3000/r/abc123?r=${hashRecipientId(mockJobData.commenterId)}`,
        },
      ]
    );
  });

  it("should send the opening DM first (routing to the follow check) when both opening DM and follow-gate are on", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...mockAutomation,
        openingDmEnabled: true,
        openingDmMessage: "Hey {username}, welcome!",
        openingDmButtonLabel: "Get the link",
        requireFollow: true,
        followPromptButtonLabel: "I'm following ✅",
        trackedLinks: [
          {
            slug: "abc123",
            label: "Primary campaign link",
            destinationUrl: "https://example.com",
          },
        ],
      },
    ]);

    const processor = getProcessor();
    await processor(createMockJob());

    // Opening DM goes out first; its button routes into the follow check.
    expect(mockSendPrivateReplyWithButton).toHaveBeenCalledWith(
      META_AUTH,
      "ig_456",
      "comment_555",
      "Hey commenter_user, welcome!",
      "Get the link",
      "followcheck:auto_789:open"
    );
    // Follow status is verified on the tap, not at comment time.
    expect(mockGetUserFollowStatus).not.toHaveBeenCalled();
    expect(mockSendPrivateReplyWithLinkButton).not.toHaveBeenCalled();
  });

  it("should deliver the next DM from a read fallback when no button tap has sent it yet", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...mockAutomation,
      trackedLinks: [],
    });

    const processor = getProcessor();
    await processor(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "reveal:auto_789",
        fallback: true,
      })
    );

    expect(mockPrisma.dmLog.findUnique).toHaveBeenCalledWith({
      where: {
        automationId_commentId: {
          automationId: "auto_789",
          commentId: "reveal:commenter_999",
        },
      },
    });
    expect(mockSendDirectMessage).toHaveBeenCalledWith(
      META_AUTH,
      "ig_456",
      "commenter_999",
      "Hey commenter_user! Here is the link: https://example.com"
    );
  });

  it("should not deliver a read fallback when the button tap already sent the reveal", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...mockAutomation,
      trackedLinks: [],
    });
    mockPrisma.dmLog.findUnique.mockResolvedValue({
      id: "existing_reveal",
      status: "SENT",
    });

    const processor = getProcessor();
    await processor(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "reveal:auto_789",
        fallback: true,
      })
    );

    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
  });

  // A campaign with an opening DM and the DM trigger: the person reads the
  // opening DM and answers it by typing the keyword instead of tapping. The
  // DM trigger sends the link; the fallback queued when they read the
  // opening DM must not send it again.
  it("should not send the link again from a read fallback once the DM trigger answered the person", async () => {
    const campaign = {
      ...mockAutomation,
      openingDmEnabled: true,
      openingDmMessage: "Want the link?",
      openingDmButtonLabel: "Send it",
      dmTriggerEnabled: true,
      trackedLinks: [],
    };
    mockPrisma.automation.findMany.mockResolvedValue([campaign]);
    mockPrisma.automation.findFirst.mockResolvedValue(campaign);
    // DmLog rows as the table keeps them, for the lookups below.
    const rows: Record<string, unknown>[] = [];
    mockPrisma.dmLog.upsert.mockImplementation(
      async ({ create }: { create: Record<string, unknown> }) => {
        rows.push(create);
        return create;
      }
    );
    mockPrisma.dmLog.findFirst.mockImplementation(
      async (
        args: {
          where?: {
            automationId?: string;
            commenterId?: string;
            commenterName?: unknown;
            commentId?: { startsWith?: string };
          };
        } = {}
      ) => {
        const where = args.where ?? {};
        if (where.commenterName) return { commenterName: "commenter_user" };
        const prefix = where.commentId?.startsWith;
        if (!prefix) return null;
        const row = rows.find(
          (log) =>
            log.automationId === where.automationId &&
            log.commenterId === where.commenterId &&
            String(log.commentId).startsWith(prefix) &&
            (log.status === "SENT" || log.dmDeliveryUnconfirmed === true)
        );
        return row ? { id: row.commentId } : null;
      }
    );

    const process = getProcessor();
    await process({
      name: "process-message",
      data: {
        instagramAccountId: "ig_456",
        messageId: "mid_typed_keyword",
        messageText: "LINK",
        senderId: "commenter_999",
      },
      id: "message_job_typed",
      attemptsMade: 0,
    });
    expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);

    // Five minutes after they read the opening DM.
    await process(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "reveal:auto_789",
        fallback: true,
      })
    );

    expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
    expect(mockSendDirectMessageWithLinkButton).not.toHaveBeenCalled();
    // An unconfirmed answer counts as well: it may have reached the inbox.
    // So does one that waits for the account's pause (PENDING).
    expect(mockPrisma.dmLog.findFirst).toHaveBeenCalledWith({
      where: {
        automationId: "auto_789",
        commenterId: "commenter_999",
        commentId: { startsWith: "dm:" },
        OR: [
          { status: "SENT" },
          { status: "PENDING" },
          { dmDeliveryUnconfirmed: true },
        ],
      },
      select: { id: true },
    });
    expect(mockReserveWorkspaceDMSend).toHaveBeenCalledTimes(1);
  });

  it("should not let a read fallback bypass the follow gate", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...mockAutomation,
      requireFollow: true,
      trackedLinks: [],
    });
    mockGetUserFollowStatus.mockResolvedValue(false); // still not following

    const processor = getProcessor();
    await processor(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "reveal:auto_789",
        fallback: true,
      })
    );

    // Non-follower on a read fallback: no link, and no re-prompt spam either.
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockSendDirectMessageWithButton).not.toHaveBeenCalled();
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
  });

  it("should not let a read fallback through when follow status is unverifiable", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...mockAutomation,
      requireFollow: true,
      trackedLinks: [],
    });
    // Instagram answers "User consent is required" until the person taps a
    // button, which is exactly the case of someone who only read the DM.
    mockGetUserFollowStatus.mockResolvedValue(null);

    const processor = getProcessor();
    await processor(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "reveal:auto_789",
        fallback: true,
      })
    );

    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockSendDirectMessageWithButton).not.toHaveBeenCalled();
  });

  it("should deliver a follow-gated read fallback once the user follows", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...mockAutomation,
      requireFollow: true,
      trackedLinks: [],
    });
    mockGetUserFollowStatus.mockResolvedValue(true);

    const processor = getProcessor();
    await processor(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "reveal:auto_789",
        fallback: true,
      })
    );

    expect(mockSendDirectMessage).toHaveBeenCalledWith(
      META_AUTH,
      "ig_456",
      "commenter_999",
      "Hey commenter_user! Here is the link: https://example.com"
    );
  });

  it("should not log a failure when a read fallback hits a closed messaging window", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...mockAutomation,
      trackedLinks: [],
    });
    mockSendDirectMessage.mockRejectedValue(
      new MetaApiError(10, undefined, undefined, "This message is sent outside of allowed window.")
    );

    const processor = getProcessor();
    // The window cannot reopen on its own, so this must not throw (no retries)
    // and must not leave a FAILED row the user can do nothing about.
    await expect(
      processor(
        createMockPostbackJob({
          instagramAccountId: "ig_456",
          userId: "commenter_999",
          payload: "reveal:auto_789",
          fallback: true,
        })
      )
    ).resolves.toBeUndefined();

    expect(mockPrisma.dmLog.upsert).not.toHaveBeenCalled();
    expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalled();
  });

  it("should still log a failure for a real button tap that fails", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...mockAutomation,
      trackedLinks: [],
    });
    mockSendDirectMessage.mockRejectedValue(new Error("boom"));

    const processor = getProcessor();
    await expect(
      processor(
        createMockPostbackJob({
          instagramAccountId: "ig_456",
          userId: "commenter_999",
          payload: "reveal:auto_789",
        })
      )
    ).rejects.toThrow("boom");

    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ status: "FAILED" }),
      })
    );
  });
});

describe("DM Worker — one private reply per comment", () => {
  it("should skip a campaign when another already used the comment's private reply", async () => {
    mockPrisma.dmLog.findFirst.mockImplementation(
      async (args: { where?: { status?: string } } = {}) =>
        args.where?.status === "SENT"
          ? { automation: { name: "openreply 1" } }
          : { commenterName: "commenter_user" }
    );

    const processor = getProcessor();
    await processor(createMockJob());

    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "SKIPPED_DEDUP",
          errorMessage: expect.stringContaining("openreply 1"),
        }),
      })
    );
  });

  it("should not fall back to a plain-text private reply when the window is the problem", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...mockAutomation,
        trackedLinks: [
          {
            slug: "abc123",
            label: null,
            destinationUrl: "https://example.com",
          },
        ],
      },
    ]);
    mockSendPrivateReplyWithLinkButton.mockRejectedValue(
      new MetaApiError(100, undefined, undefined, "The comment is invalid for a private reply")
    );

    const processor = getProcessor();
    await expect(processor(createMockJob())).rejects.toThrow(
      "The comment is invalid for a private reply"
    );

    // The reserved rate slot must be handed back when the send fails, so a
    // comment that never delivered a DM does not burn slots on each retry.
    expect(mockReleaseDMSlot).toHaveBeenCalledWith("ig_456");

    // A text retry on the same comment would fail identically and overwrite the
    // real reason, so it must not be attempted.
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "FAILED",
          errorMessage: expect.stringContaining("The comment is invalid for a private reply"),
        }),
      })
    );
  });

  it("should still fall back to plain text when the button template itself is rejected", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...mockAutomation,
        trackedLinks: [
          {
            slug: "abc123",
            label: null,
            destinationUrl: "https://example.com",
          },
        ],
      },
    ]);
    mockSendPrivateReplyWithLinkButton.mockRejectedValue(
      new MetaApiError(100, undefined, undefined, "Unsupported message template")
    );

    const processor = getProcessor();
    await processor(createMockJob());

    expect(mockSendPrivateReply).toHaveBeenCalled();
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "SENT" }),
      })
    );
  });
});

describe("DM Worker — DM keyword trigger", () => {
  const dmTriggerAutomation = {
    ...mockAutomation,
    dmTriggerEnabled: true,
    requireFollow: false,
    followPromptMessage: null,
    followPromptButtonLabel: null,
  };

  function createMockMessageJob(data: Record<string, unknown> = {}) {
    return {
      name: "process-message",
      data: {
        instagramAccountId: "ig_456",
        messageId: "mid_abc",
        messageText: "can I get the LINK?",
        senderId: "commenter_999",
        ...data,
      },
      id: "message_job_001",
      attemptsMade: 0,
    };
  }

  beforeEach(() => {
    mockPrisma.automation.findMany.mockResolvedValue([dmTriggerAutomation]);
  });

  it("should reply to a DM whose text matches the campaign keywords", async () => {
    const processor = getProcessor();
    await processor(createMockMessageJob());

    expect(mockPrisma.automation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          dmTriggerEnabled: true,
          isActive: true,
        }),
      })
    );
    expect(mockSendDirectMessage).toHaveBeenCalledWith(
      META_AUTH,
      "ig_456",
      "commenter_999",
      "Hey commenter_user! Here is the link: https://example.com"
    );
    // Never a private reply — there is no comment to reply to.
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
  });

  it("should not reply when the DM text matches no keyword", async () => {
    mockMatchKeywords.mockReturnValue({ matched: false, matchedKeyword: null });

    const processor = getProcessor();
    await processor(createMockMessageJob({ messageText: "hello there" }));

    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockSendDirectMessageWithLinkButton).not.toHaveBeenCalled();
  });

  it("should log the reply against the inbound message id for dedup", async () => {
    const processor = getProcessor();
    await processor(createMockMessageJob());

    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          automationId_commentId: {
            automationId: "auto_789",
            commentId: "dm:mid_abc",
          },
        },
        create: expect.objectContaining({
          commenterId: "commenter_999",
          commentText: "can I get the LINK?",
          matchedKeyword: "LINK",
          status: "SENT",
        }),
      })
    );
  });

  it("should not re-send when this message was already answered", async () => {
    mockPrisma.dmLog.findUnique.mockResolvedValue({ status: "SENT" });

    const processor = getProcessor();
    await processor(createMockMessageJob());

    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
  });

  it("should send the link as buttons when the campaign has tracked links", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...dmTriggerAutomation,
        linkButtonLabel: "Get it",
        trackedLinks: [
          {
            slug: "abc123",
            label: "Get it",
            destinationUrl: "https://example.com/offer",
          },
        ],
      },
    ]);

    const processor = getProcessor();
    await processor(createMockMessageJob());

    expect(mockSendDirectMessageWithLinkButton).toHaveBeenCalled();
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
  });

  it("should send the follow prompt instead of the link to a non-follower", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      { ...dmTriggerAutomation, requireFollow: true },
    ]);
    mockGetUserFollowStatus.mockResolvedValue(false);

    const processor = getProcessor();
    await processor(createMockMessageJob());

    expect(mockSendDirectMessageWithButton).toHaveBeenCalledWith(
      META_AUTH,
      "ig_456",
      "commenter_999",
      expect.any(String),
      "I'm following ✅",
      "followcheck:auto_789"
    );
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
  });

  // First contact, so the gate is fail-closed like processComment: an
  // unverifiable status must not hand out the link.
  it("should send the follow prompt when follow status cannot be verified", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      { ...dmTriggerAutomation, requireFollow: true },
    ]);
    mockGetUserFollowStatus.mockResolvedValue(null);

    const processor = getProcessor();
    await processor(createMockMessageJob());

    expect(mockSendDirectMessageWithButton).toHaveBeenCalled();
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
  });

  it("should skip and log when the workspace is over its monthly limit", async () => {
    mockReserveWorkspaceDMSend.mockResolvedValue({
      allowed: false,
      reserved: false,
      remaining: 0,
      limit: 2000,
      periodStart: usagePeriodStart,
    });

    const processor = getProcessor();
    await processor(createMockMessageJob());

    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: "SKIPPED_PLAN_LIMIT" }),
      })
    );
  });

  // An unknown outcome may still have reached the inbox, so the reply is not
  // retried and its reservation is kept, exactly as for a button tap.
  it("keeps the reservation and stops retrying when the send outcome is unknown", async () => {
    mockSendDirectMessage.mockRejectedValue(new Error("Meta is down"));

    const processor = getProcessor();
    await expect(processor(createMockMessageJob())).rejects.toMatchObject({
      name: "UnrecoverableError",
      message: expect.stringContaining("Meta is down"),
    });

    expect(mockReleaseWorkspaceDMReservation).not.toHaveBeenCalled();
    expect(mockPrisma.postbackDelivery.delete).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          status: "FAILED",
          dmDeliveryUnconfirmed: true,
        }),
        update: expect.objectContaining({
          status: "FAILED",
          dmDeliveryUnconfirmed: true,
        }),
      })
    );
  });

  it("releases the reservation and the claim when Instagram refuses the reply", async () => {
    mockSendDirectMessage.mockRejectedValue(
      new MetaApiError(100, undefined, undefined, "Invalid parameter")
    );

    await expect(getProcessor()(createMockMessageJob())).rejects.toMatchObject({
      name: "MetaApiError",
      message: "Invalid parameter",
    });

    expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalledWith(
      "workspace_123",
      usagePeriodStart
    );
    // A confirmed rejection frees the claim, so the retry may send.
    expect(mockPrisma.postbackDelivery.delete).toHaveBeenCalledTimes(1);
    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          status: "FAILED",
          dmDeliveryUnconfirmed: false,
        }),
      })
    );
  });

  it("claims the reply per account, campaign and inbound message before sending", async () => {
    await getProcessor()(createMockMessageJob());

    const operationId = createHash("sha256")
      .update(JSON.stringify(["ig_account_row_1", "dm", "auto_789", "mid_abc"]))
      .digest("hex");
    expect(mockPrisma.postbackDelivery.create).toHaveBeenCalledWith({
      data: { id: operationId },
    });
    expect(
      mockPrisma.postbackDelivery.create.mock.invocationCallOrder[0]
    ).toBeLessThan(mockSendDirectMessage.mock.invocationCallOrder[0]);
  });

  it("sends nothing and releases the reservation when the message is already claimed", async () => {
    mockPrisma.postbackDelivery.create.mockRejectedValue({ code: "P2002" });

    await expect(
      getProcessor()(createMockMessageJob())
    ).resolves.toBeUndefined();

    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockSendDirectMessageWithLinkButton).not.toHaveBeenCalled();
    expect(mockSendDirectMessageWithButton).not.toHaveBeenCalled();
    expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalledWith(
      "workspace_123",
      usagePeriodStart
    );
    expect(mockPrisma.dmLog.upsert).not.toHaveBeenCalled();
  });

  // Nothing is sent before the claim is stored, so a database error on it is
  // retried like any other. It used to pass through the send's error handling
  // and end the job as an unconfirmed delivery: no retry, and a log row that
  // made every later run skip the message.
  it("retries the job without sending when the claim cannot be stored", async () => {
    const lostConnection = new Error("Connection terminated unexpectedly");
    mockPrisma.postbackDelivery.create.mockRejectedValue(lostConnection);

    await expect(getProcessor()(createMockMessageJob())).rejects.toBe(
      lostConnection
    );

    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockSendDirectMessageWithLinkButton).not.toHaveBeenCalled();
    expect(mockSendDirectMessageWithButton).not.toHaveBeenCalled();
    // The retry reserves again, so this attempt's reservation is given back.
    expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalledWith(
      "workspace_123",
      usagePeriodStart
    );
    expect(mockPrisma.postbackDelivery.delete).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.upsert).not.toHaveBeenCalled();
  });

  it("answers the message on the retry after the claim could not be stored", async () => {
    mockPrisma.postbackDelivery.create
      .mockRejectedValueOnce(new Error("Connection terminated unexpectedly"))
      .mockResolvedValue({});

    const process = getProcessor();
    await expect(process(createMockMessageJob())).rejects.toThrow(
      "Connection terminated unexpectedly"
    );
    await process({ ...createMockMessageJob(), attemptsMade: 1 });

    expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledTimes(1);
    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: "SENT" }),
      })
    );
  });

  it("answers a redelivered message only once even when its log row is missing", async () => {
    const claims = new Set<string>();
    mockPrisma.postbackDelivery.create.mockImplementation(
      async ({ data }: { data: { id: string } }) => {
        if (claims.has(data.id)) throw { code: "P2002" };
        claims.add(data.id);
        return data;
      }
    );

    const process = getProcessor();
    await process(createMockMessageJob());
    // dmLog.findUnique still finds nothing, as after a lost log write, and the
    // webhook comes back under a new job id once BullMQ forgot the old one.
    await process({ ...createMockMessageJob(), id: "redelivered-message" });

    expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
  });

  it("schedules the follow-up once the link is out and recorded", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...dmTriggerAutomation,
        followUpEnabled: true,
        followUpMessage: "Thanks, {username}!",
        followUpDelayMinutes: 2,
      },
    ]);

    await getProcessor()(createMockMessageJob());

    expect(mockQueueAdd).toHaveBeenCalledWith(
      "process-followup",
      {
        instagramAccountId: "ig_456",
        accountConnectionId: "ig_account_row_1",
        userId: "commenter_999",
        automationId: "auto_789",
        commenterName: "commenter_user",
      },
      { delay: 2 * 60_000, jobId: "followup_auto_789_commenter_999" }
    );
    expect(mockPrisma.dmLog.upsert.mock.invocationCallOrder[0]).toBeLessThan(
      mockQueueAdd.mock.invocationCallOrder[0]
    );
  });

  it("keeps a delivered reply SENT when the follow-up cannot be scheduled", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...dmTriggerAutomation,
        followUpEnabled: true,
        followUpMessage: "Thanks!",
      },
    ]);
    mockQueueAdd.mockRejectedValue(new Error("Redis connection lost"));

    await expect(
      getProcessor()(createMockMessageJob())
    ).resolves.toBeUndefined();

    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: "SENT" }),
        update: expect.objectContaining({ status: "SENT" }),
      })
    );
    expect(mockPrisma.dmLog.upsert).not.toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ status: "FAILED" }),
      })
    );
    expect(mockReleaseWorkspaceDMReservation).not.toHaveBeenCalled();
  });

  it("schedules no follow-up behind a follow prompt", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...dmTriggerAutomation,
        requireFollow: true,
        followUpEnabled: true,
        followUpMessage: "Thanks!",
      },
    ]);
    mockGetUserFollowStatus.mockResolvedValue(false);

    await getProcessor()(createMockMessageJob());

    expect(mockSendDirectMessageWithButton).toHaveBeenCalledTimes(1);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });
});

describe("DM Worker — the claim of a button tap", () => {
  function tap() {
    return createMockPostbackJob({
      instagramAccountId: "ig_456",
      userId: "commenter_999",
      payload: "reveal:auto_789",
      mid: "mid_tap",
    });
  }

  beforeEach(() => {
    mockPrisma.automation.findMany.mockResolvedValue([]);
    mockPrisma.automation.findFirst.mockResolvedValue(mockAutomation);
  });

  // Nothing is sent before the claim is stored, so a database error on it is
  // retried like any other. Taken inside the send's error handling, it ended
  // the job as an unconfirmed delivery instead: no retry, the tap logged
  // FAILED and unconfirmed, and the link never sent.
  it("retries the tap without sending when its claim cannot be stored", async () => {
    const lostConnection = new Error("Connection terminated unexpectedly");
    mockPrisma.postbackDelivery.create.mockRejectedValue(lostConnection);

    await expect(getProcessor()(tap())).rejects.toBe(lostConnection);

    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockSendDirectMessageWithLinkButton).not.toHaveBeenCalled();
    // The retry reserves again, so this attempt's reservation is given back.
    expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalledWith(
      "workspace_123",
      usagePeriodStart
    );
    expect(mockPrisma.postbackDelivery.delete).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.upsert).not.toHaveBeenCalled();
  });

  it("delivers the link on the retry after the claim could not be stored", async () => {
    mockPrisma.postbackDelivery.create
      .mockRejectedValueOnce(new Error("Connection terminated unexpectedly"))
      .mockResolvedValue({});

    const process = getProcessor();
    await expect(process(tap())).rejects.toThrow(
      "Connection terminated unexpectedly"
    );
    await process({ ...tap(), attemptsMade: 1 });

    expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledTimes(1);
    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: "SENT" }),
      })
    );
  });

  // Instagram refused the link, then the database failed while giving the
  // claim back. A retry would only find the claim, so the tap ends without
  // one, as an unconfirmed delivery; its error names the refusal, not only
  // the database's failure.
  it("ends a refused tap whose claim cannot be given back without a retry, naming the refusal", async () => {
    mockSendDirectMessage.mockRejectedValue(
      new MetaApiError(100, undefined, undefined, "Invalid parameter")
    );
    mockPrisma.postbackDelivery.delete.mockRejectedValue(
      new Error("Connection terminated unexpectedly")
    );

    await expect(getProcessor()(tap())).rejects.toMatchObject({
      name: "UnrecoverableError",
    });

    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          status: "FAILED",
          dmDeliveryUnconfirmed: true,
          errorMessage: expect.stringContaining("MetaApiError 100: Invalid parameter"),
        }),
      })
    );
  });
});

describe("DM Worker — work after a delivered button tap", () => {
  const withFollowUp = {
    ...mockAutomation,
    followUpEnabled: true,
    followUpMessage: "Thanks for grabbing it, {username}!",
    followUpDelayMinutes: 5,
  };

  it("schedules the follow-up once the link is out and recorded", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(withFollowUp);

    await getProcessor()(createMockPostbackJob());

    expect(mockQueueAdd).toHaveBeenCalledWith(
      "process-followup",
      {
        instagramAccountId: "ig_456",
        accountConnectionId: "ig_account_row_1",
        userId: "commenter_999",
        automationId: "auto_789",
        commenterName: "commenter_user",
      },
      { delay: 5 * 60_000, jobId: "followup_auto_789_commenter_999" }
    );
    expect(mockPrisma.dmLog.upsert.mock.invocationCallOrder[0]).toBeLessThan(
      mockQueueAdd.mock.invocationCallOrder[0]
    );
  });

  it("keeps a delivered tap SENT when the follow-up cannot be scheduled", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(withFollowUp);
    mockQueueAdd.mockRejectedValue(new Error("Redis connection lost"));

    await expect(
      getProcessor()(createMockPostbackJob())
    ).resolves.toBeUndefined();

    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: "SENT" }),
        update: expect.objectContaining({ status: "SENT" }),
      })
    );
    expect(mockPrisma.dmLog.upsert).not.toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ status: "FAILED" }),
      })
    );
    expect(mockReleaseWorkspaceDMReservation).not.toHaveBeenCalled();
    // The lost follow-up shows up in Diagnostics instead.
    expect(mockPrisma.operationalEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace_123",
        source: "WORKER",
        level: "WARNING",
        message: "Follow-up not scheduled after a delivered link",
      }),
    });
  });

  it("still schedules the follow-up after a read fallback delivered the link", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(withFollowUp);

    await getProcessor()(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "reveal:auto_789",
        fallback: true,
      })
    );

    expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
    expect(mockQueueAdd).toHaveBeenCalledWith(
      "process-followup",
      expect.objectContaining({ automationId: "auto_789" }),
      expect.objectContaining({ jobId: "followup_auto_789_commenter_999" })
    );
  });

  it("schedules nothing when the tap was already delivered", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(withFollowUp);
    mockPrisma.postbackDelivery.create.mockRejectedValue({ code: "P2002" });

    await getProcessor()(createMockPostbackJob());

    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });
});

describe("DM Worker — job dispatch", () => {
  function prismaCallCount(): number {
    return Object.values(mockPrisma)
      .flatMap((model) => Object.values(model))
      .reduce((total, fn) => total + fn.mock.calls.length, 0);
  }

  // A worker rolled back below a release that added a job type must leave
  // those jobs alone rather than treat them as comments.
  it("ignores a job name it does not know", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(
        getProcessor()({ ...createMockJob(), name: "process-unknown" })
      ).resolves.toBeUndefined();

      expect(prismaCallCount()).toBe(0);
      expect(mockQueueAdd).not.toHaveBeenCalled();
      expect(mockSendPrivateReply).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        "[DM Worker] Ignoring unknown job",
        "process-unknown",
        "job_001"
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("hands a catch-up job to the catch-up of its account, and runs nothing of a comment", async () => {
    mockRunCatchUp.mockResolvedValueOnce("done");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await getProcessor()({
        ...createMockJob({ accountConnectionId: "ig_account_row_1", instagramAccountId: "ig_123" }),
        name: "process-catch-up",
      });
      expect(mockRunCatchUp).toHaveBeenCalledTimes(1);
      expect(mockRunCatchUp).toHaveBeenCalledWith("ig_account_row_1");
      expect(prismaCallCount()).toBe(0);
      expect(mockQueueAdd).not.toHaveBeenCalled();
      expect(mockSendPrivateReply).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it.each([
    { label: "a job without a name", name: undefined },
    { label: "a process-comment job", name: "process-comment" },
  ])("runs $label as a comment", async ({ name }) => {
    await getProcessor()({ ...createMockJob(), name });

    expect(mockPrisma.automation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ postId: "media_101" }, { matchAnyPost: true }],
        }),
      })
    );
    expect(mockSendPrivateReply).toHaveBeenCalledTimes(1);
  });
});

describe("Zernio worker routing", () => {
  it("fails open on unknown follow status and sends once through the selected provider", async () => {
    mockPrisma.zernioConnection.findUnique.mockResolvedValue({
      apiKey: "encrypted_key",
    });
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...mockAutomation,
        requireFollow: true,
        instagramAccount: {
          ...mockAutomation.instagramAccount,
          provider: "ZERNIO",
          workspaceId: "workspace_123",
          zernioAccountId: "zernio_selected",
          accessToken: "",
        },
      },
    ]);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            isFollower: null,
            unavailableReason: "consent_required",
          })
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ messageId: "sent" }))
      );
    vi.stubGlobal("fetch", fetchMock);
    try {
      await getProcessor()(createMockJob());
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1][0]).toContain(
        "/inbox/comments/media_101/comment_555/private-reply"
      );
      expect(JSON.parse(fetchMock.mock.calls[1][1].body).accountId).toBe(
        "zernio_selected"
      );
      expect(mockSendPrivateReply).not.toHaveBeenCalled();
      expect(mockSendPrivateReplyWithButton).not.toHaveBeenCalled();
      expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "SENT" }),
        })
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

it("stops BullMQ retries after an ambiguous Zernio direct-message outcome", async () => {
  mockPrisma.zernioConnection.findUnique.mockResolvedValue({
    apiKey: "encrypted",
  });
  mockPrisma.automation.findFirst.mockResolvedValue({
    ...mockAutomation,
    instagramAccount: {
      ...mockAutomation.instagramAccount,
      provider: "ZERNIO",
      workspaceId: "workspace_123",
      zernioAccountId: "remote",
      accessToken: "",
    },
  });
  const fetchMock = vi.fn().mockRejectedValue(new Error("connection reset"));
  vi.stubGlobal("fetch", fetchMock);
  try {
    await expect(getProcessor()(createMockPostbackJob())).rejects.toMatchObject(
      {
        name: "UnrecoverableError",
        message: expect.stringContaining("Inspect the Instagram inbox"),
      }
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally {
    vi.unstubAllGlobals();
  }
});

it('binds queued comments to the local connection that received them', async () => {
  mockPrisma.automation.findMany.mockResolvedValue([]);
  const job = createMockJob();
  Object.assign(job.data, { accountConnectionId: 'original-connection' });
  await getProcessor()(job);
  expect(mockPrisma.automation.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ instagramAccountId: 'original-connection' }) }));
});

it('never automatically resends a private reply with an unconfirmed delivery', async () => {
  mockPrisma.dmLog.findUnique.mockResolvedValue({ status: 'FAILED', dmDeliveryUnconfirmed: true, publicReplySentAt: null });
  await getProcessor()(createMockJob());
  expect(mockSendPrivateReply).not.toHaveBeenCalled();
  expect(mockSendPrivateReplyWithButton).not.toHaveBeenCalled();
  expect(mockPrisma.dmLog.update).not.toHaveBeenCalled();
});

it('keeps an unconfirmed public reply untouched after the DM was delivered', async () => {
  mockPrisma.automation.findMany.mockResolvedValue([{ ...mockAutomation, publicReplyEnabled: true, publicReplyMessage: 'Thanks!', publicReplyMessages: [] }]);
  mockPrisma.dmLog.findUnique.mockResolvedValue({ status: 'SENT', publicReplyDeliveryUnconfirmed: true, publicReplySentAt: null });
  await getProcessor()(createMockJob());
  expect(mockPrisma.dmLog.update).not.toHaveBeenCalled();
});

describe("durable Zernio postback delivery", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    const claims = new Set<string>();
    mockPrisma.postbackDelivery.create.mockImplementation(
      async ({ data }: { data: { id: string } }) => {
        if (claims.has(data.id)) throw { code: "P2002" };
        claims.add(data.id);
        return data;
      },
    );
    mockPrisma.postbackDelivery.delete.mockImplementation(
      async ({ where }: { where: { id: string } }) => {
        claims.delete(where.id);
      },
    );
    mockPrisma.zernioConnection.findUnique.mockResolvedValue({
      apiKey: "encrypted",
    });
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...mockAutomation,
      instagramAccount: {
        ...mockAutomation.instagramAccount,
        provider: "ZERNIO",
        workspaceId: "workspace_123",
        zernioAccountId: "remote",
        accessToken: "",
      },
    });
    fetchMock = vi.fn();
  });

  function tap(mid: string) {
    return createMockPostbackJob({
      instagramAccountId: "ig_456",
      userId: "commenter_999",
      payload: "reveal:auto_789",
      mid,
    });
  }

  it("retains an uncertain tap across a newer successful tap and queue eviction", async () => {
    fetchMock
      .mockImplementation(
        async () =>
          new Response(JSON.stringify({ data: { messageId: "new-tap" } })),
      )
      .mockRejectedValueOnce(new Error("connection reset"));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const process = getProcessor();
      await expect(process(tap("old"))).rejects.toMatchObject({
        name: "UnrecoverableError",
      });
      await process(tap("new"));
      await process({ ...tap("old"), id: "redelivery-job" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(mockPrisma.postbackDelivery.delete).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("deduplicates successful old taps while permitting each distinct new mid", async () => {
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ data: { messageId: "sent" } })),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const process = getProcessor();
      await process(tap("first"));
      await process(tap("second"));
      await process({ ...tap("first"), id: "after-retention" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("releases a claim on a confirmed rejection so the same tap can retry", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("{}", { status: 429 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { messageId: "sent" } })),
      );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const process = getProcessor();
      await expect(process(tap("retry"))).rejects.toThrow();
      await process(tap("retry"));
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(mockPrisma.postbackDelivery.delete).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("claims concurrent deliveries of the same tap before either can send twice", async () => {
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ data: { messageId: "sent" } })),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const process = getProcessor();
      await Promise.all([
        process(tap("concurrent")),
        process({ ...tap("concurrent"), id: "other-job" }),
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("deduplicates follow-gate prompts as well as reveal messages", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...mockAutomation,
      requireFollow: true,
      instagramAccount: {
        ...mockAutomation.instagramAccount,
        provider: "ZERNIO",
        workspaceId: "workspace_123",
        zernioAccountId: "remote",
        accessToken: "",
      },
    });
    fetchMock.mockImplementation(
      async (_url: string, init: { method: string }) =>
        new Response(
          JSON.stringify(
            init.method === "GET"
              ? { isFollower: false }
              : { data: { messageId: "prompt" } },
          ),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const process = getProcessor();
      const followTap = tap("follow");
      // The prompt goes out on the last delayed re-check — an earlier false
      // only queues the next one — so exercise that pass: that is where the
      // prompt is sent, and where a redelivery must not send it a second time.
      followTap.data = {
        ...followTap.data,
        payload: "followcheck:auto_789",
        followRecheck: true,
        followRecheckAttempt: 2,
      };
      await process(followTap);
      await process({ ...followTap, id: "redelivery" });
      expect(
        fetchMock.mock.calls.filter(([, init]) => init.method === "POST"),
      ).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("DM Worker — follow-gate re-check", () => {
  const gated = { ...mockAutomation, requireFollow: true, trackedLinks: [] };

  it("re-checks a first false follow later instead of rejecting the tap", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(gated);
    mockGetUserFollowStatus.mockResolvedValue(false);

    await getProcessor()(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "followcheck:auto_789",
      })
    );

    // Nothing is sent yet: a brand-new follow may simply not have registered.
    expect(mockSendDirectMessageWithButton).not.toHaveBeenCalled();
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockQueueAdd).toHaveBeenCalledWith(
      "process-postback",
      expect.objectContaining({ followRecheck: true, userId: "commenter_999" }),
      expect.objectContaining({ delay: expect.any(Number) })
    );
  });

  it("prompts and records the rejection when the last re-check still finds no follow", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(gated);
    mockGetUserFollowStatus.mockResolvedValue(false);

    await getProcessor()(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "followcheck:auto_789",
        followRecheck: true,
        followRecheckAttempt: 2,
      })
    );

    expect(mockSendDirectMessageWithButton).toHaveBeenCalledTimes(1);
    expect(mockPrisma.operationalEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          message: "Follow gate rejected a button tap",
        }),
      })
    );
    // A re-check never queues another re-check.
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("buckets the re-check id by time so a later tap is not blocked by an old job", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(gated);
    mockGetUserFollowStatus.mockResolvedValue(false);

    await getProcessor()(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "followcheck:auto_789",
      })
    );

    const [, , opts] = mockQueueAdd.mock.calls[0];
    // A fixed per-user id would collide with the retained completed job of an
    // earlier re-check and be dropped silently by BullMQ.
    expect(opts.jobId).toMatch(/^postback_recheck_auto_789_commenter_999_1_\d+$/);
  });

  it("checks twice: soon after the tap, then again before giving up", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(gated);
    mockGetUserFollowStatus.mockResolvedValue(false);
    const tap = {
      instagramAccountId: "ig_456",
      userId: "commenter_999",
      payload: "followcheck:auto_789",
    };

    await getProcessor()(createMockPostbackJob(tap));
    expect(mockQueueAdd).toHaveBeenLastCalledWith(
      "process-postback",
      expect.objectContaining({ followRecheckAttempt: 1 }),
      expect.objectContaining({ delay: 20_000 })
    );

    await getProcessor()(
      createMockPostbackJob({ ...tap, followRecheck: true, followRecheckAttempt: 1 })
    );
    expect(mockQueueAdd).toHaveBeenLastCalledWith(
      "process-postback",
      expect.objectContaining({ followRecheckAttempt: 2 }),
      expect.objectContaining({ delay: 40_000 })
    );
    // Neither pass has given up yet, so neither re-sends the prompt.
    expect(mockSendDirectMessageWithButton).not.toHaveBeenCalled();
  });

  it("treats a re-check queued before counting existed as the first one done", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(gated);
    mockGetUserFollowStatus.mockResolvedValue(false);

    await getProcessor()(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "followcheck:auto_789",
        followRecheck: true,
      })
    );

    expect(mockQueueAdd).toHaveBeenCalledWith(
      "process-postback",
      expect.objectContaining({ followRecheckAttempt: 2 }),
      expect.anything()
    );
    expect(mockSendDirectMessageWithButton).not.toHaveBeenCalled();
  });

  // A re-check job is queued by the pass before it, so its own timestamp is
  // later than the tap. The tap opened Instagram's messaging window, and the
  // work after a delivered link has to count from it.
  describe("the time of the tap", () => {
    const TAPPED_AT = Date.parse("2026-11-20T09:00:00.000Z");
    const tap = {
      instagramAccountId: "ig_456",
      userId: "commenter_999",
      payload: "followcheck:auto_789",
    };

    it("is carried from the tap through every re-check", async () => {
      mockPrisma.automation.findFirst.mockResolvedValue(gated);
      mockGetUserFollowStatus.mockResolvedValue(false);

      await getProcessor()({
        ...createMockPostbackJob(tap),
        timestamp: TAPPED_AT,
      });
      expect(mockQueueAdd).toHaveBeenLastCalledWith(
        "process-postback",
        expect.objectContaining({ followRecheckAttempt: 1, tappedAt: TAPPED_AT }),
        expect.anything()
      );

      await getProcessor()({
        ...createMockPostbackJob(mockQueueAdd.mock.lastCall?.[1]),
        timestamp: TAPPED_AT + 20_000,
      });
      expect(mockQueueAdd).toHaveBeenLastCalledWith(
        "process-postback",
        expect.objectContaining({ followRecheckAttempt: 2, tappedAt: TAPPED_AT }),
        expect.anything()
      );
    });

    it("is reported for a link a re-check delivers, not the re-check's own time", async () => {
      mockPrisma.automation.findFirst.mockResolvedValue(gated);
      mockGetUserFollowStatus.mockResolvedValue(true);

      await getProcessor()({
        ...createMockPostbackJob({
          ...tap,
          followRecheck: true,
          followRecheckAttempt: 2,
          tappedAt: TAPPED_AT,
        }),
        timestamp: TAPPED_AT + 60_000,
      });

      expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
      expect(afterLinkDelivered).toHaveBeenCalledTimes(1);
      expect(afterLinkDelivered).toHaveBeenCalledWith(
        expect.objectContaining({ via: "tap", interactionAt: TAPPED_AT })
      );
    });

    it("is the job's own time for a tap and for a re-check queued without it", async () => {
      mockPrisma.automation.findFirst.mockResolvedValue(gated);
      mockGetUserFollowStatus.mockResolvedValue(true);

      await getProcessor()({
        ...createMockPostbackJob(tap),
        timestamp: TAPPED_AT,
      });
      await getProcessor()({
        ...createMockPostbackJob({
          ...tap,
          followRecheck: true,
          followRecheckAttempt: 1,
        }),
        timestamp: TAPPED_AT + 20_000,
      });

      const reported = vi
        .mocked(afterLinkDelivered)
        .mock.calls.map(([delivery]) => delivery.interactionAt);
      expect(reported).toEqual([TAPPED_AT, TAPPED_AT + 20_000]);
    });
  });

  it("prompts a non-follower right away when the tap came from the opening DM", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(gated);
    mockGetUserFollowStatus.mockResolvedValue(false);

    await getProcessor()(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "followcheck:auto_789:open",
      })
    );

    // Tapping the opening DM is not a claim to follow, so there is nothing to
    // wait for: the follow prompt goes out now, not after the re-check delay.
    expect(mockSendDirectMessageWithButton).toHaveBeenCalledWith(
      META_AUTH,
      "ig_456",
      "commenter_999",
      expect.any(String),
      expect.any(String),
      "followcheck:auto_789"
    );
    expect(mockQueueAdd).not.toHaveBeenCalled();
    // Nor is it a rejection: they were never told to follow before this.
    expect(mockPrisma.operationalEvent.create).not.toHaveBeenCalled();
  });
});

describe("DM Worker — follow re-check acknowledgement", () => {
  const gated = { ...mockAutomation, requireFollow: true, trackedLinks: [] };
  const tap = {
    instagramAccountId: "ig_456",
    userId: "commenter_999",
    payload: "followcheck:auto_789",
  };
  const mockRedisSet = vi.fn();

  beforeEach(() => {
    process.env.FOLLOW_RECHECK_ACK_MESSAGE = "Dame unos segundos que lo verifico";
    mockRedisSet.mockReset().mockResolvedValue("OK");
    // No account pause (get), and the acknowledgement's own key (set).
    vi.mocked(getRedisConnection).mockReturnValue({
      get: async () => null,
      set: mockRedisSet,
    } as never);
    mockPrisma.automation.findFirst.mockResolvedValue(gated);
    mockGetUserFollowStatus.mockResolvedValue(false);
  });

  afterEach(() => {
    delete process.env.FOLLOW_RECHECK_ACK_MESSAGE;
  });

  it("answers a not-yet-visible follow right away instead of leaving the chat silent", async () => {
    await getProcessor()(createMockPostbackJob(tap));

    expect(mockSendDirectMessage).toHaveBeenCalledWith(
      META_AUTH,
      "ig_456",
      "commenter_999",
      "Dame unos segundos que lo verifico"
    );
    // The re-check is still what decides; the acknowledgement only fills the wait.
    expect(mockQueueAdd).toHaveBeenCalledWith(
      "process-postback",
      expect.objectContaining({ followRecheckAttempt: 1 }),
      expect.anything()
    );
  });

  it("acknowledges a burst of taps only once", async () => {
    mockRedisSet.mockResolvedValueOnce("OK").mockResolvedValueOnce(null);

    await getProcessor()(createMockPostbackJob(tap));
    await getProcessor()(createMockPostbackJob(tap));

    expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
  });

  it("does not acknowledge again on the re-check passes", async () => {
    await getProcessor()(
      createMockPostbackJob({ ...tap, followRecheck: true, followRecheckAttempt: 1 })
    );

    expect(mockSendDirectMessage).not.toHaveBeenCalled();
  });

  it("still re-checks when the acknowledgement cannot be sent", async () => {
    mockSendDirectMessage.mockRejectedValueOnce(new Error("boom"));

    await expect(getProcessor()(createMockPostbackJob(tap))).resolves.toBeUndefined();
    expect(mockQueueAdd).toHaveBeenCalledWith(
      "process-postback",
      expect.objectContaining({ followRecheckAttempt: 1 }),
      expect.anything()
    );
  });

  it("sends nothing extra when no acknowledgement message is configured", async () => {
    delete process.env.FOLLOW_RECHECK_ACK_MESSAGE;

    await getProcessor()(createMockPostbackJob(tap));

    expect(mockSendDirectMessage).not.toHaveBeenCalled();
    expect(mockRedisSet).not.toHaveBeenCalled();
  });
});

describe("ambiguous Meta sends and durable comment claims", () => {
  const withLinks = { ...mockAutomation, trackedLinks: [{ slug: "resource", label: null, destinationUrl: "https://example.com" }] };

  it("never falls back or retries Meta code 1, even though Meta may have sent the message", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([withLinks]);
    mockSendPrivateReplyWithLinkButton.mockRejectedValue(new MetaApiError(1, undefined, undefined, "An unknown error has occurred."));
    await expect(getProcessor()(createMockJob())).rejects.toMatchObject({ name: "UnrecoverableError" });
    expect(mockSendPrivateReplyWithLinkButton).toHaveBeenCalledTimes(1);
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FAILED", dmDeliveryUnconfirmed: true }) }));
    expect(mockReleaseDMSlot).not.toHaveBeenCalled();
    expect(mockReleaseWorkspaceDMReservation).not.toHaveBeenCalled();
  });

  it("retains the fallback's uncertain outcome instead of replacing it with the first rejection", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([withLinks]);
    mockSendPrivateReplyWithLinkButton.mockRejectedValue(new MetaApiError(100, undefined, undefined, "Unsupported message template"));
    mockSendPrivateReply.mockRejectedValue(new Error("Connection reset after send"));
    await expect(getProcessor()(createMockJob())).rejects.toMatchObject({ name: "UnrecoverableError", message: expect.stringContaining("Connection reset after send") });
    expect(mockSendPrivateReply).toHaveBeenCalledTimes(1);
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ dmDeliveryUnconfirmed: true }) }));
  });

  it("blocks the historical code 1 failures before any further network send", async () => {
    mockPrisma.dmLog.findUnique.mockResolvedValue({ status: "FAILED", attempts: 1, errorMessage: "MetaApiError 1: An unknown error has occurred.", dmDeliveryUnconfirmed: false });
    await getProcessor()(createMockJob());
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(expect.objectContaining({ data: { dmDeliveryUnconfirmed: true } }));
  });

  it("cannot reset the lifetime attempt limit by enqueueing a new job", async () => {
    mockPrisma.dmLog.findUnique.mockResolvedValue({ status: "FAILED", attempts: 3, dmDeliveryUnconfirmed: false });
    await getProcessor()({ ...createMockJob(), id: "new-poll-job", attemptsMade: 0 });
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.updateMany).not.toHaveBeenCalled();
  });

  it("allows only the claim winner to send when webhook and polling overlap", async () => {
    let claimed = false;
    mockPrisma.dmLog.updateMany.mockImplementation(async () => {
      if (claimed) return { count: 0 };
      claimed = true;
      return { count: 1 };
    });
    const process = getProcessor();
    await Promise.all([process(createMockJob()), process({ ...createMockJob(), id: "poll-job" })]);
    expect(mockSendPrivateReply).toHaveBeenCalledTimes(1);
  });

  it("keeps the pre-send claim when both success and failure log writes fail", async () => {
    mockPrisma.dmLog.update.mockRejectedValue(new Error("Database unavailable"));
    const process = getProcessor();
    await expect(process(createMockJob())).rejects.toThrow("Database unavailable");
    expect(mockPrisma.dmLog.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ dmDeliveryUnconfirmed: true }) }));
    mockPrisma.dmLog.findUnique.mockResolvedValue({ status: "PENDING", attempts: 1, dmDeliveryUnconfirmed: true });
    await process({ ...createMockJob(), id: "retry-after-db-recovers" });
    expect(mockSendPrivateReply).toHaveBeenCalledTimes(1);
    expect(mockReleaseWorkspaceDMReservation).not.toHaveBeenCalled();
  });

  it("does not send at all when storing the claim fails", async () => {
    mockPrisma.dmLog.updateMany.mockRejectedValue(new Error("Database unavailable"));
    await expect(getProcessor()(createMockJob())).rejects.toThrow("Database unavailable");
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
  });
});

it("deduplicates a redelivered Meta button tap after queue retention expires", async () => {
  const claims = new Set<string>();
  mockPrisma.postbackDelivery.create.mockImplementation(async ({ data }: { data: { id: string } }) => {
    if (claims.has(data.id)) throw { code: "P2002" };
    claims.add(data.id);
    return data;
  });
  mockPrisma.automation.findFirst.mockResolvedValue(mockAutomation);
  const data = { instagramAccountId: "ig_456", userId: "commenter_999", payload: "reveal:auto_789", mid: "same-meta-tap" };
  const process = getProcessor();
  await process(createMockPostbackJob(data));
  await process({ ...createMockPostbackJob(data), id: "redelivered-after-eviction" });
  expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
});

it("retains the public reply claim if sending succeeded but its log write failed", async () => {
  const { sendCommentReply } = await import("@/lib/meta/client");
  vi.mocked(sendCommentReply).mockResolvedValue({ id: "public-reply" });
  mockPrisma.automation.findMany.mockResolvedValue([{ ...mockAutomation, publicReplyEnabled: true, publicReplyMessages: ["Sent!"] }]);
  // Fail only the public reply's own log write, whichever write comes first.
  let failed = false;
  mockPrisma.dmLog.update.mockImplementation(async (args: { data?: Record<string, unknown> }) => {
    if (!failed && args.data?.publicReplySentAt) {
      failed = true;
      throw new Error("Lost database connection after public send");
    }
    return {};
  });
  const process = getProcessor();
  await process(createMockJob());
  expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ publicReplyDeliveryUnconfirmed: true }) }));
  mockPrisma.dmLog.findUnique.mockResolvedValue({ status: "SENT", publicReplyDeliveryUnconfirmed: true });
  await process({ ...createMockJob(), id: "next-poll" });
  expect(sendCommentReply).toHaveBeenCalledTimes(1);
  expect(mockSendPrivateReply).toHaveBeenCalledTimes(1);
});

// The public reply ("check your DMs") is posted after the DM leg, and only when
// the DM went out, so it never promises a message that Meta refused.
describe("DM Worker — public reply after the DM", () => {
  const withPublicReply = {
    ...mockAutomation,
    publicReplyEnabled: true,
    publicReplyMessages: ["Check your DMs"],
  };

  it("posts the public reply only after the DM went out", async () => {
    const { sendCommentReply } = await import("@/lib/meta/client");
    vi.mocked(sendCommentReply).mockResolvedValue({ id: "public-reply" });
    mockPrisma.automation.findMany.mockResolvedValue([withPublicReply]);

    await getProcessor()(createMockJob());

    expect(mockSendPrivateReply).toHaveBeenCalledTimes(1);
    expect(sendCommentReply).toHaveBeenCalledTimes(1);
    expect(mockSendPrivateReply.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(sendCommentReply).mock.invocationCallOrder[0]
    );
  });

  it("posts the follow-gate prompt before the public reply", async () => {
    const { sendCommentReply } = await import("@/lib/meta/client");
    vi.mocked(sendCommentReply).mockResolvedValue({ id: "public-reply" });
    mockGetUserFollowStatus.mockResolvedValue(null);
    mockPrisma.automation.findMany.mockResolvedValue([
      { ...withPublicReply, requireFollow: true },
    ]);

    await getProcessor()(createMockJob());

    expect(mockSendPrivateReplyWithButton).toHaveBeenCalledTimes(1);
    expect(mockSendPrivateReplyWithButton.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(sendCommentReply).mock.invocationCallOrder[0]
    );
  });

  it("does not post the public reply when Meta refuses the DM", async () => {
    const { sendCommentReply, MetaApiError } = await import("@/lib/meta/client");
    mockPrisma.automation.findMany.mockResolvedValue([withPublicReply]);
    mockSendPrivateReply.mockRejectedValue(
      new MetaApiError(100, 2534025, undefined, "The comment is invalid for a private reply")
    );

    await expect(getProcessor()(createMockJob())).rejects.toThrow(
      "The comment is invalid for a private reply"
    );
    expect(sendCommentReply).not.toHaveBeenCalled();
  });

  it("posts a missing public reply on a later pass once the DM went out", async () => {
    const { sendCommentReply } = await import("@/lib/meta/client");
    vi.mocked(sendCommentReply).mockResolvedValue({ id: "public-reply" });
    mockPrisma.automation.findMany.mockResolvedValue([withPublicReply]);
    mockPrisma.dmLog.findUnique.mockResolvedValue({
      status: "SENT",
      publicReplySentAt: null,
      publicReplyDeliveryUnconfirmed: false,
    });

    await getProcessor()(createMockJob());

    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(sendCommentReply).toHaveBeenCalledTimes(1);
  });

  it("does not post the public reply on a later pass after the DM failed for good", async () => {
    const { sendCommentReply } = await import("@/lib/meta/client");
    mockPrisma.automation.findMany.mockResolvedValue([withPublicReply]);
    mockPrisma.dmLog.findUnique.mockResolvedValue({
      status: "FAILED",
      attempts: 3,
      publicReplySentAt: null,
      publicReplyDeliveryUnconfirmed: false,
    });

    await getProcessor()(createMockJob());

    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(sendCommentReply).not.toHaveBeenCalled();
  });
});

// ─── Contacts, tags, questions, overlapping campaigns, second follow request ───

const TAP_TIME = Date.parse("2026-11-20T10:00:00.000Z");

const dmTriggerCampaign = {
  ...mockAutomation,
  dmTriggerEnabled: true,
  requireFollow: false,
  followPromptMessage: null,
  followPromptButtonLabel: null,
};

function inboundDmJob(data: Record<string, unknown> = {}) {
  return {
    name: "process-message",
    data: {
      instagramAccountId: "ig_456",
      messageId: "mid_abc",
      messageText: "can I get the LINK",
      senderId: "commenter_999",
      ...data,
    },
    id: "message_job_001",
    attemptsMade: 0,
    timestamp: TAP_TIME,
  };
}

const CONTACT_KEY = {
  instagramAccountId_igsid: {
    instagramAccountId: "ig_account_row_1",
    igsid: "commenter_999",
  },
};

describe("DM Worker — contacts", () => {
  it("records a keyword commenter as a contact without an interaction time", async () => {
    await getProcessor()(createMockJob());

    expect(mockPrisma.contact.upsert).toHaveBeenCalledTimes(1);
    const [args] = mockPrisma.contact.upsert.mock.calls[0];
    expect(args.where).toEqual(CONTACT_KEY);
    expect(args.create).toEqual({
      workspaceId: "workspace_123",
      instagramAccountId: "ig_account_row_1",
      igsid: "commenter_999",
      username: "commenter_user",
      recipientHash: hashRecipientId("commenter_999"),
      lastInteractionAt: null,
    });
    expect(args.update).not.toHaveProperty("lastInteractionAt");
    // A comment opens no messaging window, so nothing moves the time either.
    expect(mockPrisma.contact.updateMany).not.toHaveBeenCalled();
    expect(mockSendPrivateReply).toHaveBeenCalledTimes(1);
  });

  it("records the commenter once per comment, however many campaigns match", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      mockAutomation,
      { ...mockAutomation, id: "auto_other", postId: null, matchAnyPost: true },
    ]);

    await getProcessor()(createMockJob());

    expect(mockPrisma.contact.upsert).toHaveBeenCalledTimes(1);
  });

  it("stamps a button tap with the time of the tap", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(mockAutomation);

    await getProcessor()({ ...createMockPostbackJob(), timestamp: TAP_TIME });

    expect(mockPrisma.contact.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: CONTACT_KEY,
        create: expect.objectContaining({
          username: "commenter_user",
          lastInteractionAt: new Date(TAP_TIME),
        }),
      })
    );
    // The stored contact had no interaction yet, so the tap moves it forward.
    expect(mockPrisma.contact.updateMany).toHaveBeenCalledWith({
      where: {
        id: "contact_1",
        OR: [
          { lastInteractionAt: null },
          { lastInteractionAt: { lt: new Date(TAP_TIME) } },
        ],
      },
      data: { lastInteractionAt: new Date(TAP_TIME) },
    });
    expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: "a read fallback",
      data: { payload: "reveal:auto_789", fallback: true },
    },
    {
      label: "a follow re-check",
      data: {
        payload: "followcheck:auto_789",
        followRecheck: true,
        followRecheckAttempt: 1,
      },
    },
  ])("does not count $label as an interaction", async ({ data }) => {
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...mockAutomation,
      requireFollow: true,
    });
    mockGetUserFollowStatus.mockResolvedValue(true);

    await getProcessor()({
      ...createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        ...data,
      }),
      timestamp: TAP_TIME,
    });

    expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
    expect(mockPrisma.contact.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: CONTACT_KEY,
        create: expect.objectContaining({ lastInteractionAt: null }),
      })
    );
    expect(mockPrisma.contact.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "a DM a campaign answers",
      setup: () => mockPrisma.automation.findMany.mockResolvedValue([dmTriggerCampaign]),
    },
    {
      label: "a DM that matches no keyword",
      setup: () => {
        mockPrisma.automation.findMany.mockResolvedValue([dmTriggerCampaign]);
        mockMatchKeywords.mockReturnValue({ matched: false, matchedKeyword: null });
      },
    },
    {
      label: "a DM to an account without DM-trigger campaigns",
      setup: () => {
        mockPrisma.automation.findMany.mockResolvedValue([]);
        mockPrisma.instagramAccount.findUnique.mockResolvedValue({
          id: "ig_account_row_1",
          workspaceId: "workspace_123",
        });
      },
    },
  ])("records the sender of $label, stamped with its time", async ({ setup }) => {
    setup();

    await getProcessor()(inboundDmJob());

    expect(mockPrisma.contact.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: CONTACT_KEY,
        create: expect.objectContaining({
          workspaceId: "workspace_123",
          lastInteractionAt: new Date(TAP_TIME),
        }),
      })
    );
  });

  it("looks the account up by its Instagram id when no campaign names it", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);
    mockPrisma.instagramAccount.findUnique.mockResolvedValue({
      id: "ig_account_row_1",
      workspaceId: "workspace_123",
    });

    await getProcessor()(inboundDmJob());

    expect(mockPrisma.instagramAccount.findUnique).toHaveBeenCalledWith({
      where: { instagramId: "ig_456" },
      select: { id: true, workspaceId: true },
    });
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
  });

  it("does not credit a DM to a connection that replaced the one it came in on", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([]);
    mockPrisma.instagramAccount.findUnique.mockResolvedValue({
      id: "ig_account_row_2",
      workspaceId: "workspace_123",
    });

    await getProcessor()(
      inboundDmJob({ accountConnectionId: "ig_account_row_1" })
    );

    expect(mockPrisma.contact.upsert).not.toHaveBeenCalled();
  });

  describe("when the contact cannot be recorded", () => {
    let consoleError: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      mockPrisma.contact.upsert.mockRejectedValue(new Error("Database unavailable"));
    });
    afterEach(() => consoleError.mockRestore());

    it("still sends the comment's DM", async () => {
      await expect(getProcessor()(createMockJob())).resolves.toBeUndefined();

      expect(mockSendPrivateReply).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledWith(
        "[Contacts] Failed to record a contact:",
        "Database unavailable"
      );
    });

    it("still delivers the link after a tap", async () => {
      mockPrisma.automation.findFirst.mockResolvedValue(mockAutomation);

      await expect(
        getProcessor()(createMockPostbackJob())
      ).resolves.toBeUndefined();

      expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
      expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ status: "SENT" }),
        })
      );
    });

    it("still answers a DM", async () => {
      mockPrisma.automation.findMany.mockResolvedValue([dmTriggerCampaign]);

      await expect(getProcessor()(inboundDmJob())).resolves.toBeUndefined();

      expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
    });

    it("still handles a DM when the account lookup fails", async () => {
      mockPrisma.automation.findMany.mockResolvedValue([]);
      mockPrisma.instagramAccount.findUnique.mockRejectedValue(
        new Error("Connection reset")
      );

      await expect(getProcessor()(inboundDmJob())).resolves.toBeUndefined();
      expect(mockPrisma.contact.upsert).not.toHaveBeenCalled();
    });
  });

  it("keeps a name found for a DM sender whose contact has none", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([dmTriggerCampaign]);
    mockPrisma.contact.upsert.mockResolvedValue({
      id: "contact_1",
      username: null,
      lastInteractionAt: null,
    });

    await getProcessor()(inboundDmJob());

    expect(mockPrisma.contact.updateMany).toHaveBeenCalledWith({
      where: { id: "contact_1" },
      data: { username: "commenter_user" },
    });
    expect(mockSendDirectMessage).toHaveBeenCalledWith(
      META_AUTH,
      "ig_456",
      "commenter_999",
      "Hey commenter_user! Here is the link: https://example.com"
    );
  });

  it("does not rewrite a name the contact already has", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([dmTriggerCampaign]);
    mockPrisma.contact.findUnique.mockResolvedValue({ username: "commenter_user" });

    await getProcessor()(inboundDmJob());

    expect(mockPrisma.contact.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { username: expect.anything() } })
    );
  });

  it("greets a tapper with the name stored on the contact", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(mockAutomation);
    mockPrisma.contact.findUnique.mockResolvedValue({ username: "stored_handle" });

    await getProcessor()(createMockPostbackJob());

    expect(mockPrisma.contact.findUnique).toHaveBeenCalledWith({
      where: { ...CONTACT_KEY, workspaceId: "workspace_123" },
      select: { username: true },
    });
    // The contact answered, so the DM log is not searched.
    expect(mockPrisma.dmLog.findFirst).not.toHaveBeenCalled();
    expect(mockSendDirectMessage).toHaveBeenCalledWith(
      META_AUTH,
      "ig_456",
      "commenter_999",
      "Hey stored_handle! Here is the link: https://example.com"
    );
  });
});

describe("DM Worker — delivery tag", () => {
  const tagged = { ...mockAutomation, deliveryTag: "  [LM] Guide sent " };
  const TAG_WRITE = {
    data: [
      {
        workspaceId: "workspace_123",
        contactId: "contact_1",
        tag: "[LM] Guide sent",
      },
    ],
    skipDuplicates: true,
  };

  it("tags the contact once a link private reply is recorded SENT", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([tagged]);

    await getProcessor()(createMockJob());

    expect(mockPrisma.contactTag.createMany).toHaveBeenCalledWith(TAG_WRITE);
    // The contact recorded for the comment is reused, not written again.
    expect(mockPrisma.contact.upsert).toHaveBeenCalledTimes(1);
    const sentWrite = mockPrisma.dmLog.update.mock.calls.findIndex(
      ([args]) => args.data?.status === "SENT"
    );
    expect(sentWrite).toBeGreaterThanOrEqual(0);
    expect(
      mockPrisma.dmLog.update.mock.invocationCallOrder[sentWrite]
    ).toBeLessThan(mockPrisma.contactTag.createMany.mock.invocationCallOrder[0]);
  });

  it.each([
    { label: "a button tap", fallback: false },
    { label: "a read fallback", fallback: true },
  ])("tags the contact after $label delivered the link", async ({ fallback }) => {
    mockPrisma.automation.findFirst.mockResolvedValue(tagged);

    await getProcessor()(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "reveal:auto_789",
        fallback,
      })
    );

    expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
    expect(mockPrisma.contactTag.createMany).toHaveBeenCalledWith(TAG_WRITE);
    expect(mockPrisma.contact.upsert).toHaveBeenCalledTimes(1);
  });

  it("tags the contact after a DM keyword trigger delivered the link", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      { ...dmTriggerCampaign, deliveryTag: "[LM] Guide sent" },
    ]);

    await getProcessor()(inboundDmJob());

    expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
    expect(mockPrisma.contactTag.createMany).toHaveBeenCalledWith(TAG_WRITE);
    expect(mockPrisma.contact.upsert).toHaveBeenCalledTimes(1);
  });

  it("does not tag after an opening DM", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...tagged,
        openingDmEnabled: true,
        openingDmMessage: "Want the guide?",
        openingDmButtonLabel: "Yes please",
      },
    ]);

    await getProcessor()(createMockJob());

    expect(mockSendPrivateReplyWithButton).toHaveBeenCalledTimes(1);
    expect(mockPrisma.contactTag.createMany).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "the comment's private reply",
      run: async () => {
        mockPrisma.automation.findMany.mockResolvedValue([
          { ...tagged, requireFollow: true },
        ]);
        await getProcessor()(createMockJob());
      },
    },
    {
      label: "a DM",
      run: async () => {
        mockPrisma.automation.findMany.mockResolvedValue([
          { ...dmTriggerCampaign, deliveryTag: "[LM] Guide sent", requireFollow: true },
        ]);
        await getProcessor()(inboundDmJob());
      },
    },
    {
      label: "a tap on the opening DM",
      run: async () => {
        mockPrisma.automation.findFirst.mockResolvedValue({
          ...tagged,
          requireFollow: true,
        });
        await getProcessor()(
          createMockPostbackJob({
            instagramAccountId: "ig_456",
            userId: "commenter_999",
            payload: "followcheck:auto_789:open",
          })
        );
      },
    },
  ])("does not tag after a follow prompt sent as $label", async ({ run }) => {
    mockGetUserFollowStatus.mockResolvedValue(false);

    await run();

    expect(
      mockSendPrivateReplyWithButton.mock.calls.length +
        mockSendDirectMessageWithButton.mock.calls.length
    ).toBe(1);
    expect(mockPrisma.contactTag.createMany).not.toHaveBeenCalled();
  });

  it.each([null, "   "])(
    "writes no tag when the delivery tag is %j",
    async (deliveryTag) => {
      mockPrisma.automation.findFirst.mockResolvedValue({
        ...mockAutomation,
        deliveryTag,
      });

      await getProcessor()(createMockPostbackJob());

      expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
      expect(mockPrisma.contactTag.createMany).not.toHaveBeenCalled();
    }
  );

  it("records the contact for the tag when the tap's own write failed", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mockPrisma.automation.findFirst.mockResolvedValue(tagged);
      mockPrisma.contact.upsert.mockRejectedValueOnce(new Error("Connection reset"));

      await getProcessor()({ ...createMockPostbackJob(), timestamp: TAP_TIME });

      expect(mockPrisma.contact.upsert).toHaveBeenCalledTimes(2);
      expect(mockPrisma.contactTag.createMany).toHaveBeenCalledWith(TAG_WRITE);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("keeps a delivered link SENT when the tag cannot be written", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mockPrisma.automation.findFirst.mockResolvedValue(tagged);
      mockPrisma.contactTag.createMany.mockRejectedValue(
        new Error("Database unavailable")
      );

      await expect(
        getProcessor()(createMockPostbackJob())
      ).resolves.toBeUndefined();

      expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ status: "SENT" }),
        })
      );
      expect(mockPrisma.dmLog.upsert).not.toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({ status: "FAILED" }),
        })
      );
      expect(mockReleaseWorkspaceDMReservation).not.toHaveBeenCalled();
      expect(mockPrisma.operationalEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          workspaceId: "workspace_123",
          source: "WORKER",
          level: "WARNING",
          message: "Delivery tag not added after a delivered link",
        }),
      });
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("DM Worker — question comments", () => {
  const leavesQuestions = { ...mockAutomation, ignoreQuestionComments: true };

  it.each(["Does the LINK work?", "LINK？", "¿Me mandas el LINK", "LINK؟"])(
    "leaves %j to a human when the campaign says so",
    async (commentText) => {
      mockPrisma.automation.findMany.mockResolvedValue([leavesQuestions]);

      await getProcessor()(createMockJob({ ...mockJobData, commentText }));

      expect(mockMatchKeywords).not.toHaveBeenCalled();
      expect(mockPrisma.dmLog.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.dmLog.upsert).not.toHaveBeenCalled();
      expect(mockPrisma.dmLog.update).not.toHaveBeenCalled();
      expect(mockPrisma.contact.upsert).not.toHaveBeenCalled();
      expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
      expect(mockSendPrivateReply).not.toHaveBeenCalled();
    }
  );

  it("answers the same question when the campaign takes questions", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      { ...mockAutomation, ignoreQuestionComments: false },
    ]);

    await getProcessor()(
      createMockJob({ ...mockJobData, commentText: "Does the LINK work?" })
    );

    expect(mockSendPrivateReply).toHaveBeenCalledTimes(1);
  });

  it("answers a request without a question mark", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([leavesQuestions]);

    await getProcessor()(createMockJob());

    expect(mockSendPrivateReply).toHaveBeenCalledTimes(1);
  });
});

describe("DM Worker — campaigns that match the same comment", () => {
  const anyPost = {
    ...mockAutomation,
    id: "auto_any",
    name: "Any post",
    postId: null,
    matchAnyPost: true,
    publicReplyEnabled: true,
    publicReplyMessages: ["Any-post reply"],
  };
  const thisPost = {
    ...mockAutomation,
    id: "auto_post",
    name: "This post",
    publicReplyEnabled: true,
    publicReplyMessages: ["This-post reply"],
  };

  // The DmLog rows as the worker sees them: once a campaign has SENT, the
  // comment's private reply is taken for every other campaign.
  function trackSentRows() {
    const sent = new Map<string, string>();
    const names: Record<string, string> = {
      auto_any: anyPost.name,
      auto_post: thisPost.name,
    };
    mockPrisma.dmLog.update.mockImplementation(
      async (args: {
        where: { automationId_commentId: { automationId: string } };
        data: { status?: string };
      }) => {
        const id = args.where.automationId_commentId.automationId;
        if (args.data.status === "SENT") sent.set(id, names[id]);
        return {};
      }
    );
    mockPrisma.dmLog.findFirst.mockImplementation(
      async (args: {
        where?: { status?: string; automationId?: { not: string } };
      } = {}) => {
        if (args.where?.status !== "SENT") {
          return { commenterName: "commenter_user" };
        }
        const other = [...sent].find(
          ([id]) => id !== args.where?.automationId?.not
        );
        return other ? { automation: { name: other[1] } } : null;
      }
    );
  }

  beforeEach(async () => {
    const { sendCommentReply } = await import("@/lib/meta/client");
    vi.mocked(sendCommentReply).mockResolvedValue({ id: "public-reply" });
    trackSentRows();
  });

  it("lets the campaign bound to the post answer before an older any-post campaign", async () => {
    const { sendCommentReply } = await import("@/lib/meta/client");
    // Oldest first, as the query returns them: the any-post campaign leads.
    mockPrisma.automation.findMany.mockResolvedValue([anyPost, thisPost]);

    await getProcessor()(createMockJob());

    expect(mockSendPrivateReply).toHaveBeenCalledTimes(1);
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith({
      where: {
        automationId_commentId: {
          automationId: "auto_post",
          commentId: "comment_555",
        },
      },
      data: expect.objectContaining({ status: "SENT" }),
    });
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith({
      where: {
        automationId_commentId: {
          automationId: "auto_any",
          commentId: "comment_555",
        },
      },
      data: expect.objectContaining({
        status: "SKIPPED_DEDUP",
        errorMessage: expect.stringContaining("This post"),
      }),
    });
    // Only the campaign that sent the DM answers in public.
    expect(sendCommentReply).toHaveBeenCalledTimes(1);
    expect(sendCommentReply).toHaveBeenCalledWith(
      META_AUTH,
      "comment_555",
      "This-post reply"
    );
  });

  it("also ranks a post-bound campaign first on a comment left on its ad", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([anyPost, thisPost]);

    await getProcessor()(
      createMockJob({
        ...mockJobData,
        mediaId: "ad_media_999",
        originalMediaId: "media_101",
      })
    );

    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          automationId_commentId: {
            automationId: "auto_any",
            commentId: "comment_555",
          },
        },
        data: expect.objectContaining({ status: "SKIPPED_DEDUP" }),
      })
    );
  });

  it("does nothing more for a campaign whose comment was already deduped", async () => {
    const { sendCommentReply } = await import("@/lib/meta/client");
    mockPrisma.automation.findMany.mockResolvedValue([anyPost]);
    mockPrisma.dmLog.findUnique.mockResolvedValue({
      status: "SKIPPED_DEDUP",
      attempts: 0,
      dmDeliveryUnconfirmed: false,
      publicReplySentAt: null,
      publicReplyDeliveryUnconfirmed: false,
    });

    await getProcessor()(createMockJob());

    expect(mockPrisma.dmLog.update).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.upsert).not.toHaveBeenCalled();
    expect(mockPrisma.dmLog.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.contact.upsert).not.toHaveBeenCalled();
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(sendCommentReply).not.toHaveBeenCalled();
  });
});

describe("DM Worker — second follow request", () => {
  const gated = {
    ...mockAutomation,
    requireFollow: true,
    trackedLinks: [],
    followPromptMessage: "Follow me first, {username}",
    followPromptButtonLabel: "Done 👍",
    followPromptRetryMessage: "I can't see your follow yet, {username}",
    followPromptRetryButtonLabel: "Done now",
  };
  const lastRecheck = {
    instagramAccountId: "ig_456",
    userId: "commenter_999",
    payload: "followcheck:auto_789",
    followRecheck: true,
    followRecheckAttempt: 2,
  };

  beforeEach(() => {
    mockGetUserFollowStatus.mockResolvedValue(false);
  });

  it("asks again with its own text and label and a retry button", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(gated);

    await getProcessor()(createMockPostbackJob(lastRecheck));

    expect(mockSendDirectMessageWithButton).toHaveBeenCalledWith(
      META_AUTH,
      "ig_456",
      "commenter_999",
      "I can't see your follow yet, commenter_user",
      "Done now",
      "followcheck:auto_789:retry"
    );
  });

  it.each([null, ""])(
    "falls back to the first request's text and label when the second's are %j",
    async (empty) => {
      mockPrisma.automation.findFirst.mockResolvedValue({
        ...gated,
        followPromptRetryMessage: empty,
        followPromptRetryButtonLabel: empty,
      });

      await getProcessor()(createMockPostbackJob(lastRecheck));

      expect(mockSendDirectMessageWithButton).toHaveBeenCalledWith(
        META_AUTH,
        "ig_456",
        "commenter_999",
        "Follow me first, commenter_user",
        "Done 👍",
        "followcheck:auto_789:retry"
      );
    }
  );

  it("sends the first request, without the retry marker, after an opening-DM tap", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(gated);

    await getProcessor()(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "followcheck:auto_789:open",
      })
    );

    expect(mockSendDirectMessageWithButton).toHaveBeenCalledWith(
      META_AUTH,
      "ig_456",
      "commenter_999",
      "Follow me first, commenter_user",
      "Done 👍",
      "followcheck:auto_789"
    );
  });

  it("delivers the link on a tap on the second request without checking again", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(gated);

    await getProcessor()(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "followcheck:auto_789:retry",
      })
    );

    expect(mockGetUserFollowStatus).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(mockSendDirectMessageWithButton).not.toHaveBeenCalled();
    expect(mockSendDirectMessage).toHaveBeenCalledWith(
      META_AUTH,
      "ig_456",
      "commenter_999",
      "Hey commenter_user! Here is the link: https://example.com"
    );
    expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ status: "SENT" }),
      })
    );
    expect(mockPrisma.operationalEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: "workspace_123",
        source: "WORKER",
        level: "INFO",
        message: "Follow gate skipped after the second follow request",
        payload: expect.objectContaining({
          automationId: "auto_789",
          userId: "commenter_999",
        }),
      }),
    });
  });

  it("writes no gate event for a retry tap on a campaign without the gate", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...gated,
      requireFollow: false,
    });

    await getProcessor()(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "followcheck:auto_789:retry",
      })
    );

    expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
    expect(mockPrisma.operationalEvent.create).not.toHaveBeenCalled();
  });
});

// ─── Lead-magnet offers after a delivered link (Weg 2) ─────────────────────

describe("DM Worker — offers after a delivered link", () => {
  const withOffers = { ...mockAutomation, offersEnabled: true };
  const START_EVENT = "Offer skipped: the link was not delivered after a tap or DM";

  // The job that starts the offer for one trigger. Its id follows the start
  // key, so a repeat of the trigger is dropped while the first start waits.
  function startAdd(startKey: string, interactionAt: number) {
    const digest = createHash("sha256").update(startKey).digest("hex");
    return [
      "process-offer",
      {
        phase: "start",
        workspaceId: "workspace_123",
        accountConnectionId: "ig_account_row_1",
        instagramAccountId: "ig_456",
        automationId: "auto_789",
        userId: "commenter_999",
        interactionAt,
        startKey,
      },
      {
        jobId: `offerstart_auto_789_commenter_999_${digest}`,
        removeOnComplete: true,
      },
    ];
  }

  const offerAdds = () =>
    mockQueueAdd.mock.calls.filter(([name]) => name === "process-offer");

  // A tap on the opening DM's button, as the webhook queues it.
  function tap(mid: string, time = TAP_TIME) {
    return {
      ...createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "reveal:auto_789:open",
        mid,
      }),
      id: `postback_ig_456_commenter_999_${mid}`,
      timestamp: time,
    };
  }

  // Link claims that behave like the PostbackDelivery table.
  function durableClaims() {
    const claims = new Set<string>();
    mockPrisma.postbackDelivery.create.mockImplementation(
      async ({ data }: { data: { id: string } }) => {
        if (claims.has(data.id)) throw { code: "P2002" };
        claims.add(data.id);
        return data;
      }
    );
  }

  it("starts an offer once a tap delivered the link and it is recorded", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(withOffers);

    await getProcessor()(tap("mid_tap_1"));

    expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
    expect(offerAdds()).toEqual([startAdd("auto_789:tap:mid_tap_1", TAP_TIME)]);
    expect(mockPrisma.dmLog.upsert.mock.invocationCallOrder[0]).toBeLessThan(
      mockQueueAdd.mock.invocationCallOrder[0]
    );
    expect(mockPrisma.operationalEvent.create).not.toHaveBeenCalled();
  });

  // The user's decision D1: like ManyChat, every new trigger of a campaign
  // sends the link again and starts the next offer; a repeat of the same
  // trigger starts nothing.
  it("starts another offer for a new tap, none for the same tap redelivered", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(withOffers);
    durableClaims();
    const process = getProcessor();

    await process(tap("mid_tap_1"));
    // The webhook again, once BullMQ no longer remembers the first job.
    await process({ ...tap("mid_tap_1"), id: "postback_redelivered" });
    // A tap on the next comment's opening DM.
    await process(tap("mid_tap_2", TAP_TIME + 60_000));

    expect(mockSendDirectMessage).toHaveBeenCalledTimes(2);
    expect(offerAdds()).toEqual([
      startAdd("auto_789:tap:mid_tap_1", TAP_TIME),
      startAdd("auto_789:tap:mid_tap_2", TAP_TIME + 60_000),
    ]);
  });

  it("keys a link a follow re-check delivers on the tap it repeats", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue({
      ...withOffers,
      requireFollow: true,
    });
    mockGetUserFollowStatus.mockResolvedValue(true);

    await getProcessor()({
      ...createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "followcheck:auto_789",
        mid: "mid_tap_1",
        followRecheck: true,
        followRecheckAttempt: 1,
        tappedAt: TAP_TIME,
      }),
      id: "postback_recheck_auto_789_commenter_999_1_88",
      timestamp: TAP_TIME + 20_000,
    });

    expect(offerAdds()).toEqual([startAdd("auto_789:tap:mid_tap_1", TAP_TIME)]);
  });

  it("starts an offer for every new DM that brings the link, once per DM", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      { ...dmTriggerCampaign, offersEnabled: true },
    ]);
    durableClaims();
    const process = getProcessor();

    await process(inboundDmJob());
    await process({ ...inboundDmJob(), id: "message_redelivered" });
    await process({
      ...inboundDmJob({ messageId: "mid_def" }),
      timestamp: TAP_TIME + 60_000,
    });

    expect(mockSendDirectMessage).toHaveBeenCalledTimes(2);
    expect(offerAdds()).toEqual([
      startAdd("auto_789:dm:mid_abc", TAP_TIME),
      startAdd("auto_789:dm:mid_def", TAP_TIME + 60_000),
    ]);
  });

  it("skips the offer and says why after a read fallback delivered the link", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(withOffers);

    await getProcessor()(
      createMockPostbackJob({
        instagramAccountId: "ig_456",
        userId: "commenter_999",
        payload: "reveal:auto_789",
        fallback: true,
      })
    );

    expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
    expect(offerAdds()).toEqual([]);
    expect(mockPrisma.operationalEvent.create).toHaveBeenCalledWith({
      data: {
        workspaceId: "workspace_123",
        source: "WORKER",
        level: "INFO",
        message: START_EVENT,
        payload: {
          automationId: "auto_789",
          userId: "commenter_999",
          via: "read-fallback",
        },
      },
    });
  });

  it("skips the offer and says why after a link private reply", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([withOffers]);

    await getProcessor()(createMockJob());

    expect(mockSendPrivateReply).toHaveBeenCalledTimes(1);
    expect(offerAdds()).toEqual([]);
    expect(mockPrisma.operationalEvent.create).toHaveBeenCalledWith({
      data: {
        workspaceId: "workspace_123",
        source: "WORKER",
        level: "INFO",
        message: START_EVENT,
        payload: {
          automationId: "auto_789",
          userId: "commenter_999",
          via: "private-reply",
        },
      },
    });
  });

  it("starts nothing after an opening DM, which carries no link", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      {
        ...withOffers,
        openingDmEnabled: true,
        openingDmMessage: "Want the guide?",
        openingDmButtonLabel: "Yes please",
      },
    ]);

    await getProcessor()(createMockJob());

    expect(mockSendPrivateReplyWithButton).toHaveBeenCalledTimes(1);
    expect(offerAdds()).toEqual([]);
    expect(mockPrisma.operationalEvent.create).not.toHaveBeenCalled();
  });

  it("starts and records nothing for a campaign without offers", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue(mockAutomation);

    await getProcessor()(tap("mid_tap_1"));

    expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
    expect(offerAdds()).toEqual([]);
    expect(mockPrisma.operationalEvent.create).not.toHaveBeenCalled();
  });

  it("keeps a delivered tap SENT when the offer start cannot be queued", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mockPrisma.automation.findFirst.mockResolvedValue(withOffers);
      mockQueueAdd.mockRejectedValue(new Error("Redis connection lost"));

      await expect(getProcessor()(tap("mid_tap_1"))).resolves.toBeUndefined();

      expect(mockQueueAdd).toHaveBeenCalledTimes(1);
      expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ status: "SENT" }),
        })
      );
      expect(mockPrisma.dmLog.upsert).not.toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({ status: "FAILED" }),
        })
      );
      expect(mockReleaseWorkspaceDMReservation).not.toHaveBeenCalled();
      expect(mockPrisma.operationalEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          workspaceId: "workspace_123",
          level: "WARNING",
          message: "Offer not started after a delivered link",
        }),
      });
    } finally {
      consoleError.mockRestore();
    }
  });

  it("runs a process-offer job through the offer engine", async () => {
    const job = {
      name: "process-offer",
      data: {
        phase: "card",
        workspaceId: "workspace_123",
        accountConnectionId: "ig_account_row_1",
        instagramAccountId: "ig_456",
        contactOfferId: "co1",
      },
      id: "offer_co1_card",
      attemptsMade: 0,
    };

    await getProcessor()(job);

    expect(processOffer).toHaveBeenCalledWith(job);
    expect(mockPrisma.contactOffer.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "co1", workspaceId: "workspace_123" } })
    );
    // Never read as a comment.
    expect(mockPrisma.automation.findMany).not.toHaveBeenCalled();
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
  });

  it("hands a tap on an offer's button to the offer engine without loading a campaign", async () => {
    const job = createMockPostbackJob({
      instagramAccountId: "ig_456",
      userId: "commenter_999",
      payload: "offer:co1",
      mid: "mid_yes",
    });

    await getProcessor()(job);

    expect(processOfferTap).toHaveBeenCalledWith(job);
    expect(mockPrisma.contactOffer.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "co1" } })
    );
    expect(mockPrisma.automation.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.contact.upsert).not.toHaveBeenCalled();
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
  });

  // offerDelayHours 22: the offer starts 22 hours after the tap or DM that
  // brought the link, rounded down to the half hour, as a delayed start job.
  describe("for a campaign that starts its offers 22 hours later", () => {
    const lateOffers = { ...withOffers, offerDelayHours: 22 };
    // The link goes out five seconds after the tap.
    const DELIVERED_AT = TAP_TIME + 5_000;

    function lateStartAdd(startKey: string, interactionAt: number, fireAt: string) {
      const [name, data, options] = startAdd(startKey, interactionAt);
      return [
        name,
        { ...(data as Record<string, unknown>), lateStart: true },
        {
          ...(options as Record<string, unknown>),
          delay: Date.parse(fireAt) - DELIVERED_AT,
        },
      ];
    }

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(DELIVERED_AT);
    });
    afterEach(() => vi.useRealTimers());

    it("queues the start of a tap 22 hours later, under the same job id", async () => {
      mockPrisma.automation.findFirst.mockResolvedValue(lateOffers);

      await getProcessor()(tap("mid_tap_1"));

      expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
      // 10:00 + 22 h = 08:00 the next day, already on the half hour.
      expect(offerAdds()).toEqual([
        lateStartAdd("auto_789:tap:mid_tap_1", TAP_TIME, "2026-11-21T08:00:00.000Z"),
      ]);
      expect(mockPrisma.operationalEvent.create).not.toHaveBeenCalled();
    });

    it("counts from the tap a follow re-check repeats, rounded down", async () => {
      mockPrisma.automation.findFirst.mockResolvedValue({
        ...lateOffers,
        requireFollow: true,
      });
      mockGetUserFollowStatus.mockResolvedValue(true);
      const tappedAt = TAP_TIME - 7 * 60_000;

      await getProcessor()({
        ...createMockPostbackJob({
          instagramAccountId: "ig_456",
          userId: "commenter_999",
          payload: "followcheck:auto_789",
          mid: "mid_tap_1",
          followRecheck: true,
          followRecheckAttempt: 1,
          tappedAt,
        }),
        id: "postback_recheck_auto_789_commenter_999_1_88",
        timestamp: TAP_TIME,
      });

      // 09:53 + 22 h = 07:53, rounded down to 07:30.
      expect(offerAdds()).toEqual([
        lateStartAdd("auto_789:tap:mid_tap_1", tappedAt, "2026-11-21T07:30:00.000Z"),
      ]);
    });

    it("queues the start of a DM trigger the same way", async () => {
      mockPrisma.automation.findMany.mockResolvedValue([
        { ...dmTriggerCampaign, offersEnabled: true, offerDelayHours: 22 },
      ]);

      await getProcessor()(inboundDmJob());

      expect(offerAdds()).toEqual([
        lateStartAdd("auto_789:dm:mid_abc", TAP_TIME, "2026-11-21T08:00:00.000Z"),
      ]);
    });

    it.each([0, 5, 24])(
      "starts right away for a campaign that holds %i",
      async (offerDelayHours) => {
        mockPrisma.automation.findFirst.mockResolvedValue({
          ...withOffers,
          offerDelayHours,
        });

        await getProcessor()(tap("mid_tap_1"));

        expect(offerAdds()).toEqual([startAdd("auto_789:tap:mid_tap_1", TAP_TIME)]);
      }
    );

    it("still skips a link that went out as a private reply", async () => {
      mockPrisma.automation.findMany.mockResolvedValue([lateOffers]);

      await getProcessor()(createMockJob());

      expect(offerAdds()).toEqual([]);
      expect(mockPrisma.operationalEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ message: START_EVENT }),
      });
    });
  });
});

// R1: a Meta request limit costs the comment time, not its DM. The account
// pauses (meta:pause:<ig>), the refused try does not count, and a copy of the
// job waits for the end of the pause; nothing calls Meta in the meantime.
describe("DM Worker — Meta request limits on the comment path", () => {
  const MINUTE = 60_000;
  const NOW = new Date("2026-11-21T13:00:00.000Z").getTime();
  const PAUSE_KEY = "meta:pause:ig_456";
  let redis: FakeRedis;

  function limit(code: number) {
    return Object.assign(
      new RateLimitError(
        `(#4) Application request limit reached (/v25.0/ig_456/messages) [code=${code} sub=- type=OAuthException trace=t]`
      ),
      { code }
    );
  }

  function pauseEvents() {
    return mockPrisma.operationalEvent.create.mock.calls.filter(
      ([args]) =>
        (args as { data: { payload?: { kind?: string } } }).data.payload
          ?.kind === "meta-pause"
    );
  }

  // The claim that every send takes on the comment's DmLog row.
  function claims() {
    return mockPrisma.dmLog.updateMany.mock.calls.filter(
      ([args]) =>
        (args as { data: Record<string, unknown> }).data
          .dmDeliveryUnconfirmed === true
    );
  }

  function pauseAdds() {
    return mockQueueAdd.mock.calls.filter(([, , opts]) =>
      String(opts?.jobId).includes("_pause_")
    );
  }

  const webhookJob = (data: Record<string, unknown> = mockJobData) => ({
    ...createMockJob(data),
    id: "comment_ig_456_comment_555",
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    redis = new FakeRedis();
    vi.mocked(getRedisConnection).mockReturnValue(redis as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("puts the comment back for the pause instead of failing it", async () => {
    mockSendPrivateReply.mockRejectedValueOnce(limit(4));

    // The job ends without an error: BullMQ's own retries after 5 and 15
    // minutes would only run into the limit again.
    await expect(getProcessor()(webhookJob())).resolves.toBeUndefined();

    // The claim goes back with its attempt: the refused try does not count.
    expect(mockPrisma.dmLog.updateMany).toHaveBeenCalledWith({
      where: {
        automationId: "auto_789",
        commentId: "comment_555",
        status: { not: "SENT" },
        dmDeliveryUnconfirmed: true,
        attempts: { gt: 0 },
      },
      data: {
        dmDeliveryUnconfirmed: false,
        attempts: { decrement: 1 },
        status: "PENDING",
        errorMessage: expect.stringMatching(
          /^Instagram request limit; next try at 13:2\d UTC$/
        ),
      },
    });
    expect(mockPrisma.dmLog.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "FAILED" }),
      })
    );
    // The reservations go back, as for any refusal.
    expect(mockReleaseDMSlot).toHaveBeenCalledWith("ig_456");
    expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalledWith(
      "workspace_123",
      usagePeriodStart
    );

    // The account pauses for 20 minutes, recorded once.
    await expect(redis.get(PAUSE_KEY)).resolves.toBe(String(NOW + 20 * MINUTE));
    expect(pauseEvents()).toHaveLength(1);
    expect(pauseEvents()[0][0].data).toMatchObject({
      workspaceId: "workspace_123",
      level: "WARNING",
      message: "Instagram request limit reached: sending paused until 13:20 UTC",
    });

    // A copy of the job runs after the pause, within its minute of jitter.
    expect(pauseAdds()).toEqual([
      [
        "process-comment",
        { ...mockJobData, pauseRequeue: 1 },
        {
          jobId: "comment_ig_456_comment_555_pause_1",
          delay: expect.any(Number),
          removeOnComplete: true,
        },
      ],
    ]);
    const { delay } = pauseAdds()[0][2];
    expect(delay).toBeGreaterThanOrEqual(20 * MINUTE);
    expect(delay).toBeLessThan(21 * MINUTE);
  });

  it.each([4, 17, 32, 613, 80002, 80006])(
    "puts the comment back for code %i, pausing 20 minutes",
    async (code) => {
      mockSendPrivateReply.mockRejectedValueOnce(limit(code));

      await getProcessor()(webhookJob());

      await expect(redis.get(PAUSE_KEY)).resolves.toBe(String(NOW + 20 * MINUTE));
      expect(pauseAdds()).toHaveLength(1);
    }
  );

  it("pauses an hour for a block (368), or as configured", async () => {
    mockSendPrivateReply.mockRejectedValueOnce(limit(368));
    await getProcessor()(webhookJob());
    await expect(redis.get(PAUSE_KEY)).resolves.toBe(String(NOW + 60 * MINUTE));

    vi.stubEnv("META_BLOCK_PAUSE_MINUTES", "120");
    vi.setSystemTime(NOW + 61 * MINUTE);
    mockSendPrivateReply.mockRejectedValueOnce(limit(368));
    await getProcessor()(webhookJob());
    await expect(redis.get(PAUSE_KEY)).resolves.toBe(
      String(NOW + 61 * MINUTE + 120 * MINUTE)
    );
  });

  it("calls nothing at Meta while the account is paused", async () => {
    await redis.set(PAUSE_KEY, String(NOW + 10 * MINUTE), "PX", 10 * MINUTE);
    mockPrisma.automation.findMany.mockResolvedValue([
      { ...mockAutomation, requireFollow: true },
    ]);

    await expect(getProcessor()(webhookJob())).resolves.toBeUndefined();

    expect(mockGetUserFollowStatus).not.toHaveBeenCalled();
    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(mockSendPrivateReplyWithButton).not.toHaveBeenCalled();
    // Nothing reserved, nothing claimed: the attempts stay as they were.
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
    expect(mockReserveDMSlot).not.toHaveBeenCalled();
    expect(claims()).toHaveLength(0);
    expect(mockPrisma.dmLog.updateMany).toHaveBeenCalledWith({
      where: {
        automationId: "auto_789",
        commentId: "comment_555",
        status: { not: "SENT" },
        dmDeliveryUnconfirmed: false,
      },
      data: {
        status: "PENDING",
        errorMessage: expect.stringMatching(/^Instagram request limit; next try at 13:1\d UTC$/),
      },
    });
    expect(pauseAdds()).toHaveLength(1);
    expect(pauseAdds()[0][2].delay).toBeGreaterThanOrEqual(10 * MINUTE);
    expect(pauseAdds()[0][2].delay).toBeLessThan(11 * MINUTE);
    // Whoever started the pause recorded it; this job did not.
    expect(pauseEvents()).toHaveLength(0);
  });

  it("records the pause once, not once per comment", async () => {
    mockSendPrivateReply.mockRejectedValueOnce(limit(4));
    await getProcessor()(webhookJob());
    await getProcessor()(
      { ...createMockJob({ ...mockJobData, commentId: "comment_556" }), id: "comment_ig_456_comment_556" }
    );
    await getProcessor()(
      { ...createMockJob({ ...mockJobData, commentId: "comment_557" }), id: "comment_ig_456_comment_557" }
    );

    expect(mockSendPrivateReply).toHaveBeenCalledTimes(1);
    expect(pauseEvents()).toHaveLength(1);
    expect(pauseAdds().map(([, , opts]) => opts.jobId)).toEqual([
      "comment_ig_456_comment_555_pause_1",
      "comment_ig_456_comment_556_pause_1",
      "comment_ig_456_comment_557_pause_1",
    ]);
    // Spread over the minute after the pause, by job id.
    const delays = pauseAdds().map(([, , opts]) => opts.delay);
    expect(new Set(delays).size).toBe(3);
  });

  it("waits for the pause when the follow check runs into the limit", async () => {
    mockPrisma.automation.findMany.mockResolvedValue([
      { ...mockAutomation, requireFollow: true },
    ]);
    mockGetUserFollowStatus.mockRejectedValueOnce(limit(4));

    await expect(getProcessor()(webhookJob())).resolves.toBeUndefined();

    // Asked to throw the limit instead of reading it as "not following",
    // which would have sent the follow prompt to someone who may follow.
    expect(mockGetUserFollowStatus).toHaveBeenCalledWith(
      META_AUTH,
      "commenter_999",
      { throwOnLimit: true }
    );
    expect(mockSendPrivateReplyWithButton).not.toHaveBeenCalled();
    expect(claims()).toHaveLength(0);
    expect(mockReleaseDMSlot).toHaveBeenCalledWith("ig_456");
    expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalledWith(
      "workspace_123",
      usagePeriodStart
    );
    await expect(redis.get(PAUSE_KEY)).resolves.toBe(String(NOW + 20 * MINUTE));
    expect(pauseEvents()).toHaveLength(1);
    expect(pauseAdds()).toHaveLength(1);
  });

  it("sends the DM with the copy once the pause is over", async () => {
    mockSendPrivateReply.mockRejectedValueOnce(limit(4));
    await getProcessor()(webhookJob());
    const [, data, opts] = pauseAdds()[0];

    vi.setSystemTime(NOW + opts.delay);
    mockPrisma.dmLog.findUnique.mockResolvedValue({
      status: "PENDING",
      attempts: 0,
      dmDeliveryUnconfirmed: false,
    });
    await getProcessor()({ ...createMockJob(data), id: opts.jobId });

    expect(mockSendPrivateReply).toHaveBeenCalledTimes(2);
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "SENT" }),
      })
    );
  });

  it("never sends twice when the copy and another job for the comment race", async () => {
    let claimed = false;
    mockPrisma.dmLog.updateMany.mockImplementation(
      async (args: { data: Record<string, unknown> }) => {
        if (args.data.dmDeliveryUnconfirmed !== true) return { count: 1 };
        if (claimed) return { count: 0 };
        claimed = true;
        return { count: 1 };
      }
    );
    const process = getProcessor();
    await Promise.all([
      process({
        ...createMockJob({ ...mockJobData, pauseRequeue: 1 }),
        id: "comment_ig_456_comment_555_pause_1",
      }),
      process({ ...createMockJob(), id: "sweep-job" }),
    ]);
    expect(mockSendPrivateReply).toHaveBeenCalledTimes(1);
  });

  it("gives up after 12 waits and fails the comment as before", async () => {
    mockSendPrivateReply.mockRejectedValueOnce(limit(4));

    await expect(
      getProcessor()(webhookJob({ ...mockJobData, pauseRequeue: 12 }))
    ).rejects.toMatchObject({ name: "RateLimitError" });

    expect(pauseAdds()).toHaveLength(0);
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith({
      where: {
        automationId_commentId: { automationId: "auto_789", commentId: "comment_555" },
      },
      data: expect.objectContaining({
        status: "FAILED",
        dmDeliveryUnconfirmed: false,
        errorMessage: expect.stringMatching(
          /^Instagram request limit: the account was still paused after 12 waits \(until 13:20 UTC\), so the DM was not sent\. \(#4\) Application request limit reached .*\[code=4 /
        ),
      }),
    });
    // The account still pauses: the next comment waits.
    await expect(redis.get(PAUSE_KEY)).resolves.toBe(String(NOW + 20 * MINUTE));
  });

  it("gives up without calling Meta when the 13th try still finds the pause", async () => {
    await redis.set(PAUSE_KEY, String(NOW + 10 * MINUTE), "PX", 10 * MINUTE);

    await expect(
      getProcessor()(webhookJob({ ...mockJobData, pauseRequeue: 12 }))
    ).rejects.toMatchObject({ name: "AccountPausedError" });

    expect(mockSendPrivateReply).not.toHaveBeenCalled();
    expect(pauseAdds()).toHaveLength(0);
    expect(mockPrisma.dmLog.updateMany).toHaveBeenCalledWith({
      where: {
        automationId: "auto_789",
        commentId: "comment_555",
        status: { not: "SENT" },
        dmDeliveryUnconfirmed: false,
      },
      data: {
        status: "FAILED",
        errorMessage:
          "Instagram request limit: the account was still paused after 12 waits (until 13:10 UTC), so the DM was not sent",
      },
    });
  });

  it("posts no public reply for a DM that waits", async () => {
    const { sendCommentReply } = await import("@/lib/meta/client");
    mockPrisma.automation.findMany.mockResolvedValue([
      { ...mockAutomation, publicReplyEnabled: true, publicReplyMessages: ["Check your DMs"] },
    ]);
    mockSendPrivateReply.mockRejectedValueOnce(limit(4));

    await getProcessor()(webhookJob());

    expect(sendCommentReply).not.toHaveBeenCalled();
  });

  it("still fails other refusals at once, without a pause", async () => {
    mockSendPrivateReply.mockRejectedValueOnce(
      new MetaApiError(100, undefined, undefined, "The comment is invalid for a private reply")
    );

    await expect(getProcessor()(webhookJob())).rejects.toThrow("invalid for a private reply");

    await expect(redis.get(PAUSE_KEY)).resolves.toBeNull();
    expect(pauseAdds()).toHaveLength(0);
    expect(mockPrisma.dmLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "FAILED" }),
      })
    );
  });

  it("leaves Zernio's own limit (HTTP 429) as it was", async () => {
    mockSendPrivateReply.mockRejectedValueOnce(limit(429));

    await expect(getProcessor()(webhookJob())).rejects.toMatchObject({
      name: "RateLimitError",
    });

    await expect(redis.get(PAUSE_KEY)).resolves.toBeNull();
    expect(pauseAdds()).toHaveLength(0);
  });

  it("sends as before when Redis cannot be read", async () => {
    vi.mocked(getRedisConnection).mockReturnValue({
      get: async () => {
        throw new Error("Connection is closed.");
      },
    } as never);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await getProcessor()(webhookJob());

    expect(mockSendPrivateReply).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });
});

// R1 for the conversation: a button tap, the reply to a DM and the follow-up
// wait for the end of the account's pause like a comment's DM, before
// anything is sent and without costing the message. Every wait is a copy of
// the job (requeueForPause) that takes the same claim, so a tap or a DM is
// answered once, whichever of its jobs runs first.
describe("DM Worker — Meta request limits on taps, DM replies and follow-ups", () => {
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const NOW = new Date("2026-11-21T13:00:00.000Z").getTime();
  const TAPPED = NOW - 1000;
  const PAUSE_KEY = "meta:pause:ig_456";
  const gated = { ...mockAutomation, requireFollow: true, trackedLinks: [] };
  let redis: FakeRedis;

  function limit(code = 4) {
    return Object.assign(
      new RateLimitError(
        `(#4) Application request limit reached (/v25.0/ig_456/messages) [code=${code} sub=- type=OAuthException trace=t]`
      ),
      { code }
    );
  }

  const sha = (parts: unknown[]) =>
    createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  // The claims of a tap and of a DM reply, as the worker names them.
  const tapClaim = (tapId: string) =>
    sha(["ig_account_row_1", "auto_789", "commenter_999", tapId]);
  const replyClaim = (mid: string, automationId = "auto_789") =>
    sha(["ig_account_row_1", "dm", automationId, mid]);

  function pauseCopies() {
    return mockQueueAdd.mock.calls.filter(([, , opts]) =>
      String(opts?.jobId).includes("_pause_")
    );
  }

  function pauseEvents() {
    return mockPrisma.operationalEvent.create.mock.calls.filter(
      ([args]) =>
        (args as { data: { payload?: { kind?: string } } }).data.payload
          ?.kind === "meta-pause"
    );
  }

  function pauseFor(minutes: number) {
    return redis.set(PAUSE_KEY, String(NOW + minutes * MINUTE), "PX", minutes * MINUTE);
  }

  // A durable claim table, as PostbackDelivery keeps it.
  function realClaims() {
    const taken = new Set<string>();
    mockPrisma.postbackDelivery.create.mockImplementation(
      async ({ data }: { data: { id: string } }) => {
        if (taken.has(data.id)) throw { code: "P2002" };
        taken.add(data.id);
        return data;
      }
    );
    mockPrisma.postbackDelivery.delete.mockImplementation(
      async ({ where }: { where: { id: string } }) => {
        taken.delete(where.id);
      }
    );
    return taken;
  }

  function anyLinkSends() {
    return (
      mockSendDirectMessage.mock.calls.length +
      mockSendDirectMessageWithLinkButton.mock.calls.length
    );
  }

  // The job BullMQ runs for a queued copy, at the time it was queued for.
  function copyJob([name, data, opts]: unknown[]) {
    const { jobId, delay } = opts as { jobId: string; delay: number };
    vi.setSystemTime(NOW + delay);
    return {
      name: name as string,
      data: data as Record<string, unknown>,
      id: jobId,
      attemptsMade: 0,
      timestamp: NOW,
    };
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    redis = new FakeRedis();
    vi.mocked(getRedisConnection).mockReturnValue(redis as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  describe("a button tap", () => {
    const tapData = {
      instagramAccountId: "ig_456",
      userId: "commenter_999",
      payload: "reveal:auto_789",
      mid: "mid_tap",
    };
    const tap = (data: Record<string, unknown> = {}) => ({
      ...createMockPostbackJob({ ...tapData, ...data }),
      timestamp: TAPPED,
    });

    beforeEach(() => {
      mockPrisma.automation.findFirst.mockResolvedValue(mockAutomation);
    });

    it("waits for the pause without calling Instagram, reserving or claiming", async () => {
      await pauseFor(10);

      await expect(getProcessor()(tap())).resolves.toBeUndefined();

      expect(anyLinkSends()).toBe(0);
      expect(mockGetUserFollowStatus).not.toHaveBeenCalled();
      expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
      expect(mockPrisma.postbackDelivery.create).not.toHaveBeenCalled();
      // Not even the name is looked up; the tap is recorded on the contact,
      // where its window is read from.
      expect(mockPrisma.contact.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.contact.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ lastInteractionAt: new Date(TAPPED) }),
        })
      );
      // The link waits: its row says when it is tried next.
      expect(mockPrisma.dmLog.updateMany).toHaveBeenCalledWith({
        where: {
          automationId: "auto_789",
          commentId: "reveal:commenter_999",
          status: { not: "SENT" },
        },
        data: {
          status: "PENDING",
          errorMessage: expect.stringMatching(/^Instagram request limit; next try at 13:1\d UTC$/),
        },
      });
      // A copy of the tap runs after the pause, with the tap's time and id.
      expect(pauseCopies()).toEqual([
        [
          "process-postback",
          { ...tapData, tappedAt: TAPPED, tapId: "mid_tap", pauseRequeue: 1 },
          {
            jobId: `postback_${tapClaim("mid_tap")}_pause_1`,
            delay: expect.any(Number),
            removeOnComplete: true,
          },
        ],
      ]);
      const { delay } = pauseCopies()[0][2];
      expect(delay).toBeGreaterThanOrEqual(10 * MINUTE);
      expect(delay).toBeLessThan(11 * MINUTE);
      // Whoever started the pause recorded it.
      expect(pauseEvents()).toHaveLength(0);
    });

    it("creates the waiting row, and leaves one that says the link went out", async () => {
      await pauseFor(10);
      mockPrisma.dmLog.updateMany.mockResolvedValue({ count: 0 });

      await getProcessor()(tap());
      expect(mockPrisma.dmLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          automationId: "auto_789",
          commentId: "reveal:commenter_999",
          commentText: "(button tap)",
          status: "PENDING",
          errorMessage: expect.stringMatching(/^Instagram request limit; next try at/),
        }),
      });

      // A SENT row (the person got the link with an earlier tap) stays.
      mockPrisma.dmLog.create.mockRejectedValueOnce({ code: "P2002" });
      await expect(getProcessor()(tap({ mid: "mid_second" }))).resolves.toBeUndefined();
      expect(pauseCopies()).toHaveLength(2);
    });

    it("pauses the account and waits when Instagram refuses the link with a request limit", async () => {
      mockSendDirectMessage.mockRejectedValueOnce(limit(4));

      // No error: BullMQ's retries after 5 and 15 minutes would only run into
      // the limit again.
      await expect(getProcessor()(tap())).resolves.toBeUndefined();

      // Refused: the claim and the reservation go back, as for any refusal.
      expect(mockPrisma.postbackDelivery.delete).toHaveBeenCalledWith({
        where: { id: tapClaim("mid_tap") },
      });
      expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalledWith(
        "workspace_123",
        usagePeriodStart
      );
      await expect(redis.get(PAUSE_KEY)).resolves.toBe(String(NOW + 20 * MINUTE));
      expect(pauseEvents()).toHaveLength(1);
      expect(mockPrisma.dmLog.upsert).not.toHaveBeenCalled();
      expect(mockPrisma.dmLog.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            status: "PENDING",
            errorMessage: expect.stringMatching(/^Instagram request limit; next try at 13:2\d UTC$/),
          },
        })
      );
      expect(pauseCopies()).toHaveLength(1);
      expect(afterLinkDelivered).not.toHaveBeenCalled();
    });

    it.each([17, 32, 613, 80002, 80006, 368])(
      "waits for code %i as well",
      async (code) => {
        mockSendDirectMessage.mockRejectedValueOnce(limit(code));

        await expect(getProcessor()(tap())).resolves.toBeUndefined();

        expect(pauseCopies()).toHaveLength(1);
        await expect(redis.get(PAUSE_KEY)).resolves.toBe(
          String(NOW + (code === 368 ? 60 : 20) * MINUTE)
        );
      }
    );

    it("sends the link with the copy after the pause, as the same tap", async () => {
      mockSendDirectMessage.mockRejectedValueOnce(limit(4));
      await getProcessor()(tap());

      await getProcessor()(copyJob(pauseCopies()[0]));

      expect(mockSendDirectMessage).toHaveBeenCalledTimes(2);
      // The same claim both times: the copy is no new tap.
      expect(mockPrisma.postbackDelivery.create.mock.calls).toEqual([
        [{ data: { id: tapClaim("mid_tap") } }],
        [{ data: { id: tapClaim("mid_tap") } }],
      ]);
      expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({ status: "SENT" }),
        })
      );
      // Counted from the tap, which opened the window, and keyed on it.
      expect(mockPrisma.contact.upsert).toHaveBeenLastCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ lastInteractionAt: new Date(TAPPED) }),
        })
      );
      expect(afterLinkDelivered).toHaveBeenCalledWith(
        expect.objectContaining({ via: "tap", interactionAt: TAPPED, triggerId: "mid_tap" })
      );
    });

    it("never sends the link twice when the copy and the redelivered tap race", async () => {
      realClaims();
      mockSendDirectMessage.mockRejectedValueOnce(limit(4));
      await getProcessor()(tap());
      const copy = copyJob(pauseCopies()[0]);

      const process = getProcessor();
      await Promise.all([
        process(copy),
        process({ ...tap(), id: "postback_redelivered" }),
        process({ ...tap(), id: "postback_job_001", attemptsMade: 1 }),
      ]);

      // The refused try and one send.
      expect(mockSendDirectMessage).toHaveBeenCalledTimes(2);
    });

    it("waits when the follow check runs into the limit, asking nothing more", async () => {
      mockPrisma.automation.findFirst.mockResolvedValue(gated);
      mockGetUserFollowStatus.mockRejectedValueOnce(limit(4));

      await expect(
        getProcessor()(tap({ payload: "followcheck:auto_789" }))
      ).resolves.toBeUndefined();

      // Asked to throw the limit: read as "not following" it would have sent
      // the prompt, read as unknown the link without a check.
      expect(mockGetUserFollowStatus).toHaveBeenCalledWith(
        META_AUTH,
        "commenter_999",
        { throwOnLimit: true }
      );
      expect(mockSendDirectMessageWithButton).not.toHaveBeenCalled();
      expect(anyLinkSends()).toBe(0);
      expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
      expect(mockPrisma.postbackDelivery.create).not.toHaveBeenCalled();
      // The tap's row is the link's: a follow check that waits creates none.
      // It only moves the next try of a link that waits already.
      expect(mockPrisma.dmLog.updateMany).toHaveBeenCalledWith({
        where: {
          automationId: "auto_789",
          commentId: "reveal:commenter_999",
          status: "PENDING",
        },
        data: {
          errorMessage: expect.stringMatching(/^Instagram request limit; next try at 13:2\d UTC$/),
        },
      });
      expect(mockPrisma.dmLog.create).not.toHaveBeenCalled();
      expect(mockPrisma.dmLog.upsert).not.toHaveBeenCalled();
      await expect(redis.get(PAUSE_KEY)).resolves.toBe(String(NOW + 20 * MINUTE));
      expect(pauseCopies()).toHaveLength(1);
      expect(pauseCopies()[0][1]).toMatchObject({
        payload: "followcheck:auto_789",
        pauseRequeue: 1,
      });
    });

    it("waits for the pause before the follow check of a gated tap", async () => {
      await pauseFor(10);
      mockPrisma.automation.findFirst.mockResolvedValue(gated);

      await getProcessor()(tap({ payload: "followcheck:auto_789" }));

      expect(mockGetUserFollowStatus).not.toHaveBeenCalled();
      // No row of its own; a link that waits already gets the next try.
      expect(mockPrisma.dmLog.updateMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.dmLog.updateMany).toHaveBeenCalledWith({
        where: {
          automationId: "auto_789",
          commentId: "reveal:commenter_999",
          status: "PENDING",
        },
        data: {
          errorMessage: expect.stringMatching(/^Instagram request limit; next try at 13:1\d UTC$/),
        },
      });
      expect(mockPrisma.dmLog.create).not.toHaveBeenCalled();
      expect(pauseCopies()).toHaveLength(1);
    });

    // A gated tap whose link was refused once waits as PENDING. Its copies
    // keep the follow check's payload, so a later pause meets them before the
    // check: wherever the wait ends there, the waiting link ends with it.
    describe("a link that waited, behind a follow check", () => {
      const waitingRow = (data: Record<string, unknown>) => ({
        where: {
          automationId: "auto_789",
          commentId: "reveal:commenter_999",
          status: "PENDING",
        },
        data,
      });
      const gatedCopy = (data: Record<string, unknown> = {}) =>
        tap({
          payload: "followcheck:auto_789",
          tapId: "mid_tap",
          tappedAt: TAPPED,
          ...data,
        });

      beforeEach(() => {
        mockPrisma.automation.findFirst.mockResolvedValue(gated);
      });

      it("is logged FAILED when the twelfth wait still finds the pause before the check", async () => {
        await pauseFor(10);

        await expect(getProcessor()(gatedCopy({ pauseRequeue: 12 }))).rejects.toMatchObject({
          name: "AccountPausedError",
        });

        expect(mockGetUserFollowStatus).not.toHaveBeenCalled();
        expect(pauseCopies()).toHaveLength(0);
        expect(mockPrisma.dmLog.updateMany).toHaveBeenCalledWith(
          waitingRow({
            status: "FAILED",
            errorMessage:
              "Instagram request limit: the account was still paused after 12 waits (until 13:10 UTC), so the DM was not sent",
          })
        );
        // A tap whose link never waited gets no row: a follow request has none.
        expect(mockPrisma.dmLog.upsert).not.toHaveBeenCalled();
        expect(mockPrisma.dmLog.create).not.toHaveBeenCalled();
      });

      it("is logged FAILED when the twelfth wait's follow check still meets the limit", async () => {
        mockGetUserFollowStatus.mockRejectedValueOnce(limit(4));

        await expect(getProcessor()(gatedCopy({ pauseRequeue: 12 }))).rejects.toMatchObject({
          name: "RateLimitError",
        });

        expect(pauseCopies()).toHaveLength(0);
        expect(mockPrisma.dmLog.updateMany).toHaveBeenCalledWith(
          waitingRow({
            status: "FAILED",
            errorMessage: expect.stringMatching(
              /^Instagram request limit: the account was still paused after 12 waits \(until 13:20 UTC\), so the DM was not sent\. \(#4\) Application request limit reached/
            ),
          })
        );
        expect(mockPrisma.dmLog.upsert).not.toHaveBeenCalled();
      });

      it("is logged FAILED when the window closes before the pause ends", async () => {
        const longAgo = NOW - 23 * HOUR - 50 * MINUTE;
        mockPrisma.contact.upsert.mockResolvedValue({
          id: "contact_1",
          username: "commenter_user",
          lastInteractionAt: new Date(longAgo),
        });
        await pauseFor(10);

        await expect(
          getProcessor()(gatedCopy({ tappedAt: longAgo, pauseRequeue: 3 }))
        ).resolves.toBeUndefined();

        expect(pauseCopies()).toHaveLength(0);
        expect(mockPrisma.dmLog.updateMany).toHaveBeenCalledWith(
          waitingRow({
            status: "FAILED",
            errorMessage:
              "Instagram request limit: the messaging window closes before the account's pause ends (13:10 UTC), so the DM was not sent",
          })
        );
        expect(mockPrisma.dmLog.upsert).not.toHaveBeenCalled();
      });

      it("is logged FAILED when the follow prompt is still refused after the twelfth wait", async () => {
        mockGetUserFollowStatus.mockResolvedValue(false);
        mockSendDirectMessageWithButton.mockRejectedValueOnce(limit(4));

        await expect(
          getProcessor()(gatedCopy({ payload: "followcheck:auto_789:open", pauseRequeue: 12 }))
        ).resolves.toBeUndefined();

        expect(pauseCopies()).toHaveLength(0);
        expect(mockPrisma.dmLog.updateMany).toHaveBeenCalledTimes(1);
        expect(mockPrisma.dmLog.updateMany).toHaveBeenCalledWith(
          waitingRow({
            status: "FAILED",
            errorMessage: expect.stringMatching(
              /^Instagram request limit: the account was still paused after 12 waits \(until 13:20 UTC\), so the DM was not sent\. /
            ),
          })
        );
      });

      it("is logged FAILED when the copy's follow check finds no follow and asks to follow instead", async () => {
        mockGetUserFollowStatus.mockResolvedValue(false);

        await getProcessor()(gatedCopy({ payload: "followcheck:auto_789:open", pauseRequeue: 2 }));

        expect(mockSendDirectMessageWithButton).toHaveBeenCalledTimes(1);
        expect(anyLinkSends()).toBe(0);
        expect(mockPrisma.dmLog.updateMany).toHaveBeenCalledWith(
          waitingRow({
            status: "FAILED",
            errorMessage: "Not sent: the follow check after the account's pause found no follow",
          })
        );
      });

      it("is logged FAILED after the copy's last re-check sends the second follow request", async () => {
        mockGetUserFollowStatus.mockResolvedValue(false);

        await getProcessor()(
          gatedCopy({ pauseRequeue: 2, followRecheck: true, followRecheckAttempt: 2 })
        );

        expect(mockSendDirectMessageWithButton).toHaveBeenLastCalledWith(
          META_AUTH,
          "ig_456",
          "commenter_999",
          expect.any(String),
          expect.any(String),
          "followcheck:auto_789:retry"
        );
        expect(mockPrisma.dmLog.updateMany).toHaveBeenCalledWith(
          waitingRow({
            status: "FAILED",
            errorMessage: "Not sent: the follow check after the account's pause found no follow",
          })
        );
      });

      it("still waits while the copy's follow re-checks run", async () => {
        mockGetUserFollowStatus.mockResolvedValue(false);

        await getProcessor()(gatedCopy({ pauseRequeue: 2 }));

        // The re-check carries the copy on; the link may still come.
        expect(mockQueueAdd).toHaveBeenCalledWith(
          "process-postback",
          expect.objectContaining({ pauseRequeue: 2, followRecheckAttempt: 1 }),
          expect.anything()
        );
        expect(mockPrisma.dmLog.updateMany).not.toHaveBeenCalled();
      });

      it("leaves the row alone when a tap that never waited finds no follow", async () => {
        mockGetUserFollowStatus.mockResolvedValue(false);

        await getProcessor()(tap({ payload: "followcheck:auto_789:open" }));

        expect(mockSendDirectMessageWithButton).toHaveBeenCalledTimes(1);
        expect(mockPrisma.dmLog.updateMany).not.toHaveBeenCalled();
      });
    });

    describe("a copy that no longer reaches its campaign", () => {
      const copy = (data: Record<string, unknown> = {}) =>
        tap({ tapId: "mid_tap", tappedAt: TAPPED, pauseRequeue: 1, ...data });
      const settled = (errorMessage: string) => ({
        where: {
          automationId: "auto_789",
          commentId: "reveal:commenter_999",
          status: "PENDING",
        },
        data: { status: "FAILED", errorMessage },
      });

      it("logs the link that waited FAILED when the campaign was paused or moved meanwhile", async () => {
        // Paused or deleted: the lookup finds no active campaign.
        mockPrisma.automation.findFirst.mockResolvedValue(null);
        await expect(getProcessor()(copy())).resolves.toBeUndefined();
        expect(mockPrisma.dmLog.updateMany).toHaveBeenLastCalledWith(
          settled("Not sent: the campaign was paused or changed while the account was paused")
        );

        // Moved to another account.
        mockPrisma.automation.findFirst.mockResolvedValue({
          ...mockAutomation,
          instagramAccount: { ...mockAutomation.instagramAccount, instagramId: "ig_other" },
        });
        await getProcessor()(copy());
        expect(mockPrisma.dmLog.updateMany).toHaveBeenLastCalledWith(
          settled("Not sent: the campaign was paused or changed while the account was paused")
        );
        expect(anyLinkSends()).toBe(0);
        expect(pauseCopies()).toHaveLength(0);
      });

      it("logs it FAILED when the account has no usable token any more", async () => {
        mockPrisma.automation.findFirst.mockResolvedValue({
          ...mockAutomation,
          instagramAccount: { ...mockAutomation.instagramAccount, accessToken: "" },
        });
        await getProcessor()(copy());
        expect(mockPrisma.dmLog.updateMany).toHaveBeenLastCalledWith(
          settled("No Instagram access token available")
        );

        mockPrisma.automation.findFirst.mockResolvedValue(mockAutomation);
        mockDecryptToken.mockImplementationOnce(() => {
          throw new Error("Unsupported state or unable to authenticate data");
        });
        await getProcessor()(copy());
        expect(mockPrisma.dmLog.updateMany).toHaveBeenLastCalledWith(
          settled("Failed to decrypt Instagram access token")
        );
        expect(anyLinkSends()).toBe(0);
      });

      it("touches nothing for a tap that never waited, or for a read fallback", async () => {
        mockPrisma.automation.findFirst.mockResolvedValue(null);

        await getProcessor()(tap());
        await getProcessor()(
          tap({ payload: "reveal:auto_789", fallback: true, mid: undefined, pauseRequeue: 1 })
        );

        expect(mockPrisma.dmLog.updateMany).not.toHaveBeenCalled();
      });
    });

    it("waits when the follow prompt is refused, and the copy prompts once", async () => {
      realClaims();
      mockPrisma.automation.findFirst.mockResolvedValue(gated);
      mockGetUserFollowStatus.mockResolvedValue(false);
      mockSendDirectMessageWithButton.mockRejectedValueOnce(limit(4));
      const opening = tap({ payload: "followcheck:auto_789:open" });

      await expect(getProcessor()(opening)).resolves.toBeUndefined();

      expect(mockPrisma.postbackDelivery.delete).toHaveBeenCalledWith({
        where: { id: tapClaim("mid_tap") },
      });
      await expect(redis.get(PAUSE_KEY)).resolves.toBe(String(NOW + 20 * MINUTE));
      expect(pauseCopies()).toHaveLength(1);

      const process = getProcessor();
      await Promise.all([
        process(copyJob(pauseCopies()[0])),
        process({ ...opening, id: "postback_redelivered" }),
      ]);
      expect(mockSendDirectMessageWithButton).toHaveBeenCalledTimes(2);
      expect(mockSendDirectMessageWithButton).toHaveBeenLastCalledWith(
        META_AUTH,
        "ig_456",
        "commenter_999",
        expect.any(String),
        expect.any(String),
        "followcheck:auto_789"
      );
    });

    it("waits when the second follow request is refused, as the same re-check", async () => {
      mockPrisma.automation.findFirst.mockResolvedValue(gated);
      mockGetUserFollowStatus.mockResolvedValue(false);
      mockSendDirectMessageWithButton.mockRejectedValueOnce(limit(4));

      await getProcessor()(
        tap({
          payload: "followcheck:auto_789",
          followRecheck: true,
          followRecheckAttempt: 2,
          tappedAt: TAPPED - MINUTE,
        })
      );

      expect(pauseCopies()).toHaveLength(1);
      expect(pauseCopies()[0][1]).toMatchObject({
        followRecheck: true,
        followRecheckAttempt: 2,
        tappedAt: TAPPED - MINUTE,
        pauseRequeue: 1,
      });
    });

    it("fails the tap after the twelfth wait, as a refused send", async () => {
      mockSendDirectMessage.mockRejectedValueOnce(limit(4));

      await expect(getProcessor()(tap({ pauseRequeue: 12 }))).rejects.toMatchObject({
        name: "RateLimitError",
      });

      expect(pauseCopies()).toHaveLength(0);
      expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            status: "FAILED",
            dmDeliveryUnconfirmed: false,
            errorMessage: expect.stringMatching(
              /^Instagram request limit: the account was still paused after 12 waits \(until 13:20 UTC\), so the DM was not sent\. \(#4\) Application request limit reached/
            ),
          }),
        })
      );
      // The account still pauses: the next tap waits.
      await expect(redis.get(PAUSE_KEY)).resolves.toBe(String(NOW + 20 * MINUTE));
    });

    it("gives up without calling Instagram when the thirteenth try still finds the pause", async () => {
      await pauseFor(10);

      await expect(getProcessor()(tap({ pauseRequeue: 12 }))).rejects.toMatchObject({
        name: "AccountPausedError",
      });

      expect(anyLinkSends()).toBe(0);
      expect(pauseCopies()).toHaveLength(0);
      expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: {
            status: "FAILED",
            errorMessage:
              "Instagram request limit: the account was still paused after 12 waits (until 13:10 UTC), so the DM was not sent",
          },
        })
      );
    });

    it("logs the link FAILED instead of waiting when the window closes before the pause ends", async () => {
      const longAgo = NOW - 23 * HOUR - 50 * MINUTE;
      mockPrisma.contact.upsert.mockResolvedValue({
        id: "contact_1",
        username: "commenter_user",
        lastInteractionAt: new Date(longAgo),
      });
      mockSendDirectMessage.mockRejectedValueOnce(limit(4));

      await expect(
        getProcessor()(tap({ tappedAt: longAgo, tapId: "mid_tap", pauseRequeue: 3 }))
      ).resolves.toBeUndefined();

      expect(pauseCopies()).toHaveLength(0);
      expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: {
            status: "FAILED",
            errorMessage:
              "Instagram request limit: the messaging window closes before the account's pause ends (13:20 UTC), so the DM was not sent",
          },
        })
      );
    });

    it("still waits late in the window when the copy runs before it closes", async () => {
      const late = NOW - 23 * HOUR - 30 * MINUTE;
      mockPrisma.contact.upsert.mockResolvedValue({
        id: "contact_1",
        username: "commenter_user",
        lastInteractionAt: new Date(late),
      });
      mockSendDirectMessage.mockRejectedValueOnce(limit(4));

      await getProcessor()(tap({ tappedAt: late, tapId: "mid_tap", pauseRequeue: 3 }));

      // 23 h 50 min after the tap at the latest, inside the 5-minute margin.
      expect(pauseCopies()).toHaveLength(1);
      expect(pauseCopies()[0][2].jobId).toBe(`postback_${tapClaim("mid_tap")}_pause_4`);
    });

    it("answers a waiting tap once more only if the link did not reach the person meanwhile", async () => {
      const copy = tap({ tappedAt: TAPPED - 20 * MINUTE, tapId: "mid_tap", pauseRequeue: 1 });
      // A read fallback that ran after the pause brought the link.
      mockPrisma.dmLog.findUnique.mockResolvedValueOnce({
        status: "SENT",
        dmSentAt: new Date(NOW - MINUTE),
      });
      await getProcessor()(copy);
      expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
      expect(anyLinkSends()).toBe(0);

      // A link from before the tap: the tap asks for it again, as every tap does.
      mockPrisma.dmLog.findUnique.mockResolvedValueOnce({
        status: "SENT",
        dmSentAt: new Date(TAPPED - HOUR),
      });
      await getProcessor()(copy);
      expect(anyLinkSends()).toBe(1);
    });

    it("leaves a refusal that is no request limit as it was", async () => {
      mockSendDirectMessage.mockRejectedValueOnce(
        new MetaApiError(100, undefined, undefined, "Invalid parameter")
      );

      await expect(getProcessor()(tap())).rejects.toThrow("Invalid parameter");

      await expect(redis.get(PAUSE_KEY)).resolves.toBeNull();
      expect(pauseCopies()).toHaveLength(0);
      expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({ status: "FAILED" }),
        })
      );
    });

    it("pauses the account, but sends no copy, when a refused link's claim cannot be given back", async () => {
      mockSendDirectMessage.mockRejectedValueOnce(limit(4));
      mockPrisma.postbackDelivery.delete.mockRejectedValueOnce(
        new Error("Connection terminated unexpectedly")
      );

      await expect(getProcessor()(tap())).rejects.toMatchObject({
        name: "UnrecoverableError",
      });

      await expect(redis.get(PAUSE_KEY)).resolves.toBe(String(NOW + 20 * MINUTE));
      expect(pauseCopies()).toHaveLength(0);
    });

    describe("a read fallback", () => {
      const fallback = () => ({
        ...createMockPostbackJob({
          instagramAccountId: "ig_456",
          userId: "commenter_999",
          payload: "reveal:auto_789",
          fallback: true,
        }),
        timestamp: NOW - 5 * MINUTE,
      });

      it("waits a minute behind the taps and DM replies held for the same pause", async () => {
        await pauseFor(10);
        // The person typed a reply instead of tapping: the window is open.
        mockPrisma.contact.upsert.mockResolvedValue({
          id: "contact_1",
          username: "commenter_user",
          lastInteractionAt: new Date(NOW - 2 * MINUTE),
        });

        await getProcessor()(fallback());

        expect(pauseCopies()).toHaveLength(1);
        const [, data, opts] = pauseCopies()[0];
        expect(data).toMatchObject({ fallback: true, tapId: "postback_job_001", pauseRequeue: 1 });
        expect(data).not.toHaveProperty("tappedAt");
        expect(opts.delay).toBeGreaterThanOrEqual(11 * MINUTE);
        expect(opts.delay).toBeLessThan(12 * MINUTE);
        // A fallback records nothing while it waits.
        expect(mockPrisma.dmLog.updateMany).not.toHaveBeenCalled();
      });

      it("is dropped during the pause when the person opened no window", async () => {
        await pauseFor(10);

        await expect(getProcessor()(fallback())).resolves.toBeUndefined();

        expect(pauseCopies()).toHaveLength(0);
        expect(anyLinkSends()).toBe(0);
        expect(mockPrisma.dmLog.upsert).not.toHaveBeenCalled();
      });

      it("sends nothing while a tap's link waits for the pause", async () => {
        mockPrisma.dmLog.findUnique.mockResolvedValue({ status: "PENDING" });

        await getProcessor()(fallback());

        expect(anyLinkSends()).toBe(0);
        expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
      });

      it("sends nothing while the campaign's answer to a DM waits for the pause", async () => {
        mockPrisma.dmLog.findFirst.mockImplementation(
          async (args: { where?: { commentId?: unknown; OR?: unknown[] } } = {}) =>
            args.where?.commentId &&
            JSON.stringify(args.where.OR).includes('"PENDING"')
              ? { id: "dm_row" }
              : null
        );

        await getProcessor()(fallback());

        expect(anyLinkSends()).toBe(0);
      });
    });
  });

  describe("the follow re-check acknowledgement", () => {
    const tapData = {
      instagramAccountId: "ig_456",
      userId: "commenter_999",
      payload: "followcheck:auto_789",
    };

    beforeEach(() => {
      vi.stubEnv("FOLLOW_RECHECK_ACK_MESSAGE", "Einen Moment, ich schaue nach");
      mockPrisma.automation.findFirst.mockResolvedValue(gated);
    });

    it("is skipped while the account is paused, and the re-check still waits", async () => {
      // The pause starts while this tap's follow check runs.
      mockGetUserFollowStatus.mockImplementation(async () => {
        await pauseFor(10);
        return false;
      });

      await expect(
        getProcessor()(createMockPostbackJob(tapData))
      ).resolves.toBeUndefined();

      expect(mockSendDirectMessage).not.toHaveBeenCalled();
      // Not even its once-per-cycle key is used up.
      expect(redis.commands.some((c) => c.startsWith("SET follow_recheck_ack:"))).toBe(false);
      expect(mockQueueAdd).toHaveBeenCalledWith(
        "process-postback",
        expect.objectContaining({ followRecheckAttempt: 1 }),
        expect.anything()
      );
    });

    it("pauses the account when it runs into the limit, and is not tried again", async () => {
      mockGetUserFollowStatus.mockResolvedValue(false);
      mockSendDirectMessage.mockRejectedValueOnce(limit(4));

      await expect(
        getProcessor()(createMockPostbackJob(tapData))
      ).resolves.toBeUndefined();

      await expect(redis.get(PAUSE_KEY)).resolves.toBe(String(NOW + 20 * MINUTE));
      expect(pauseEvents()).toHaveLength(1);
      expect(pauseCopies()).toHaveLength(0);
      expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    });
  });

  describe("a follow-up", () => {
    const withFollowUp = {
      ...mockAutomation,
      followUpEnabled: true,
      followUpMessage: "Danke, {username}!",
      followUpDelayMinutes: 30,
    };
    const followUpData = {
      instagramAccountId: "ig_456",
      accountConnectionId: "ig_account_row_1",
      userId: "commenter_999",
      automationId: "auto_789",
      commenterName: "commenter_user",
    };
    const followUp = (data: Record<string, unknown> = {}) => ({
      name: "process-followup",
      data: { ...followUpData, ...data },
      id: "followup_auto_789_commenter_999",
      attemptsMade: 0,
      timestamp: NOW - 30 * MINUTE,
    });

    beforeEach(() => {
      mockPrisma.automation.findFirst.mockResolvedValue(withFollowUp);
      mockPrisma.contact.findUnique.mockResolvedValue({
        lastInteractionAt: new Date(NOW - 31 * MINUTE),
      });
    });

    it("waits for the pause instead of calling Instagram", async () => {
      await pauseFor(10);

      await expect(getProcessor()(followUp())).resolves.toBeUndefined();

      expect(mockSendDirectMessage).not.toHaveBeenCalled();
      expect(mockPrisma.contact.findUnique).toHaveBeenCalledWith({
        where: { ...CONTACT_KEY, workspaceId: "workspace_123" },
        select: { lastInteractionAt: true },
      });
      expect(pauseCopies()).toEqual([
        [
          "process-followup",
          { ...followUpData, pauseRequeue: 1 },
          {
            jobId: "followup_auto_789_commenter_999_pause_1",
            delay: expect.any(Number),
            removeOnComplete: true,
          },
        ],
      ]);
    });

    it("pauses the account and waits when it is refused with a request limit, then goes out once", async () => {
      mockSendDirectMessage.mockRejectedValueOnce(limit(4));

      await expect(getProcessor()(followUp())).resolves.toBeUndefined();

      await expect(redis.get(PAUSE_KEY)).resolves.toBe(String(NOW + 20 * MINUTE));
      expect(pauseEvents()).toHaveLength(1);
      expect(pauseCopies()).toHaveLength(1);

      await getProcessor()(copyJob(pauseCopies()[0]));
      expect(mockSendDirectMessage).toHaveBeenCalledTimes(2);
      expect(pauseCopies()).toHaveLength(1);
    });

    it("is dropped when the window closes before the pause ends", async () => {
      mockPrisma.contact.findUnique.mockResolvedValue({
        lastInteractionAt: new Date(NOW - 23 * HOUR - 50 * MINUTE),
      });
      mockSendDirectMessage.mockRejectedValueOnce(limit(4));

      await expect(getProcessor()(followUp())).resolves.toBeUndefined();

      expect(pauseCopies()).toHaveLength(0);
    });

    it("is dropped without a contact to read the window from", async () => {
      await pauseFor(10);
      mockPrisma.contact.findUnique.mockResolvedValue(null);

      await getProcessor()(followUp());

      expect(pauseCopies()).toHaveLength(0);
    });

    it("is dropped after the twelfth wait", async () => {
      mockSendDirectMessage.mockRejectedValueOnce(limit(4));

      await expect(getProcessor()(followUp({ pauseRequeue: 12 }))).resolves.toBeUndefined();

      expect(pauseCopies()).toHaveLength(0);
    });

    it("never fails, so no retry can send it next to a copy queued after all", async () => {
      await pauseFor(10);
      mockQueueAdd.mockRejectedValue(new Error("Connection is closed."));
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

      await expect(getProcessor()(followUp())).resolves.toBeUndefined();

      expect(consoleError).toHaveBeenCalledWith(
        "[DM Worker] Follow-up not put back for the account's pause:",
        "Connection is closed."
      );
    });
  });

  describe("the reply to a DM", () => {
    const messageData = {
      instagramAccountId: "ig_456",
      messageId: "mid_abc",
      messageText: "can I get the LINK",
      senderId: "commenter_999",
    };
    const RECEIVED = NOW - 2000;
    const message = (data: Record<string, unknown> = {}) => ({
      name: "process-message",
      data: { ...messageData, ...data },
      id: "message_job_001",
      attemptsMade: 0,
      timestamp: RECEIVED,
    });
    const copyId = (n: number) =>
      `message_ig_456_${Buffer.from("mid_abc").toString("base64url")}_pause_${n}`;

    beforeEach(() => {
      mockPrisma.automation.findMany.mockResolvedValue([dmTriggerCampaign]);
    });

    it("waits for the pause without looking anything up, checking, reserving or claiming", async () => {
      await pauseFor(10);
      mockPrisma.automation.findMany.mockResolvedValue([
        { ...dmTriggerCampaign, requireFollow: true },
      ]);

      await expect(getProcessor()(message())).resolves.toBeUndefined();

      expect(mockGetUserFollowStatus).not.toHaveBeenCalled();
      expect(mockPrisma.contact.findUnique).not.toHaveBeenCalled();
      expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
      expect(mockPrisma.postbackDelivery.create).not.toHaveBeenCalled();
      expect(anyLinkSends()).toBe(0);
      // The DM opened the window: its sender is recorded with its time.
      expect(mockPrisma.contact.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ lastInteractionAt: new Date(RECEIVED) }),
        })
      );
      expect(mockPrisma.dmLog.updateMany).toHaveBeenCalledWith({
        where: {
          automationId: "auto_789",
          commentId: "dm:mid_abc",
          status: { not: "SENT" },
        },
        data: {
          status: "PENDING",
          errorMessage: expect.stringMatching(/^Instagram request limit; next try at 13:1\d UTC$/),
        },
      });
      expect(pauseCopies()).toEqual([
        [
          "process-message",
          { ...messageData, receivedAt: RECEIVED, pauseRequeue: 1 },
          { jobId: copyId(1), delay: expect.any(Number), removeOnComplete: true },
        ],
      ]);
    });

    it("pauses the account and waits when Instagram refuses the reply with a request limit", async () => {
      mockSendDirectMessage.mockRejectedValueOnce(limit(4));

      await expect(getProcessor()(message())).resolves.toBeUndefined();

      expect(mockPrisma.postbackDelivery.delete).toHaveBeenCalledWith({
        where: { id: replyClaim("mid_abc") },
      });
      expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalledWith(
        "workspace_123",
        usagePeriodStart
      );
      await expect(redis.get(PAUSE_KEY)).resolves.toBe(String(NOW + 20 * MINUTE));
      expect(pauseEvents()).toHaveLength(1);
      expect(mockPrisma.dmLog.upsert).not.toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({ status: "FAILED" }),
        })
      );
      expect(pauseCopies().map(([, , opts]) => opts.jobId)).toEqual([copyId(1)]);
      expect(afterLinkDelivered).not.toHaveBeenCalled();
    });

    it("answers the DM with the copy after the pause, as the same DM", async () => {
      mockSendDirectMessage.mockRejectedValueOnce(limit(4));
      await getProcessor()(message());

      await getProcessor()(copyJob(pauseCopies()[0]));

      expect(mockSendDirectMessage).toHaveBeenCalledTimes(2);
      expect(mockPrisma.postbackDelivery.create.mock.calls).toEqual([
        [{ data: { id: replyClaim("mid_abc") } }],
        [{ data: { id: replyClaim("mid_abc") } }],
      ]);
      // Counted from the DM, which opened the window.
      expect(mockPrisma.contact.upsert).toHaveBeenLastCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ lastInteractionAt: new Date(RECEIVED) }),
        })
      );
      expect(afterLinkDelivered).toHaveBeenCalledWith(
        expect.objectContaining({ via: "dm", interactionAt: RECEIVED, triggerId: "mid_abc" })
      );
    });

    it("never answers a DM twice when its copy and the redelivered DM race", async () => {
      realClaims();
      mockSendDirectMessage.mockRejectedValueOnce(limit(4));
      await getProcessor()(message());
      const copy = copyJob(pauseCopies()[0]);

      const process = getProcessor();
      await Promise.all([
        process(copy),
        process({ ...message(), id: "message_redelivered" }),
        process({ ...message(), attemptsMade: 1 }),
      ]);

      expect(mockSendDirectMessage).toHaveBeenCalledTimes(2);
    });

    it("lets the copy answer the campaigns after the one that met the limit", async () => {
      realClaims();
      const second = { ...dmTriggerCampaign, id: "auto_second" };
      mockPrisma.automation.findMany.mockResolvedValue([dmTriggerCampaign, second]);
      mockSendDirectMessage
        .mockResolvedValueOnce({ recipient_id: "commenter_999", message_id: "m1" })
        .mockRejectedValueOnce(limit(4));
      // The replies' rows, as they are written.
      const sent = new Set<string>();
      type RowKey = { automationId_commentId: { automationId: string } };
      mockPrisma.dmLog.upsert.mockImplementation(
        async ({ where, update }: { where: RowKey; update: { status?: string } }) => {
          if (update.status === "SENT") sent.add(where.automationId_commentId.automationId);
          return {};
        }
      );
      mockPrisma.dmLog.findUnique.mockImplementation(
        async ({ where }: { where: RowKey }) =>
          sent.has(where.automationId_commentId.automationId) ? { status: "SENT" } : null
      );

      await getProcessor()(message());
      expect(pauseCopies()).toHaveLength(1);

      await getProcessor()(copyJob(pauseCopies()[0]));

      // One reply per campaign.
      expect(mockSendDirectMessage).toHaveBeenCalledTimes(3);
      expect(mockPrisma.postbackDelivery.create).toHaveBeenLastCalledWith({
        data: { id: replyClaim("mid_abc", "auto_second") },
      });
    });

    it("waits when the follow check runs into the limit", async () => {
      mockPrisma.automation.findMany.mockResolvedValue([
        { ...dmTriggerCampaign, requireFollow: true },
      ]);
      mockGetUserFollowStatus.mockRejectedValueOnce(limit(4));

      await expect(getProcessor()(message())).resolves.toBeUndefined();

      expect(mockGetUserFollowStatus).toHaveBeenCalledWith(
        META_AUTH,
        "commenter_999",
        { throwOnLimit: true }
      );
      expect(mockSendDirectMessageWithButton).not.toHaveBeenCalled();
      expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
      expect(pauseCopies()).toHaveLength(1);
    });

    it("fails the reply after the twelfth wait, as a refused send", async () => {
      mockSendDirectMessage.mockRejectedValueOnce(limit(4));

      await expect(getProcessor()(message({ pauseRequeue: 12 }))).rejects.toMatchObject({
        name: "RateLimitError",
      });

      expect(pauseCopies()).toHaveLength(0);
      expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: {
            status: "FAILED",
            attempts: 1,
            errorMessage: expect.stringMatching(
              /^Instagram request limit: the account was still paused after 12 waits \(until 13:20 UTC\), so the DM was not sent\. /
            ),
          },
        })
      );
    });

    it("gives up without calling Instagram when the thirteenth try still finds the pause", async () => {
      await pauseFor(10);

      await expect(getProcessor()(message({ pauseRequeue: 12 }))).rejects.toMatchObject({
        name: "AccountPausedError",
      });

      expect(anyLinkSends()).toBe(0);
      expect(pauseCopies()).toHaveLength(0);
    });

    describe("a copy whose campaign no longer answers the DM", () => {
      const settledFor = (account: Record<string, unknown>, notIn?: string[]) => ({
        where: {
          commentId: "dm:mid_abc",
          status: "PENDING",
          ...account,
          ...(notIn ? { automationId: { notIn } } : {}),
        },
        data: {
          status: "FAILED",
          errorMessage: "Not sent: the campaign was paused or changed while the account was paused",
        },
      });

      it("logs the reply that waited FAILED when the campaign was paused or its DM trigger switched off", async () => {
        // Neither is found any more by the campaigns' query.
        mockPrisma.automation.findMany.mockResolvedValue([]);

        await expect(
          getProcessor()(
            message({ receivedAt: RECEIVED, pauseRequeue: 1, accountConnectionId: "ig_account_row_1" })
          )
        ).resolves.toBeUndefined();

        expect(mockPrisma.dmLog.updateMany).toHaveBeenCalledWith(
          settledFor({ instagramAccountId: "ig_account_row_1" })
        );
        expect(anyLinkSends()).toBe(0);

        // A job from before connections were bound names the account itself.
        await getProcessor()(message({ receivedAt: RECEIVED, pauseRequeue: 1 }));
        expect(mockPrisma.dmLog.updateMany).toHaveBeenLastCalledWith(
          settledFor({ instagramAccount: { instagramId: "ig_456" } })
        );
      });

      it("logs it FAILED when the campaign's keywords no longer match, and answers the campaigns that do", async () => {
        const second = { ...dmTriggerCampaign, id: "auto_second" };
        mockPrisma.automation.findMany.mockResolvedValue([dmTriggerCampaign, second]);
        mockMatchKeywords
          .mockReturnValueOnce({ matched: false, matchedKeyword: null })
          .mockReturnValueOnce({ matched: true, matchedKeyword: "LINK" });

        await getProcessor()(
          message({ receivedAt: RECEIVED, pauseRequeue: 1, accountConnectionId: "ig_account_row_1" })
        );

        expect(mockPrisma.dmLog.updateMany).toHaveBeenCalledWith(
          settledFor({ instagramAccountId: "ig_account_row_1" }, ["auto_second"])
        );
        // The settling comes first, whichever way the copy ends.
        expect(mockPrisma.dmLog.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
          mockSendDirectMessage.mock.invocationCallOrder[0]
        );
        expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
        expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { automationId_commentId: { automationId: "auto_second", commentId: "dm:mid_abc" } },
            update: expect.objectContaining({ status: "SENT" }),
          })
        );
      });

      it("touches nothing for a DM that never waited", async () => {
        mockPrisma.automation.findMany.mockResolvedValue([]);

        await getProcessor()(message());

        expect(mockPrisma.dmLog.updateMany).not.toHaveBeenCalled();
      });
    });

    it("logs the reply FAILED when the window closes before the pause ends", async () => {
      const longAgo = NOW - 23 * HOUR - 50 * MINUTE;
      mockSendDirectMessage.mockRejectedValueOnce(limit(4));

      await expect(
        getProcessor()(message({ receivedAt: longAgo, pauseRequeue: 3 }))
      ).resolves.toBeUndefined();

      expect(pauseCopies()).toHaveLength(0);
      expect(mockPrisma.dmLog.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: {
            status: "FAILED",
            errorMessage:
              "Instagram request limit: the messaging window closes before the account's pause ends (13:20 UTC), so the DM was not sent",
          },
        })
      );
    });
  });
});

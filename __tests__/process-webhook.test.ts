/**
 * Webhook intake — what a payload costs before any job runs.
 *
 * Every DM the account sends comes back as an echo, and every message a person
 * reads comes back as a read receipt. Both arrive far more often than the
 * comments, taps and DMs that need work, so they must neither wake the database
 * nor queue jobs that would only return without doing anything.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, queueAdd } = vi.hoisted(() => ({
  mockPrisma: {
    instagramAccount: { findMany: vi.fn() },
    webhookEvent: { create: vi.fn(), update: vi.fn() },
    dmLog: { findMany: vi.fn() },
  },
  queueAdd: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/queue/client", () => ({
  getDMQueue: () => ({ add: queueAdd }),
  COMMENT_JOB_NAME: "process-comment",
  POSTBACK_JOB_NAME: "process-postback",
  MESSAGE_JOB_NAME: "process-message",
}));

import { processInstagramWebhook } from "../lib/queue/process-webhook";

type Payload = Parameters<typeof processInstagramWebhook>[0]["payload"];
type Messaging = NonNullable<Payload["entry"][number]["messaging"]>[number];

const ACCOUNT = "ig_456";
const READER = "reader_1";

function messagingPayload(event: Messaging): Payload {
  return {
    object: "instagram",
    entry: [{ id: ACCOUNT, time: 1, messaging: [event] }],
  };
}

function prismaCallCount(): number {
  return Object.values(mockPrisma)
    .flatMap((model) => Object.values(model))
    .reduce((total, fn) => total + fn.mock.calls.length, 0);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.instagramAccount.findMany.mockResolvedValue([
    { id: "account_row_1", instagramId: ACCOUNT, workspaceId: "workspace_1" },
  ]);
  mockPrisma.webhookEvent.create.mockResolvedValue({ id: "webhook_event_1" });
  mockPrisma.webhookEvent.update.mockResolvedValue({});
  mockPrisma.dmLog.findMany.mockResolvedValue([]);
  queueAdd.mockResolvedValue({});
});

describe("payloads with nothing to do", () => {
  it("returns on an echo of the account's own DM before any query", async () => {
    await processInstagramWebhook({
      payload: messagingPayload({
        sender: { id: ACCOUNT },
        recipient: { id: READER },
        message: { mid: "echo_mid", text: "Here is your guide", is_echo: true },
      }),
      provider: "META",
    });

    expect(prismaCallCount()).toBe(0);
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it("still records and queues a payload that carries a comment", async () => {
    await processInstagramWebhook({
      payload: {
        object: "instagram",
        entry: [
          {
            id: ACCOUNT,
            time: 1,
            changes: [
              {
                field: "comments",
                value: {
                  id: "comment_1",
                  text: "LINK please",
                  from: { id: READER, username: "reader" },
                  media: { id: "media_1" },
                },
              },
            ],
          },
        ],
      },
      provider: "META",
    });

    expect(mockPrisma.webhookEvent.create).toHaveBeenCalledTimes(1);
    expect(queueAdd).toHaveBeenCalledWith(
      "process-comment",
      expect.objectContaining({ commentId: "comment_1", commenterId: READER }),
      { jobId: `comment_${ACCOUNT}_comment_1` }
    );
  });
});

describe("read receipts", () => {
  const readReceipt = messagingPayload({
    sender: { id: READER },
    recipient: { id: ACCOUNT },
    read: { watermark: 1 },
  });

  it("queue no read fallback for a campaign whose link the reader already got by tapping", async () => {
    mockPrisma.dmLog.findMany.mockResolvedValue([
      { commentId: "comment_1", automation: { id: "campaign_1" } },
      { commentId: `reveal:${READER}`, automation: { id: "campaign_1" } },
    ]);

    await processInstagramWebhook({ payload: readReceipt, provider: "META" });

    expect(queueAdd).not.toHaveBeenCalled();
    // The tap rows come with the one query that finds the campaigns.
    expect(mockPrisma.dmLog.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.dmLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ commenterId: READER, status: "SENT" }),
        select: expect.objectContaining({ commentId: true }),
      })
    );
  });

  it("queue exactly one read fallback when only the opening DM went out", async () => {
    mockPrisma.dmLog.findMany.mockResolvedValue([
      { commentId: "comment_1", automation: { id: "campaign_1" } },
    ]);

    await processInstagramWebhook({ payload: readReceipt, provider: "META" });

    expect(queueAdd).toHaveBeenCalledTimes(1);
    expect(queueAdd).toHaveBeenCalledWith(
      "process-postback",
      {
        instagramAccountId: ACCOUNT,
        accountConnectionId: "account_row_1",
        userId: READER,
        payload: "reveal:campaign_1",
        fallback: true,
      },
      {
        delay: 5 * 60 * 1000,
        jobId: `read_fallback_${ACCOUNT}_${READER}_campaign_1`,
      }
    );
  });

  it("skips only the campaign whose link was already delivered", async () => {
    mockPrisma.dmLog.findMany.mockResolvedValue([
      { commentId: "comment_1", automation: { id: "campaign_1" } },
      { commentId: `reveal:${READER}`, automation: { id: "campaign_1" } },
      { commentId: "comment_2", automation: { id: "campaign_2" } },
    ]);

    await processInstagramWebhook({ payload: readReceipt, provider: "META" });

    expect(queueAdd).toHaveBeenCalledTimes(1);
    expect(queueAdd).toHaveBeenCalledWith(
      "process-postback",
      expect.objectContaining({ payload: "reveal:campaign_2" }),
      expect.anything()
    );
  });

  // The answer to a DM keyword is no opening DM: it carried the link, or a
  // follow prompt with its own button, so a fallback would send the link again.
  it("queues no read fallback for the answer to a DM keyword", async () => {
    mockPrisma.dmLog.findMany.mockResolvedValue([
      { commentId: "dm:mid_1", automation: { id: "campaign_1" } },
    ]);

    await processInstagramWebhook({ payload: readReceipt, provider: "META" });

    expect(queueAdd).not.toHaveBeenCalled();
  });

  // The reader answered the opening DM by typing the keyword, and the
  // campaign's DM trigger answered that: the fallback job would only return.
  it("queues no read fallback for a campaign whose DM trigger already answered the reader", async () => {
    mockPrisma.dmLog.findMany.mockResolvedValue([
      { commentId: "comment_1", automation: { id: "campaign_1" } },
      { commentId: "dm:mid_typed", automation: { id: "campaign_1" } },
      { commentId: "comment_2", automation: { id: "campaign_2" } },
    ]);

    await processInstagramWebhook({ payload: readReceipt, provider: "META" });

    expect(queueAdd).toHaveBeenCalledTimes(1);
    expect(queueAdd).toHaveBeenCalledWith(
      "process-postback",
      expect.objectContaining({ payload: "reveal:campaign_2", fallback: true }),
      expect.anything()
    );
    expect(mockPrisma.dmLog.findMany).toHaveBeenCalledTimes(1);
  });

  it("queues a read fallback only for the campaign whose opening DM went out", async () => {
    mockPrisma.dmLog.findMany.mockResolvedValue([
      { commentId: "dm:mid_1", automation: { id: "campaign_1" } },
      { commentId: "comment_2", automation: { id: "campaign_2" } },
    ]);

    await processInstagramWebhook({ payload: readReceipt, provider: "META" });

    expect(queueAdd).toHaveBeenCalledTimes(1);
    expect(queueAdd).toHaveBeenCalledWith(
      "process-postback",
      expect.objectContaining({ payload: "reveal:campaign_2", fallback: true }),
      {
        delay: 5 * 60 * 1000,
        jobId: `read_fallback_${ACCOUNT}_${READER}_campaign_2`,
      }
    );
  });
});

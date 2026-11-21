/**
 * The offer engine: start, offer messages, the tap on "yes, send it",
 * confirmations, card and reminder.
 *
 * Every new trigger of a campaign (a new tap or DM that brings its link)
 * starts the next offer the person has not had; a repeat of the same trigger
 * (a redelivered webhook, a retried job) starts nothing, and nobody gets an
 * offer twice. Each message is claimed before it is sent, so a retried or
 * repeated job continues the sequence without sending anything twice, and
 * Instagram's refusals end the offer quietly instead of raising worker alerts.
 * A campaign can also start its offer 22 hours after the link: that start
 * never creates the contact, and its offer gets no reminder.
 */

import { createHash } from "node:crypto";
import type { Job } from "bullmq";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockPrisma,
  mockSendDirectMessage,
  mockSendDirectMessageWithButton,
  mockSendDirectMessageWithLinkButton,
  mockSendDirectMessageWithCard,
  mockDecryptToken,
  mockQueueAdd,
  mockQueueRemove,
  mockReserveWorkspaceDMSend,
  mockReleaseWorkspaceDMReservation,
} = vi.hoisted(() => ({
  mockPrisma: {
    automation: { findFirst: vi.fn() },
    contact: { upsert: vi.fn(), updateMany: vi.fn(), findFirst: vi.fn() },
    contactTag: { createMany: vi.fn() },
    contactOffer: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    offer: { findMany: vi.fn(), updateMany: vi.fn() },
    postbackDelivery: { create: vi.fn(), delete: vi.fn() },
    operationalEvent: { create: vi.fn() },
    zernioConnection: { findUnique: vi.fn() },
  },
  mockSendDirectMessage: vi.fn(),
  mockSendDirectMessageWithButton: vi.fn(),
  mockSendDirectMessageWithLinkButton: vi.fn(),
  mockSendDirectMessageWithCard: vi.fn(),
  mockDecryptToken: vi.fn(),
  mockQueueAdd: vi.fn(),
  mockQueueRemove: vi.fn(),
  mockReserveWorkspaceDMSend: vi.fn(),
  mockReleaseWorkspaceDMReservation: vi.fn(),
}));
// Redis, for the account pause (lib/queue/account-pause.ts): a new, empty
// FakeRedis for every test.
const redis = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));

// Closed: a Meta function the engine starts to use without a mock here fails
// the suite instead of calling Instagram.
vi.mock("@/lib/meta/client", () => {
  class MetaApiError extends Error {
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
  }
  class TokenExpiredError extends MetaApiError {
    constructor(message: string) {
      super(190, undefined, undefined, message);
      this.name = "TokenExpiredError";
    }
  }
  class RateLimitError extends MetaApiError {
    constructor(message: string) {
      super(368, undefined, undefined, message);
      this.name = "RateLimitError";
    }
  }
  return {
    sendDirectMessage: mockSendDirectMessage,
    sendDirectMessageWithButton: mockSendDirectMessageWithButton,
    sendDirectMessageWithLinkButton: mockSendDirectMessageWithLinkButton,
    sendDirectMessageWithCard: mockSendDirectMessageWithCard,
    MetaApiError,
    TokenExpiredError,
    RateLimitError,
  };
});

vi.mock("@/lib/meta/oauth", () => ({ decryptToken: mockDecryptToken }));

vi.mock("@/lib/queue/client", () => ({
  getDMQueue: () => ({ add: mockQueueAdd, remove: mockQueueRemove }),
  getRedisConnection: () => redis.current,
  OFFER_JOB_NAME: "process-offer",
  POSTBACK_JOB_NAME: "process-postback",
}));

vi.mock("@/lib/billing/usage", () => ({
  reserveWorkspaceDMSend: mockReserveWorkspaceDMSend,
  releaseWorkspaceDMReservation: mockReleaseWorkspaceDMReservation,
}));

import {
  MetaApiError,
  RateLimitError,
  TokenExpiredError,
} from "@/lib/meta/client";
import { cancelOfferJob, enqueueOfferStart } from "@/lib/offers/jobs";
import { OFFER_ORDER } from "@/lib/offers/schedule";
import { processOffer, processOfferTap } from "@/lib/offers/worker";
import type { ProcessOfferJob, ProcessPostbackJob } from "@/lib/queue/client";
import { hashRecipientId } from "@/lib/tracking/server";
import { FakeRedis } from "./helpers/fake-redis";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.parse("2026-11-20T12:10:00.000Z");
const TAP_TIME = NOW - MINUTE;
const USAGE_PERIOD = new Date("2026-11-01T00:00:00.000Z");
const TOKEN = hashRecipientId("commenter_999");

const META_AUTH = expect.objectContaining({
  provider: "META",
  accessToken: "decrypted_token",
});

const JOB_BASE = {
  workspaceId: "workspace_123",
  accountConnectionId: "ig_account_row_1",
  instagramAccountId: "ig_456",
};

const ACCOUNT = {
  id: "ig_account_row_1",
  workspaceId: "workspace_123",
  instagramId: "ig_456",
  username: "brand",
  name: null,
  provider: "META",
  metaLogin: "INSTAGRAM",
  zernioAccountId: null,
  accessToken: "encrypted_token_abc",
  tokenExpiresAt: null,
  webhookSubscribed: true,
  connectedAt: new Date(0),
  updatedAt: new Date(0),
};

const OFFER = {
  id: "offer_a",
  workspaceId: "workspace_123",
  name: "Guide",
  isActive: true,
  position: 0,
  archivedAt: null as Date | null,
  offerMessages: [
    "Ich hab übrigens noch einen Guide, {username}.",
    "Er hilft dir weiter.",
    "Soll ich ihn dir schicken?",
  ],
  offerDelaysSeconds: [5, 3, 2],
  offerButtonLabel: "Ja, gerne! 🙌",
  confirmationMessages: ["Alles klar!", "Hier geht's zum Guide 👇"],
  confirmationDelaysSeconds: [3, 3],
  cardImageUrl: "https://cdn.example.com/cover.jpg" as string | null,
  cardTitle: "Prompting Guide",
  cardSubtitle: "In 7 Schritten" as string | null,
  cardButtonLabel: "Jetzt holen",
  destinationUrl: "https://example.com/guide",
  linkSlug: "guide_slug",
  reminderEnabled: true,
  reminderDelayHours: 23,
  reminderMessage: "Hey, nur kurz zur Info 👇" as string | null,
  tagOffered: "Guide angeboten",
  tagInterested: "Guide Interesse",
  tagSent: "Guide gesendet",
  tagClicked: "Guide geklickt",
  signupTrackingEnabled: false,
  signupMessage: null as string | null,
  tagSignedUp: "Guide eingetragen",
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const CONTACT = {
  id: "contact_1",
  workspaceId: "workspace_123",
  instagramAccountId: "ig_account_row_1",
  igsid: "commenter_999",
  username: "commenter_user" as string | null,
  recipientHash: TOKEN,
  lastInteractionAt: new Date(TAP_TIME) as Date | null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  instagramAccount: ACCOUNT,
};

/** A ContactOffer row as the engine loads it, with its offer and contact. */
function contactOffer(
  overrides: Record<string, unknown> = {},
  offer: Partial<typeof OFFER> = {},
  contact: Partial<typeof CONTACT> = {}
) {
  return {
    id: "co1",
    workspaceId: "workspace_123",
    contactId: "contact_1",
    offerId: "offer_a",
    automationId: "auto_789",
    startKey: "auto_789:tap:mid_tap_1",
    lateStart: false,
    offeredAt: new Date(TAP_TIME + 1000),
    pitchSentAt: null,
    interestedAt: null,
    interestedMid: null,
    sentAt: null,
    sentVia: null,
    reminderSentAt: null,
    clickedAt: null,
    stoppedAt: null,
    stopReason: null,
    signupToken: null,
    signedUpAt: null,
    signupMessageSentAt: null,
    ...overrides,
    offer: { ...OFFER, ...offer },
    contact: { ...CONTACT, ...contact },
  };
}

function offerJob(
  data: Partial<ProcessOfferJob>,
  job: { attemptsMade?: number; timestamp?: number; id?: string } = {}
) {
  return {
    name: "process-offer",
    id: "offer_job_1",
    attemptsMade: 0,
    opts: { attempts: 3 },
    timestamp: NOW,
    ...job,
    data: { ...JOB_BASE, ...data },
  } as unknown as Job<ProcessOfferJob>;
}

function startJob(
  startKey = "auto_789:tap:mid_tap_1",
  job: { attemptsMade?: number; timestamp?: number } = {}
) {
  return offerJob(
    {
      phase: "start",
      automationId: "auto_789",
      userId: "commenter_999",
      interactionAt: TAP_TIME,
      startKey,
    },
    job
  );
}

function tapJob(
  data: Partial<ProcessPostbackJob> = {},
  job: { attemptsMade?: number; id?: string } = {}
) {
  return {
    name: "process-postback",
    id: "postback_ig_456_commenter_999_mid_yes",
    attemptsMade: 0,
    opts: { attempts: 3 },
    timestamp: NOW,
    ...job,
    data: {
      instagramAccountId: "ig_456",
      accountConnectionId: "ig_account_row_1",
      userId: "commenter_999",
      payload: "offer:co1",
      mid: "mid_yes",
      ...data,
    },
  } as unknown as Job<ProcessPostbackJob>;
}

/** The claim of one message, as the engine names it. */
function claimId(phase: string, step: number | string, coId = "co1") {
  return createHash("sha256")
    .update(JSON.stringify(["ig_account_row_1", "offer", coId, phase, step]))
    .digest("hex");
}

/** The next job a step queues for the row co1. */
function next(
  phase: ProcessOfferJob["phase"],
  extra: Partial<ProcessOfferJob>,
  options: { jobId: string; delay?: number }
) {
  return [
    "process-offer",
    { ...JOB_BASE, contactOfferId: "co1", phase, ...extra },
    { ...options, removeOnComplete: true },
  ];
}

function tagWrite(tag: string) {
  return {
    data: [{ workspaceId: "workspace_123", contactId: "contact_1", tag }],
    skipDuplicates: true,
  };
}

// A stop never marks an offer whose link reached the person: sentAt null.
function stopWrite(reason: string) {
  return {
    where: { id: "co1", stoppedAt: null, sentAt: null },
    data: { stoppedAt: new Date(NOW), stopReason: reason },
  };
}

function event(level: string, message: string, payload: Record<string, unknown> = {}) {
  return {
    data: {
      workspaceId: "workspace_123",
      source: "WORKER",
      level,
      message,
      payload: expect.objectContaining({
        contactOfferId: "co1",
        offerId: "offer_a",
        userId: "commenter_999",
        ...payload,
      }),
    },
  };
}

const SENT = { recipient_id: "commenter_999", message_id: "m_1" };

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  // No account is paused for a Meta request limit.
  redis.current = new FakeRedis();

  mockPrisma.automation.findFirst.mockReset().mockResolvedValue({
    id: "auto_789",
    offersEnabled: true,
    offerIds: [],
    instagramAccount: { instagramId: "ig_456" },
  });
  mockPrisma.contact.upsert.mockReset().mockResolvedValue({
    id: "contact_1",
    username: "commenter_user",
    lastInteractionAt: null,
  });
  mockPrisma.contact.updateMany.mockReset().mockResolvedValue({ count: 1 });
  mockPrisma.contact.findFirst.mockReset().mockResolvedValue(null);
  mockPrisma.contactTag.createMany.mockReset().mockResolvedValue({ count: 1 });
  mockPrisma.contactOffer.findUnique.mockReset().mockResolvedValue(null);
  mockPrisma.contactOffer.findFirst.mockReset().mockResolvedValue(null);
  mockPrisma.contactOffer.findMany.mockReset().mockResolvedValue([]);
  mockPrisma.contactOffer.create
    .mockReset()
    .mockImplementation(async ({ data }: { data: { offerId: string } }) =>
      started(data.offerId)
    );
  mockPrisma.contactOffer.updateMany.mockReset().mockResolvedValue({ count: 1 });
  mockPrisma.offer.findMany
    .mockReset()
    .mockResolvedValue([
      { id: "offer_a", firstOfferedAt: null },
      { id: "offer_b", firstOfferedAt: null },
      { id: "offer_c", firstOfferedAt: null },
    ]);
  mockPrisma.offer.updateMany.mockReset().mockResolvedValue({ count: 1 });
  mockPrisma.postbackDelivery.create.mockReset().mockResolvedValue({});
  mockPrisma.postbackDelivery.delete.mockReset().mockResolvedValue({});
  mockPrisma.operationalEvent.create.mockReset().mockResolvedValue({});

  mockSendDirectMessage.mockReset().mockResolvedValue(SENT);
  mockSendDirectMessageWithButton.mockReset().mockResolvedValue(SENT);
  mockSendDirectMessageWithLinkButton.mockReset().mockResolvedValue(SENT);
  mockSendDirectMessageWithCard.mockReset().mockResolvedValue(SENT);
  mockDecryptToken.mockReturnValue("decrypted_token");
  mockQueueAdd.mockReset().mockResolvedValue({});
  mockQueueRemove.mockReset().mockResolvedValue(1);
  mockReserveWorkspaceDMSend.mockReset().mockResolvedValue({
    allowed: true,
    reserved: true,
    remaining: 100,
    limit: 2000,
    periodStart: USAGE_PERIOD,
  });
  mockReleaseWorkspaceDMReservation.mockReset().mockResolvedValue({ count: 1 });
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** What contactOffer.create returns for a start: the row with its offer. */
function started(offerId: string) {
  return {
    id: `co_${offerId}`,
    offeredAt: new Date(),
    offer: { tagOffered: `${offerId} angeboten`, offerDelaysSeconds: [5, 3, 2] },
  };
}

// Zernio's own limit: a RateLimitError with HTTP 429 as its code
// (lib/zernio/client.ts), which is no Meta request limit.
function zernioLimit() {
  return Object.assign(new RateLimitError("Zernio request failed (HTTP 429)"), {
    code: 429,
  });
}

function sends() {
  return (
    mockSendDirectMessage.mock.calls.length +
    mockSendDirectMessageWithButton.mock.calls.length +
    mockSendDirectMessageWithLinkButton.mock.calls.length +
    mockSendDirectMessageWithCard.mock.calls.length
  );
}

describe("start", () => {
  it("records the first active offer in the workspace's order for this trigger", async () => {
    await processOffer(startJob());

    expect(mockPrisma.offer.findMany).toHaveBeenCalledWith({
      where: { workspaceId: "workspace_123", isActive: true, archivedAt: null },
      orderBy: OFFER_ORDER,
      select: { id: true, firstOfferedAt: true },
    });
    expect(mockPrisma.contactOffer.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.contactOffer.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          workspaceId: "workspace_123",
          contactId: "contact_1",
          offerId: "offer_a",
          automationId: "auto_789",
          startKey: "auto_789:tap:mid_tap_1",
          // Started right after the link: its reminder follows.
          lateStart: false,
          offeredAt: new Date(NOW),
        },
      })
    );
  });

  // The mark outlives the offer's rows, which go with their contacts when an
  // account is disconnected: deleting the offer then still archives it.
  it("marks an offer as offered before its first row is written", async () => {
    await processOffer(startJob());

    expect(mockPrisma.offer.updateMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.offer.updateMany).toHaveBeenCalledWith({
      where: { id: "offer_a", workspaceId: "workspace_123", firstOfferedAt: null },
      data: { firstOfferedAt: new Date(NOW) },
    });
    expect(mockPrisma.offer.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      mockPrisma.contactOffer.create.mock.invocationCallOrder[0]
    );
  });

  it("does not mark an offer that was offered before again", async () => {
    mockPrisma.offer.findMany.mockResolvedValue([
      { id: "offer_a", firstOfferedAt: new Date(NOW - HOUR) },
    ]);

    await processOffer(startJob());

    expect(mockPrisma.contactOffer.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.offer.updateMany).not.toHaveBeenCalled();
  });

  it("writes the offered tag and queues the first message after its delay", async () => {
    await processOffer(startJob());

    expect(mockPrisma.contactTag.createMany).toHaveBeenCalledWith(
      tagWrite("offer_a angeboten")
    );
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    expect(mockQueueAdd).toHaveBeenCalledWith(
      "process-offer",
      { ...JOB_BASE, phase: "offer", contactOfferId: "co_offer_a", step: 0 },
      { jobId: "offer_co_offer_a_offer_0", delay: 5000, removeOnComplete: true }
    );
    expect(sends()).toBe(0);
  });

  it("records the contact with the time of the tap or DM behind the delivery", async () => {
    await processOffer(startJob());

    expect(mockPrisma.contact.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          instagramAccountId_igsid: {
            instagramAccountId: "ig_account_row_1",
            igsid: "commenter_999",
          },
        },
        create: expect.objectContaining({ lastInteractionAt: new Date(TAP_TIME) }),
      })
    );
  });

  it("follows the campaign's own order", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue({
      id: "auto_789",
      offersEnabled: true,
      offerIds: ["offer_c", "offer_a"],
      instagramAccount: { instagramId: "ig_456" },
    });

    await processOffer(startJob());

    expect(mockPrisma.contactOffer.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ offerId: "offer_c" }) })
    );
  });

  // Paused and deleted offers are not in the active list the engine reads.
  it("skips paused, deleted and unknown offers of the campaign's order", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue({
      id: "auto_789",
      offersEnabled: true,
      offerIds: ["offer_paused", "offer_deleted", "offer_unknown", "offer_b"],
      instagramAccount: { instagramId: "ig_456" },
    });

    await processOffer(startJob());

    expect(mockPrisma.contactOffer.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.contactOffer.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ offerId: "offer_b" }) })
    );
  });

  it("skips offers this person had before, from whichever campaign", async () => {
    mockPrisma.contactOffer.findMany.mockResolvedValue([{ offerId: "offer_a" }]);

    await processOffer(startJob());

    expect(mockPrisma.contactOffer.findMany).toHaveBeenCalledWith({
      where: { contactId: "contact_1" },
      select: { offerId: true },
    });
    expect(mockPrisma.contactOffer.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.contactOffer.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ offerId: "offer_b" }) })
    );
  });

  it("moves on to the next offer when another start took one a moment ago", async () => {
    mockPrisma.contactOffer.create.mockRejectedValueOnce({ code: "P2002" });

    await processOffer(startJob());

    expect(mockPrisma.contactOffer.create).toHaveBeenCalledTimes(2);
    expect(mockPrisma.contactOffer.create.mock.calls[1][0].data.offerId).toBe("offer_b");
    expect(mockQueueAdd).toHaveBeenCalledWith(
      "process-offer",
      expect.objectContaining({ contactOfferId: "co_offer_b" }),
      expect.anything()
    );
  });

  it("returns when a concurrent run of the same start created its row", async () => {
    mockPrisma.contactOffer.create.mockRejectedValueOnce({ code: "P2002" });
    mockPrisma.contactOffer.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "co_concurrent" });

    await processOffer(startJob());

    expect(mockPrisma.contactOffer.findUnique).toHaveBeenLastCalledWith({
      where: {
        contactId_startKey: {
          contactId: "contact_1",
          startKey: "auto_789:tap:mid_tap_1",
        },
      },
      select: { id: true },
    });
    expect(mockPrisma.contactOffer.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.contactTag.createMany).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("rethrows a database error other than a taken key", async () => {
    const lost = new Error("Connection terminated unexpectedly");
    mockPrisma.contactOffer.create.mockRejectedValueOnce(lost);

    await expect(processOffer(startJob())).rejects.toBe(lost);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("does nothing for a trigger that started an offer before this job was queued", async () => {
    mockPrisma.contactOffer.findUnique.mockResolvedValue({
      id: "co1",
      offeredAt: new Date(NOW - 1000),
      offer: { tagOffered: "Guide angeboten", offerDelaysSeconds: [5] },
    });

    await processOffer(startJob());

    expect(mockPrisma.contactOffer.create).not.toHaveBeenCalled();
    expect(mockPrisma.contactTag.createMany).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("carries on when its own earlier attempt created the row", async () => {
    mockPrisma.contactOffer.findUnique.mockResolvedValue({
      id: "co1",
      offeredAt: new Date(NOW),
      offer: { tagOffered: "Guide angeboten", offerDelaysSeconds: [5] },
    });

    await processOffer(startJob("auto_789:tap:mid_tap_1", { attemptsMade: 1 }));

    expect(mockPrisma.contactOffer.create).not.toHaveBeenCalled();
    expect(mockPrisma.contactTag.createMany).toHaveBeenCalledWith(
      tagWrite("Guide angeboten")
    );
    expect(mockQueueAdd).toHaveBeenCalledWith(
      ...next("offer", { step: 0 }, { jobId: "offer_co1_offer_0", delay: 5000 })
    );
  });

  it("writes an INFO event and creates nothing when the window has closed", async () => {
    await processOffer(
      offerJob({
        phase: "start",
        automationId: "auto_789",
        userId: "commenter_999",
        interactionAt: NOW - 25 * HOUR,
        startKey: "auto_789:tap:mid_old",
      })
    );

    expect(mockPrisma.contactOffer.create).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(mockPrisma.operationalEvent.create).toHaveBeenCalledWith({
      data: {
        workspaceId: "workspace_123",
        source: "WORKER",
        level: "INFO",
        message: "Offer skipped: messaging window closed",
        payload: { automationId: "auto_789", userId: "commenter_999" },
      },
    });
  });

  it("does nothing once the person has had every offer", async () => {
    mockPrisma.contactOffer.findMany.mockResolvedValue([
      { offerId: "offer_a" },
      { offerId: "offer_b" },
      { offerId: "offer_c" },
    ]);

    await processOffer(startJob());

    expect(mockPrisma.contactOffer.create).not.toHaveBeenCalled();
    expect(mockPrisma.contactTag.createMany).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(mockPrisma.operationalEvent.create).not.toHaveBeenCalled();
  });

  it("does not need the campaign to be active", async () => {
    await processOffer(startJob());

    expect(mockPrisma.automation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "auto_789",
          instagramAccountId: "ig_account_row_1",
          workspaceId: "workspace_123",
        },
      })
    );
    expect(mockPrisma.contactOffer.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: "an unknown campaign", campaign: null },
    {
      label: "a campaign whose offers were switched off",
      campaign: {
        id: "auto_789",
        offersEnabled: false,
        offerIds: [],
        instagramAccount: { instagramId: "ig_456" },
      },
    },
    {
      label: "a campaign on another Instagram account",
      campaign: {
        id: "auto_789",
        offersEnabled: true,
        offerIds: [],
        instagramAccount: { instagramId: "ig_other" },
      },
    },
  ])("starts nothing for $label", async ({ campaign }) => {
    mockPrisma.automation.findFirst.mockResolvedValue(campaign);

    await processOffer(startJob());

    expect(mockPrisma.contact.upsert).not.toHaveBeenCalled();
    expect(mockPrisma.contactOffer.create).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  // The user's decision D1, against a ContactOffer table that enforces the
  // same unique keys as the database.
  describe("one offer per trigger", () => {
    type Row = {
      id: string;
      contactId: string;
      offerId: string;
      automationId: string;
      startKey: string;
      offeredAt: Date;
    };

    function contactOfferTable(): Row[] {
      const rows: Row[] = [];
      const asStarted = (row: Row) => ({
        id: row.id,
        offeredAt: row.offeredAt,
        offer: { tagOffered: `${row.offerId} angeboten`, offerDelaysSeconds: [5] },
      });
      mockPrisma.contactOffer.findUnique.mockImplementation(
        async ({ where }: { where: { contactId_startKey: { contactId: string; startKey: string } } }) => {
          const { contactId, startKey } = where.contactId_startKey;
          const row = rows.find((r) => r.contactId === contactId && r.startKey === startKey);
          return row ? asStarted(row) : null;
        }
      );
      mockPrisma.contactOffer.findMany.mockImplementation(
        async ({ where }: { where: { contactId: string } }) =>
          rows.filter((r) => r.contactId === where.contactId).map((r) => ({ offerId: r.offerId }))
      );
      mockPrisma.contactOffer.create.mockImplementation(
        async ({ data }: { data: Omit<Row, "id"> }) => {
          const taken = rows.some(
            (r) =>
              r.contactId === data.contactId &&
              (r.offerId === data.offerId || r.startKey === data.startKey)
          );
          if (taken) throw { code: "P2002" };
          const row = { id: `co_${rows.length + 1}`, ...data };
          rows.push(row);
          return asStarted(row);
        }
      );
      return rows;
    }

    const offered = (rows: Row[]) => rows.map((r) => [r.startKey, r.offerId]);
    const firstMessages = () =>
      mockQueueAdd.mock.calls.map(([, data]) => data.contactOfferId);

    it("starts the next offer for a second comment's tap and for a DM of the same campaign", async () => {
      const rows = contactOfferTable();

      await processOffer(startJob("auto_789:tap:mid_first_comment"));
      await processOffer(startJob("auto_789:tap:mid_second_comment"));
      await processOffer(startJob("auto_789:dm:mid_dm"));

      expect(offered(rows)).toEqual([
        ["auto_789:tap:mid_first_comment", "offer_a"],
        ["auto_789:tap:mid_second_comment", "offer_b"],
        ["auto_789:dm:mid_dm", "offer_c"],
      ]);
      expect(firstMessages()).toEqual(["co_1", "co_2", "co_3"]);
    });

    it("starts nothing for a redelivered webhook of the same trigger", async () => {
      const rows = contactOfferTable();
      await processOffer(startJob("auto_789:tap:mid_tap_1"));

      // The same tap queued again, after the first start finished.
      vi.setSystemTime(NOW + 5000);
      await processOffer(startJob("auto_789:tap:mid_tap_1", { timestamp: NOW + 4000 }));

      expect(offered(rows)).toEqual([["auto_789:tap:mid_tap_1", "offer_a"]]);
      expect(firstMessages()).toEqual(["co_1"]);
    });

    it("resumes, but starts no second offer, when the same job is retried", async () => {
      const rows = contactOfferTable();
      mockQueueAdd.mockRejectedValueOnce(new Error("Redis connection lost"));
      await expect(processOffer(startJob("auto_789:tap:mid_tap_1"))).rejects.toThrow(
        "Redis connection lost"
      );

      vi.setSystemTime(NOW + 5 * MINUTE);
      await processOffer(startJob("auto_789:tap:mid_tap_1", { attemptsMade: 1 }));

      expect(offered(rows)).toEqual([["auto_789:tap:mid_tap_1", "offer_a"]]);
      expect(firstMessages()).toEqual(["co_1", "co_1"]);
      expect(mockQueueAdd).toHaveBeenLastCalledWith(
        "process-offer",
        expect.objectContaining({ phase: "offer", contactOfferId: "co_1", step: 0 }),
        expect.objectContaining({ jobId: "offer_co_1_offer_0" })
      );
    });

    it("never offers the same offer twice, also from another campaign", async () => {
      const rows = contactOfferTable();
      mockPrisma.offer.findMany.mockResolvedValue([{ id: "offer_a" }, { id: "offer_b" }]);

      await processOffer(startJob("auto_789:tap:mid_tap_1"));
      mockPrisma.automation.findFirst.mockResolvedValue({
        id: "auto_other",
        offersEnabled: true,
        offerIds: ["offer_a", "offer_b"],
        instagramAccount: { instagramId: "ig_456" },
      });
      await processOffer(
        offerJob({
          phase: "start",
          automationId: "auto_other",
          userId: "commenter_999",
          interactionAt: TAP_TIME,
          startKey: "auto_other:dm:mid_dm",
        })
      );

      expect(rows.map((r) => [r.automationId, r.offerId])).toEqual([
        ["auto_789", "offer_a"],
        ["auto_other", "offer_b"],
      ]);
    });

    it("does nothing for a new trigger once no offer is left", async () => {
      const rows = contactOfferTable();
      mockPrisma.offer.findMany.mockResolvedValue([{ id: "offer_a" }]);

      await processOffer(startJob("auto_789:tap:mid_tap_1"));
      await processOffer(startJob("auto_789:tap:mid_tap_2"));

      expect(offered(rows)).toEqual([["auto_789:tap:mid_tap_1", "offer_a"]]);
      expect(firstMessages()).toEqual(["co_1"]);
      expect(mockPrisma.contactTag.createMany).toHaveBeenCalledTimes(1);
    });
  });
});

// A campaign can start its offer 22 hours after the link (offerDelayHours).
// The start job then runs at that time and carries the flag; it never
// creates the contact, and its row records that it started late.
describe("late start", () => {
  // 22 hours after the tap at 12:09, rounded down to the half hour.
  const FIRE_TIME = Date.parse("2026-11-21T10:00:00.000Z");
  const STORED_CONTACT = {
    id: "contact_1",
    username: "commenter_user",
    lastInteractionAt: new Date(TAP_TIME),
  };

  function lateJob(
    data: Partial<ProcessOfferJob> = {},
    job: { attemptsMade?: number; timestamp?: number } = {}
  ) {
    return offerJob(
      {
        phase: "start",
        automationId: "auto_789",
        userId: "commenter_999",
        interactionAt: TAP_TIME,
        startKey: "auto_789:tap:mid_tap_1",
        lateStart: true,
        ...data,
      },
      // Queued right after the delivery, run 22 hours later.
      { timestamp: TAP_TIME + 2000, ...job }
    );
  }

  beforeEach(() => {
    vi.setSystemTime(FIRE_TIME);
    mockPrisma.contact.findFirst.mockResolvedValue(STORED_CONTACT);
  });

  it("looks the contact up within the workspace instead of recording it", async () => {
    await processOffer(lateJob());

    expect(mockPrisma.contact.findFirst).toHaveBeenCalledWith({
      where: {
        workspaceId: "workspace_123",
        instagramAccountId: "ig_account_row_1",
        igsid: "commenter_999",
        // Recorded by the time the delivery queued the start, two seconds
        // after the tap, give or take a minute of the database's clock.
        createdAt: { lte: new Date(TAP_TIME + 2000 + 60_000) },
      },
      select: { id: true, username: true, lastInteractionAt: true },
    });
    expect(mockPrisma.contact.upsert).not.toHaveBeenCalled();
  });

  // The bound is the time the delivery queued the start, not the tap or DM
  // itself: someone new is recorded only when the worker gets to their DM.
  it("takes only a contact recorded by the time its job was queued", async () => {
    // The worker got to a first DM three hours late: the contact is from
    // then, the start's job from right after, and both count.
    const queuedAt = TAP_TIME + 3 * HOUR + 5000;
    await processOffer(lateJob({}, { timestamp: queuedAt }));

    expect(mockPrisma.contact.findFirst.mock.calls[0][0].where.createdAt).toEqual({
      lte: new Date(queuedAt + 60_000),
    });
    expect(mockPrisma.contactOffer.create).toHaveBeenCalledTimes(1);
  });

  // The contact the delivery recorded was deleted on request, and the person
  // came back later: their new contact is newer than the start's job, so the
  // lookup finds none, and the old trigger brings no offer.
  it("skips a contact recorded after its job, untouched and unnamed", async () => {
    // The database leaves out a row the bound excludes.
    mockPrisma.contact.findFirst.mockImplementation(async ({ where }) =>
      where.createdAt ? null : { ...STORED_CONTACT, lastInteractionAt: null }
    );

    await processOffer(lateJob());

    expect(mockPrisma.contact.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.contactOffer.create).not.toHaveBeenCalled();
    expect(mockPrisma.contactTag.createMany).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(sends()).toBe(0);
    expect(console.log).toHaveBeenCalledWith(
      "[Offers] Late start skipped: the contact no longer exists",
      { automationId: "auto_789" }
    );
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain(
      "commenter_999"
    );
  });

  it("bounds the contact by the trigger when the job carries no queue time", async () => {
    const job = lateJob();
    (job as { timestamp?: number }).timestamp = undefined;

    await processOffer(job);

    expect(mockPrisma.contact.findFirst.mock.calls[0][0].where.createdAt).toEqual({
      lte: new Date(TAP_TIME + 60_000),
    });
  });

  it("records the contact as before for a start right after the link", async () => {
    mockPrisma.contact.upsert.mockResolvedValue(STORED_CONTACT);

    await processOffer(lateJob({ lateStart: undefined }));

    expect(mockPrisma.contact.upsert).toHaveBeenCalledTimes(1);
    expect(mockPrisma.contact.findFirst).not.toHaveBeenCalled();
  });

  it("records that the offer started late and queues its first message", async () => {
    await processOffer(lateJob());

    expect(mockPrisma.contactOffer.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.contactOffer.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          workspaceId: "workspace_123",
          contactId: "contact_1",
          offerId: "offer_a",
          automationId: "auto_789",
          startKey: "auto_789:tap:mid_tap_1",
          lateStart: true,
          offeredAt: new Date(FIRE_TIME),
        },
      })
    );
    expect(mockPrisma.contactTag.createMany).toHaveBeenCalledWith(
      tagWrite("offer_a angeboten")
    );
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    expect(mockQueueAdd).toHaveBeenCalledWith(
      "process-offer",
      { ...JOB_BASE, phase: "offer", contactOfferId: "co_offer_a", step: 0 },
      { jobId: "offer_co_offer_a_offer_0", delay: 5000, removeOnComplete: true }
    );
  });

  // The flag comes with the job: the campaign's setting is not read, so a
  // campaign switched back to starting right away keeps its late starts.
  it("starts late whatever the campaign says by now", async () => {
    mockPrisma.automation.findFirst.mockResolvedValue({
      id: "auto_789",
      offersEnabled: true,
      offerIds: [],
      offerDelayHours: 0,
      instagramAccount: { instagramId: "ig_456" },
    });

    await processOffer(lateJob());

    expect(mockPrisma.automation.findFirst.mock.calls[0][0].select).not.toHaveProperty(
      "offerDelayHours"
    );
    expect(mockPrisma.contactOffer.create.mock.calls[0][0].data.lateStart).toBe(true);
  });

  it("creates nothing and brings no deleted contact back", async () => {
    mockPrisma.contact.findFirst.mockResolvedValue(null);

    await processOffer(lateJob());

    expect(mockPrisma.contact.upsert).not.toHaveBeenCalled();
    expect(mockPrisma.contact.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.offer.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.contactOffer.create).not.toHaveBeenCalled();
    expect(mockPrisma.contactTag.createMany).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(sends()).toBe(0);
    // A log line that names no person: the contact was deleted on request.
    expect(mockPrisma.operationalEvent.create).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(
      "[Offers] Late start skipped: the contact no longer exists",
      { automationId: "auto_789" }
    );
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain(
      "commenter_999"
    );
  });

  it("skips with the INFO event when the window has closed by then", async () => {
    // The worker was down: the start runs three hours late, 24 h 51 min
    // after the tap.
    vi.setSystemTime(FIRE_TIME + 3 * HOUR);

    await processOffer(lateJob());

    expect(mockPrisma.contactOffer.create).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(mockPrisma.operationalEvent.create).toHaveBeenCalledWith({
      data: {
        workspaceId: "workspace_123",
        source: "WORKER",
        level: "INFO",
        message: "Offer skipped: messaging window closed",
        payload: { automationId: "auto_789", userId: "commenter_999" },
      },
    });
  });

  it("counts the window from a later tap or DM of the person", async () => {
    vi.setSystemTime(FIRE_TIME + 3 * HOUR);
    mockPrisma.contact.findFirst.mockResolvedValue({
      ...STORED_CONTACT,
      lastInteractionAt: new Date(TAP_TIME + 10 * HOUR),
    });

    await processOffer(lateJob());

    expect(mockPrisma.contactOffer.create).toHaveBeenCalledTimes(1);
    // A later interaction is never moved back to the trigger's.
    expect(mockPrisma.contact.updateMany).not.toHaveBeenCalled();
  });

  it("moves the contact's last interaction forward to the trigger's, by id", async () => {
    mockPrisma.contact.findFirst.mockResolvedValue({
      ...STORED_CONTACT,
      lastInteractionAt: null,
    });

    await processOffer(lateJob());

    expect(mockPrisma.contact.updateMany).toHaveBeenCalledWith({
      where: {
        id: "contact_1",
        OR: [{ lastInteractionAt: null }, { lastInteractionAt: { lt: new Date(TAP_TIME) } }],
      },
      data: { lastInteractionAt: new Date(TAP_TIME) },
    });
    expect(mockPrisma.contactOffer.create).toHaveBeenCalledTimes(1);
  });

  it("carries on when its own earlier attempt created the row", async () => {
    // Its row is from the run 22 hours after the job was queued.
    mockPrisma.contactOffer.findUnique.mockResolvedValue({
      id: "co1",
      offeredAt: new Date(FIRE_TIME),
      offer: { tagOffered: "Guide angeboten", offerDelaysSeconds: [5] },
    });

    await processOffer(lateJob({}, { attemptsMade: 1 }));

    expect(mockPrisma.contactOffer.create).not.toHaveBeenCalled();
    expect(mockQueueAdd).toHaveBeenCalledWith(
      ...next("offer", { step: 0 }, { jobId: "offer_co1_offer_0", delay: 5000 })
    );
  });

  it.each([
    { label: "its offers were switched off", campaign: { offersEnabled: false } },
    { label: "it was deleted", campaign: null },
  ])("starts nothing when $label in the meantime", async ({ campaign }) => {
    mockPrisma.automation.findFirst.mockResolvedValue(
      campaign && {
        id: "auto_789",
        offerIds: [],
        instagramAccount: { instagramId: "ig_456" },
        ...campaign,
      }
    );

    await processOffer(lateJob());

    expect(mockPrisma.contact.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.contactOffer.create).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });
});

describe("start job", () => {
  it("is keyed on a digest of the start key, whatever the mid holds", async () => {
    const startKey = "auto_789:tap:aWdfZAG1:faXRl/bTo+xOk==";

    await enqueueOfferStart({
      ...JOB_BASE,
      automationId: "auto_789",
      userId: "commenter_999",
      interactionAt: TAP_TIME,
      startKey,
    });

    const digest = createHash("sha256").update(startKey).digest("hex");
    expect(mockQueueAdd).toHaveBeenCalledWith(
      "process-offer",
      {
        ...JOB_BASE,
        phase: "start",
        automationId: "auto_789",
        userId: "commenter_999",
        interactionAt: TAP_TIME,
        startKey,
      },
      { jobId: `offerstart_auto_789_commenter_999_${digest}`, removeOnComplete: true }
    );
    expect(mockQueueAdd.mock.calls[0][2].jobId).not.toContain(":");
  });

  it("queues a late start 22 hours after the tap, on a half hour, under the same id", async () => {
    const startKey = "auto_789:tap:mid_tap_1";
    const start = {
      ...JOB_BASE,
      automationId: "auto_789",
      userId: "commenter_999",
      interactionAt: TAP_TIME,
      startKey,
    };

    await enqueueOfferStart(start);
    await enqueueOfferStart({ ...start, lateStart: true });

    const [[, rightAway, rightAwayOptions], [, late, lateOptions]] =
      mockQueueAdd.mock.calls;
    // 12:09 + 22 h = 10:09 the next day, rounded down to 10:00 UTC.
    const fireAt = Date.parse("2026-11-21T10:00:00.000Z");
    expect(late).toEqual({ ...start, phase: "start", lateStart: true });
    expect(lateOptions).toEqual({
      jobId: rightAwayOptions.jobId,
      delay: fireAt - NOW,
      removeOnComplete: true,
    });
    expect(lateOptions.delay).toBeLessThanOrEqual(22 * HOUR);
    // A start right away is queued as before: no flag, no delay.
    expect(rightAway).toEqual({ ...start, phase: "start" });
    expect(rightAwayOptions).not.toHaveProperty("delay");
  });

  it("runs a late start at once when its time has passed", async () => {
    await enqueueOfferStart({
      ...JOB_BASE,
      automationId: "auto_789",
      userId: "commenter_999",
      interactionAt: NOW - 22 * HOUR - 10 * MINUTE,
      startKey: "auto_789:dm:mid_old",
      lateStart: true,
    });

    const [, data, options] = mockQueueAdd.mock.calls[0];
    expect(data.lateStart).toBe(true);
    expect(options).not.toHaveProperty("delay");
  });

  it("removes a waiting job as best effort", async () => {
    mockQueueRemove.mockRejectedValue(new Error("Job is locked"));

    await expect(cancelOfferJob("offer_co1_reminder")).resolves.toBeUndefined();
    expect(mockQueueRemove).toHaveBeenCalledWith("offer_co1_reminder");
  });
});

describe("offer messages", () => {
  beforeEach(() => {
    mockPrisma.contactOffer.findFirst.mockResolvedValue(contactOffer());
  });

  const step = (i: number, job = {}) =>
    processOffer(offerJob({ phase: "offer", contactOfferId: "co1", step: i }, job));

  it("claims each message per account, offer row, phase and step before sending it", async () => {
    await step(0);

    expect(mockPrisma.postbackDelivery.create).toHaveBeenCalledWith({
      data: { id: claimId("offer", 0) },
    });
    expect(mockPrisma.postbackDelivery.create.mock.invocationCallOrder[0]).toBeLessThan(
      mockSendDirectMessage.mock.invocationCallOrder[0]
    );
  });

  it("loads the row within the job's workspace", async () => {
    await step(0);

    expect(mockPrisma.contactOffer.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "co1", workspaceId: "workspace_123" } })
    );
  });

  it("sends a message as text and queues the next one after its delay", async () => {
    await step(0);

    expect(mockSendDirectMessage).toHaveBeenCalledWith(
      META_AUTH,
      "ig_456",
      "commenter_999",
      "Ich hab übrigens noch einen Guide, commenter_user."
    );
    expect(mockReserveWorkspaceDMSend).toHaveBeenCalledWith("workspace_123");
    expect(mockReleaseWorkspaceDMReservation).not.toHaveBeenCalled();
    expect(mockQueueAdd).toHaveBeenCalledWith(
      ...next("offer", { step: 1 }, { jobId: "offer_co1_offer_1", delay: 3000 })
    );
    // An offer message is no campaign delivery.
    expect(mockPrisma.contactOffer.updateMany).not.toHaveBeenCalled();
  });

  it("leaves no English word where the name is missing", async () => {
    mockPrisma.contactOffer.findFirst.mockResolvedValue(
      contactOffer({}, {}, { username: null })
    );

    await step(0);

    expect(mockSendDirectMessage).toHaveBeenCalledWith(
      META_AUTH,
      "ig_456",
      "commenter_999",
      "Ich hab übrigens noch einen Guide,."
    );
  });

  it("sends the last message with the button and queues the reminder on a half hour", async () => {
    await step(2);

    expect(mockSendDirectMessageWithButton).toHaveBeenCalledWith(
      META_AUTH,
      "ig_456",
      "commenter_999",
      "Soll ich ihn dir schicken?",
      "Ja, gerne! 🙌",
      "offer:co1"
    );
    expect(mockPrisma.contactOffer.updateMany).toHaveBeenCalledWith({
      where: { id: "co1", pitchSentAt: null },
      data: { pitchSentAt: new Date(NOW) },
    });
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    const [, data, options] = mockQueueAdd.mock.calls[0];
    expect(data).toEqual({ ...JOB_BASE, contactOfferId: "co1", phase: "reminder" });
    expect(options).toEqual({
      jobId: "offer_co1_reminder",
      delay: expect.any(Number),
      removeOnComplete: true,
    });
    expect(options.delay).toBeLessThanOrEqual(23 * HOUR);
    expect(options.delay).toBeGreaterThan(22 * HOUR);
    expect((NOW + options.delay) % (30 * MINUTE)).toBe(0);
  });

  it("still ends with the button when the list got shorter while the offer ran", async () => {
    await step(5);

    expect(mockSendDirectMessageWithButton).toHaveBeenCalledWith(
      META_AUTH,
      "ig_456",
      "commenter_999",
      "Soll ich ihn dir schicken?",
      "Ja, gerne! 🙌",
      "offer:co1"
    );
    expect(mockSendDirectMessage).not.toHaveBeenCalled();
  });

  it("queues no reminder for an offer without one", async () => {
    mockPrisma.contactOffer.findFirst.mockResolvedValue(
      contactOffer({}, { reminderEnabled: false })
    );

    await step(2);

    expect(mockSendDirectMessageWithButton).toHaveBeenCalledTimes(1);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  // Whoever does not tap an offer that started 22 hours after its link gets
  // nothing more, even though the offer has a reminder.
  it("queues no reminder for an offer that started late", async () => {
    mockPrisma.contactOffer.findFirst.mockResolvedValue(
      contactOffer({ lateStart: true })
    );

    await step(2);

    expect(mockSendDirectMessageWithButton).toHaveBeenCalledWith(
      META_AUTH,
      "ig_456",
      "commenter_999",
      "Soll ich ihn dir schicken?",
      "Ja, gerne! 🙌",
      "offer:co1"
    );
    expect(mockPrisma.contactOffer.updateMany).toHaveBeenCalledWith({
      where: { id: "co1", pitchSentAt: null },
      data: { pitchSentAt: new Date(NOW) },
    });
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(mockPrisma.operationalEvent.create).not.toHaveBeenCalled();
  });

  it("still sends the messages before the last one of an offer that started late", async () => {
    mockPrisma.contactOffer.findFirst.mockResolvedValue(
      contactOffer({ lateStart: true })
    );

    await step(0);

    expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
    expect(mockQueueAdd).toHaveBeenCalledWith(
      ...next("offer", { step: 1 }, { jobId: "offer_co1_offer_1", delay: 3000 })
    );
  });

  it("skips the reminder when the window closes too soon for it", async () => {
    mockPrisma.contactOffer.findFirst.mockResolvedValue(
      contactOffer({}, {}, { lastInteractionAt: new Date(NOW - (23 * HOUR + 29 * MINUTE)) })
    );

    await step(2);

    expect(mockSendDirectMessageWithButton).toHaveBeenCalledTimes(1);
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(mockPrisma.operationalEvent.create).toHaveBeenCalledWith(
      event("INFO", "Offer reminder skipped: messaging window closes too soon")
    );
    expect(mockPrisma.contactOffer.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ stopReason: expect.anything() }) })
    );
  });

  it("sends nothing again for a claimed message, gives the reservation back and goes on", async () => {
    mockPrisma.postbackDelivery.create.mockRejectedValue({ code: "P2002" });

    await step(0);

    expect(sends()).toBe(0);
    expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalledWith(
      "workspace_123",
      USAGE_PERIOD
    );
    expect(mockQueueAdd).toHaveBeenCalledWith(
      ...next("offer", { step: 1 }, { jobId: "offer_co1_offer_1", delay: 3000 })
    );
  });

  it("retries without sending when the claim cannot be stored", async () => {
    const lost = new Error("Connection terminated unexpectedly");
    mockPrisma.postbackDelivery.create.mockRejectedValue(lost);

    await expect(step(0)).rejects.toBe(lost);

    expect(sends()).toBe(0);
    expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalledTimes(1);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  // Zernio's own limit (HTTP 429) is no Meta request limit: BullMQ retries
  // it, as before. Meta's limits wait for the account's pause (below).
  it("retries Zernio's rate limit while attempts are left", async () => {
    mockSendDirectMessage.mockRejectedValue(zernioLimit());

    await expect(step(0)).rejects.toMatchObject({ name: "RateLimitError" });

    // Refused, so the claim and the reservation go back for the retry.
    expect(mockPrisma.postbackDelivery.delete).toHaveBeenCalledWith({
      where: { id: claimId("offer", 0) },
    });
    expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalledTimes(1);
    expect(mockPrisma.contactOffer.updateMany).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("stops with RATE_LIMITED on the last attempt of Zernio's rate limit", async () => {
    mockSendDirectMessage.mockRejectedValue(zernioLimit());

    await expect(step(0, { attemptsMade: 2 })).resolves.toBeUndefined();

    expect(mockPrisma.contactOffer.updateMany).toHaveBeenCalledWith(
      stopWrite("RATE_LIMITED")
    );
    expect(mockPrisma.operationalEvent.create).toHaveBeenCalledWith(
      event("WARNING", "Offer stopped: Instagram rate limit reached", {
        reason: "RATE_LIMITED",
      })
    );
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("stops quietly when Instagram says the window has closed", async () => {
    mockSendDirectMessage.mockRejectedValue(
      new MetaApiError(10, 2018278, undefined, "(#10) This message is sent outside of allowed window.")
    );

    await expect(step(0)).resolves.toBeUndefined();

    expect(mockPrisma.contactOffer.updateMany).toHaveBeenCalledWith(
      stopWrite("WINDOW_CLOSED")
    );
    expect(mockPrisma.operationalEvent.create).toHaveBeenCalledWith(
      event("INFO", "Offer stopped: messaging window closed", { reason: "WINDOW_CLOSED" })
    );
    expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalledTimes(1);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it.each([
    { label: "a refused message", error: () => new MetaApiError(100, undefined, undefined, "Invalid parameter") },
    { label: "an expired token", error: () => new TokenExpiredError("Session has expired") },
  ])("stops with REJECTED after $label", async ({ error }) => {
    mockSendDirectMessage.mockRejectedValue(error());

    await expect(step(0)).resolves.toBeUndefined();

    expect(mockPrisma.contactOffer.updateMany).toHaveBeenCalledWith(stopWrite("REJECTED"));
    expect(mockPrisma.operationalEvent.create).toHaveBeenCalledWith(
      event("WARNING", "Offer stopped: Instagram refused a message", { reason: "REJECTED" })
    );
    expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalledTimes(1);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("records an unknown outcome, never sends it again and goes on", async () => {
    mockSendDirectMessage.mockRejectedValue(new Error("socket hang up"));

    await expect(step(0)).resolves.toBeUndefined();

    expect(mockPrisma.operationalEvent.create).toHaveBeenCalledWith(
      event("WARNING", "Offer message delivery unconfirmed", { phase: "offer", step: 0 })
    );
    // The claim and the reservation stay: it may have reached the inbox.
    expect(mockPrisma.postbackDelivery.delete).not.toHaveBeenCalled();
    expect(mockReleaseWorkspaceDMReservation).not.toHaveBeenCalled();
    expect(mockPrisma.contactOffer.updateMany).not.toHaveBeenCalled();
    expect(mockQueueAdd).toHaveBeenCalledWith(
      ...next("offer", { step: 1 }, { jobId: "offer_co1_offer_1", delay: 3000 })
    );
  });

  // Instagram refused the message, then the database failed while giving
  // its claim back. Nothing went out, so it is a refusal all the same; but
  // the claim is still taken, and a retry would take the message for sent.
  describe("when a refused message's claim cannot be given back", () => {
    const lost = () => new Error("Connection terminated unexpectedly");

    beforeEach(() => {
      mockPrisma.postbackDelivery.delete.mockRejectedValue(lost());
      vi.spyOn(console, "error").mockImplementation(() => {});
    });

    it("still stops the offer for the refusal and reports the claim on its own", async () => {
      mockSendDirectMessage.mockRejectedValue(
        new MetaApiError(100, undefined, undefined, "Invalid parameter")
      );

      await expect(step(0)).resolves.toBeUndefined();

      expect(mockPrisma.postbackDelivery.delete).toHaveBeenCalledWith({
        where: { id: claimId("offer", 0) },
      });
      expect(mockPrisma.contactOffer.updateMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.contactOffer.updateMany).toHaveBeenCalledWith(stopWrite("REJECTED"));
      expect(mockPrisma.operationalEvent.create).toHaveBeenCalledWith(
        event("WARNING", "Offer stopped: Instagram refused a message", {
          reason: "REJECTED",
          error: "MetaApiError 100: Invalid parameter",
        })
      );
      expect(mockPrisma.operationalEvent.create).toHaveBeenCalledWith(
        event("WARNING", "Offer message claim not released after a refusal", {
          phase: "offer",
          step: 0,
          claim: claimId("offer", 0),
          error: "Connection terminated unexpectedly",
        })
      );
      // Nothing was delivered: the monthly slot goes back.
      expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalledTimes(1);
      expect(mockQueueAdd).not.toHaveBeenCalled();
    });

    it("stops a rate limit at once instead of retrying it into a claimed message", async () => {
      mockSendDirectMessage.mockRejectedValue(new RateLimitError("Too many messages"));

      await expect(step(0)).resolves.toBeUndefined();

      expect(mockPrisma.contactOffer.updateMany).toHaveBeenCalledWith(stopWrite("RATE_LIMITED"));
      expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalledTimes(1);
      // No copy for the account's pause either: it would find the claim.
      expect(mockQueueAdd).not.toHaveBeenCalled();
      // The account still pauses (368, a block: an hour), so its other
      // messages wait.
      await expect(
        (redis.current as FakeRedis).get("meta:pause:ig_456")
      ).resolves.toBe(String(NOW + 60 * MINUTE));
    });

    it("stops quietly for a closed window", async () => {
      mockSendDirectMessage.mockRejectedValue(
        new MetaApiError(10, 2018278, undefined, "(#10) This message is sent outside of allowed window.")
      );

      await expect(step(0)).resolves.toBeUndefined();

      expect(mockPrisma.contactOffer.updateMany).toHaveBeenCalledWith(stopWrite("WINDOW_CLOSED"));
      expect(mockPrisma.operationalEvent.create).toHaveBeenCalledWith(
        event("INFO", "Offer stopped: messaging window closed", { reason: "WINDOW_CLOSED" })
      );
    });

    it("ends the job for good when the refusal cannot be recorded either", async () => {
      mockSendDirectMessage.mockRejectedValue(
        new MetaApiError(100, undefined, undefined, "Invalid parameter")
      );
      mockPrisma.contactOffer.updateMany.mockRejectedValue(lost());

      // Not retried: the retry would find the claim and carry on as if the
      // message had gone out.
      await expect(step(0)).rejects.toMatchObject({
        name: "UnrecoverableError",
        message: expect.stringContaining("Connection terminated unexpectedly"),
      });

      expect(mockQueueAdd).not.toHaveBeenCalled();
    });
  });

  it("stops with PLAN_LIMIT and sends nothing without a monthly slot", async () => {
    mockReserveWorkspaceDMSend.mockResolvedValue({
      allowed: false,
      reserved: false,
      remaining: 0,
      limit: 2000,
      periodStart: USAGE_PERIOD,
    });

    await step(0);

    expect(sends()).toBe(0);
    expect(mockPrisma.postbackDelivery.create).not.toHaveBeenCalled();
    expect(mockPrisma.contactOffer.updateMany).toHaveBeenCalledWith(stopWrite("PLAN_LIMIT"));
    expect(mockPrisma.operationalEvent.create).toHaveBeenCalledWith(
      event("WARNING", "Offer stopped: monthly DM limit reached")
    );
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it.each([
    { label: "after the tap", row: { interestedAt: new Date(NOW - 1000) } },
    { label: "after a stop", row: { stoppedAt: new Date(NOW - 1000), stopReason: "REJECTED" } },
  ])("sends nothing $label", async ({ row }) => {
    mockPrisma.contactOffer.findFirst.mockResolvedValue(contactOffer(row));

    await step(1);

    expect(sends()).toBe(0);
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
    expect(mockPrisma.contactOffer.updateMany).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("stops an offer that was deleted, with OFFER_ARCHIVED", async () => {
    mockPrisma.contactOffer.findFirst.mockResolvedValue(
      contactOffer({}, { archivedAt: new Date(NOW - HOUR) })
    );

    await step(1);

    expect(sends()).toBe(0);
    expect(mockPrisma.contactOffer.updateMany).toHaveBeenCalledWith(stopWrite("OFFER_ARCHIVED"));
    expect(mockPrisma.operationalEvent.create).toHaveBeenCalledWith(
      event("INFO", "Offer stopped: offer was deleted")
    );
  });

  it("stops before sending when the window has closed", async () => {
    mockPrisma.contactOffer.findFirst.mockResolvedValue(
      contactOffer({}, {}, { lastInteractionAt: new Date(NOW - 24 * HOUR) })
    );

    await step(1);

    expect(sends()).toBe(0);
    expect(mockPrisma.contactOffer.updateMany).toHaveBeenCalledWith(stopWrite("WINDOW_CLOSED"));
  });

  it("stops with ACCOUNT_UNAVAILABLE when the account has no token", async () => {
    mockPrisma.contactOffer.findFirst.mockResolvedValue(
      contactOffer({}, {}, { instagramAccount: { ...ACCOUNT, accessToken: "" } })
    );

    await step(0);

    expect(sends()).toBe(0);
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
    expect(mockPrisma.contactOffer.updateMany).toHaveBeenCalledWith(
      stopWrite("ACCOUNT_UNAVAILABLE")
    );
  });

  it.each([
    { label: "another connection", data: { accountConnectionId: "ig_account_row_2" } },
    { label: "another Instagram account", data: { instagramAccountId: "ig_other" } },
  ])("ignores a job queued for $label", async ({ data }) => {
    await processOffer(offerJob({ phase: "offer", contactOfferId: "co1", step: 0, ...data }));

    expect(sends()).toBe(0);
    expect(mockPrisma.contactOffer.updateMany).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });
});

// The reminder went out, a day after the offer. It carried the link, so the
// row counts as sent, but the card has not gone out.
const REMINDED = {
  pitchSentAt: new Date(NOW - 23 * HOUR),
  reminderSentAt: new Date(NOW - HOUR),
  sentAt: new Date(NOW - HOUR),
  sentVia: "REMINDER",
};

describe("the tap on the button", () => {
  const pitched = (row: Record<string, unknown> = {}, offer: Partial<typeof OFFER> = {}) =>
    contactOffer({ pitchSentAt: new Date(NOW - 10 * MINUTE), ...row }, offer);

  beforeEach(() => {
    mockPrisma.contactOffer.findUnique.mockResolvedValue(pitched());
  });

  it("records the interest, removes the reminder and queues the confirmations", async () => {
    await processOfferTap(tapJob());

    expect(mockPrisma.contactOffer.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "co1" } })
    );
    // The tap opens the window again.
    expect(mockPrisma.contact.updateMany).toHaveBeenCalledWith({
      where: {
        id: "contact_1",
        OR: [{ lastInteractionAt: null }, { lastInteractionAt: { lt: new Date(NOW) } }],
      },
      data: { lastInteractionAt: new Date(NOW) },
    });
    expect(mockPrisma.contactOffer.updateMany).toHaveBeenCalledWith({
      where: { id: "co1", interestedAt: null },
      data: {
        interestedAt: new Date(NOW),
        interestedMid: "mid_yes",
        stoppedAt: null,
        stopReason: null,
      },
    });
    expect(mockPrisma.contactTag.createMany).toHaveBeenCalledWith(tagWrite("Guide Interesse"));
    expect(mockQueueRemove).toHaveBeenCalledWith("offer_co1_reminder");
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    expect(mockQueueAdd).toHaveBeenCalledWith(
      ...next("confirm", { step: 0 }, { jobId: "offer_co1_confirm_0", delay: 3000 })
    );
    expect(sends()).toBe(0);
    // The campaign that started the offer is never read.
    expect(mockPrisma.automation.findFirst).not.toHaveBeenCalled();
  });

  it("queues the card right away for an offer without confirmations", async () => {
    mockPrisma.contactOffer.findUnique.mockResolvedValue(
      pitched({}, { confirmationMessages: [], confirmationDelaysSeconds: [] })
    );

    await processOfferTap(tapJob());

    expect(mockQueueAdd).toHaveBeenCalledWith(
      ...next("card", {}, { jobId: "offer_co1_card", delay: 1000 })
    );
  });

  it("answers taps on a paused offer", async () => {
    mockPrisma.contactOffer.findUnique.mockResolvedValue(pitched({}, { isActive: false }));

    await processOfferTap(tapJob());

    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: "someone else", data: { userId: "someone_else" } },
    { label: "another Instagram account", data: { instagramAccountId: "ig_other" } },
    { label: "another connection", data: { accountConnectionId: "ig_account_row_2" } },
    { label: "an unknown row", data: { payload: "offer:co_unknown" } },
  ])("does nothing for a tap by $label", async ({ data }) => {
    if (data.payload) mockPrisma.contactOffer.findUnique.mockResolvedValue(null);

    await processOfferTap(tapJob(data));

    expect(mockPrisma.contact.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.contactOffer.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.contactTag.createMany).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(sends()).toBe(0);
  });

  it.each([
    { label: "as a card", row: { sentVia: "CARD" } },
    { label: "in a form not known", row: { sentVia: null } },
    { label: "after the reminder", row: { ...REMINDED, sentVia: "CARD" } },
  ])("does nothing for the first tap once more after its card went out $label", async ({ row }) => {
    mockPrisma.contactOffer.findUnique.mockResolvedValue(
      pitched({
        interestedAt: new Date(NOW - 5 * MINUTE),
        interestedMid: "mid_yes",
        sentAt: new Date(NOW - 4 * MINUTE),
        ...row,
      })
    );
    mockPrisma.contactOffer.updateMany.mockResolvedValue({ count: 0 });

    await processOfferTap(tapJob());

    expect(sends()).toBe(0);
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(mockPrisma.contactTag.createMany).not.toHaveBeenCalled();
  });

  it.each([
    { label: "while nothing was sent", row: {} },
    // The reminder carried the link, but not as the card.
    { label: "after the reminder", row: REMINDED },
  ])("queues the confirmations again for a later tap before the card is out, $label", async ({ row }) => {
    mockPrisma.contactOffer.findUnique.mockResolvedValue(
      pitched({
        ...row,
        interestedAt: new Date(NOW - 5 * MINUTE),
        interestedMid: "mid_yes",
        stoppedAt: new Date(NOW - 4 * MINUTE),
        stopReason: "REJECTED",
      })
    );
    mockPrisma.contactOffer.updateMany.mockResolvedValue({ count: 0 });

    await processOfferTap(tapJob({ mid: "mid_later" }));

    // The stop is lifted only as long as the card is not out.
    expect(mockPrisma.contactOffer.updateMany).toHaveBeenCalledWith({
      where: { id: "co1", OR: [{ sentAt: null }, { sentVia: "REMINDER" }] },
      data: { stoppedAt: null, stopReason: null },
    });
    expect(mockQueueAdd).toHaveBeenCalledWith(
      ...next("confirm", { step: 0 }, { jobId: "offer_co1_confirm_0" })
    );
    expect(sends()).toBe(0);
  });

  // A second tap while the first one's confirmations still wait: their job id
  // swallows the add, so no card overtakes "Alles klar!".
  it("sends no card ahead of the confirmations for a quick second tap after the reminder", async () => {
    mockPrisma.contactOffer.findUnique.mockResolvedValue(
      pitched({
        ...REMINDED,
        interestedAt: new Date(NOW - 2000),
        interestedMid: "mid_yes",
      })
    );
    mockPrisma.contactOffer.updateMany.mockResolvedValue({ count: 0 });

    await processOfferTap(tapJob({ mid: "mid_second" }));

    expect(sends()).toBe(0);
    expect(mockPrisma.postbackDelivery.create).not.toHaveBeenCalled();
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    expect(mockQueueAdd).toHaveBeenCalledWith(
      ...next("confirm", { step: 0 }, { jobId: "offer_co1_confirm_0" })
    );
  });

  // The first attempt recorded the interest, then Redis refused the job: the
  // retry still has to send the confirmations and the card.
  it.each([
    { label: "while nothing was sent", row: {} },
    { label: "after the reminder", row: REMINDED },
  ])("finishes a first tap whose job failed before it queued the confirmations, $label", async ({ row }) => {
    mockPrisma.contactOffer.findUnique.mockResolvedValue(pitched(row));
    mockQueueAdd.mockRejectedValueOnce(new Error("Redis connection lost"));
    await expect(processOfferTap(tapJob())).rejects.toThrow("Redis connection lost");

    mockPrisma.contactOffer.findUnique.mockResolvedValue(
      pitched({ ...row, interestedAt: new Date(NOW), interestedMid: "mid_yes" })
    );
    mockPrisma.contactOffer.updateMany.mockResolvedValue({ count: 0 });
    await processOfferTap(tapJob({}, { attemptsMade: 1 }));

    expect(mockQueueAdd).toHaveBeenLastCalledWith(
      ...next("confirm", { step: 0 }, { jobId: "offer_co1_confirm_0" })
    );
    expect(mockPrisma.contactTag.createMany).toHaveBeenLastCalledWith(
      tagWrite("Guide Interesse")
    );
    expect(sends()).toBe(0);
  });

  it("sends the card once more, under its own claim, for a later tap after the card", async () => {
    mockPrisma.contactOffer.findUnique.mockResolvedValue(
      pitched({
        interestedAt: new Date(NOW - 2 * HOUR),
        interestedMid: "mid_yes",
        sentAt: new Date(NOW - 2 * HOUR),
        sentVia: "CARD",
      })
    );
    mockPrisma.contactOffer.updateMany.mockResolvedValue({ count: 0 });
    const claims = new Set<string>();
    mockPrisma.postbackDelivery.create.mockImplementation(
      async ({ data }: { data: { id: string } }) => {
        if (claims.has(data.id)) throw { code: "P2002" };
        claims.add(data.id);
        return data;
      }
    );

    await processOfferTap(tapJob({ mid: "mid_later" }));
    // The same tap redelivered.
    await processOfferTap(tapJob({ mid: "mid_later" }, { id: "redelivered" }));

    expect(mockSendDirectMessageWithCard).toHaveBeenCalledTimes(1);
    expect(sends()).toBe(1);
    expect(mockPrisma.postbackDelivery.create).toHaveBeenCalledWith({
      data: { id: claimId("retap", "mid_later") },
    });
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  // The person has the card. Whatever fails after that does not make it an
  // offer that stopped early, which is what the funnel's "stopped" counts.
  it.each([
    {
      label: "Instagram refuses it",
      error: () =>
        new MetaApiError(551, undefined, undefined, "This person isn't available right now."),
      level: "WARNING",
      message: "Offer message not sent: Instagram refused a message",
      reason: "REJECTED",
    },
    {
      label: "the window closed again",
      error: () =>
        new MetaApiError(10, undefined, undefined, "This message is sent outside of allowed window."),
      level: "INFO",
      message: "Offer message not sent: messaging window closed",
      reason: "WINDOW_CLOSED",
    },
  ])(
    "does not mark a delivered offer stopped when the card for a later tap fails because $label",
    async ({ error, level, message, reason }) => {
      mockPrisma.contactOffer.findUnique.mockResolvedValue(
        pitched({
          interestedAt: new Date(NOW - 2 * HOUR),
          interestedMid: "mid_yes",
          sentAt: new Date(NOW - 2 * HOUR),
          sentVia: "CARD",
        })
      );
      mockPrisma.contactOffer.updateMany.mockResolvedValue({ count: 0 });
      mockSendDirectMessageWithCard.mockRejectedValue(error());

      await expect(processOfferTap(tapJob({ mid: "mid_later" }))).resolves.toBeUndefined();

      expect(mockSendDirectMessageWithCard).toHaveBeenCalledTimes(1);
      expect(mockPrisma.contactOffer.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ stopReason: expect.anything() }),
        })
      );
      expect(mockPrisma.operationalEvent.create).toHaveBeenCalledWith(
        event(level, message, { reason, phase: "retap", step: "mid_later" })
      );
      expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalledTimes(1);
    }
  );

  it("only writes an INFO event for a tap on a deleted offer", async () => {
    mockPrisma.contactOffer.findUnique.mockResolvedValue(
      pitched({}, { archivedAt: new Date(NOW - HOUR) })
    );

    await processOfferTap(tapJob());

    expect(mockPrisma.operationalEvent.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.operationalEvent.create).toHaveBeenCalledWith(
      event("INFO", "Offer tap ignored: offer was deleted")
    );
    expect(mockPrisma.contactOffer.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.contactTag.createMany).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(sends()).toBe(0);
  });
});

describe("confirmations and card", () => {
  const interested = (row: Record<string, unknown> = {}, offer: Partial<typeof OFFER> = {}) =>
    contactOffer(
      {
        pitchSentAt: new Date(NOW - 10 * MINUTE),
        interestedAt: new Date(NOW - 5000),
        interestedMid: "mid_yes",
        ...row,
      },
      offer,
      { lastInteractionAt: new Date(NOW - 5000) }
    );

  beforeEach(() => {
    mockPrisma.contactOffer.findFirst.mockResolvedValue(interested());
  });

  it("sends the confirmations in order, then queues the card", async () => {
    await processOffer(offerJob({ phase: "confirm", contactOfferId: "co1", step: 0 }));
    await processOffer(offerJob({ phase: "confirm", contactOfferId: "co1", step: 1 }));

    expect(mockSendDirectMessage.mock.calls.map((call) => call[3])).toEqual([
      "Alles klar!",
      "Hier geht's zum Guide 👇",
    ]);
    expect(mockPrisma.postbackDelivery.create.mock.calls.map(([args]) => args.data.id)).toEqual([
      claimId("confirm", 0),
      claimId("confirm", 1),
    ]);
    expect(mockQueueAdd.mock.calls).toEqual([
      next("confirm", { step: 1 }, { jobId: "offer_co1_confirm_1", delay: 3000 }),
      next("card", {}, { jobId: "offer_co1_card", delay: 1000 }),
    ]);
  });

  it("goes straight to the card when no confirmation is left", async () => {
    await processOffer(offerJob({ phase: "confirm", contactOfferId: "co1", step: 2 }));

    expect(sends()).toBe(0);
    expect(mockQueueAdd).toHaveBeenCalledWith(
      ...next("card", {}, { jobId: "offer_co1_card", delay: 1000 })
    );
  });

  it("sends no confirmation without a tap", async () => {
    mockPrisma.contactOffer.findFirst.mockResolvedValue(interested({ interestedAt: null }));

    await processOffer(offerJob({ phase: "confirm", contactOfferId: "co1", step: 0 }));

    expect(sends()).toBe(0);
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("sends the card with the offer's own link, records it as CARD and tags the contact", async () => {
    await processOffer(offerJob({ phase: "card", contactOfferId: "co1" }));

    expect(mockSendDirectMessageWithCard).toHaveBeenCalledWith(
      META_AUTH,
      "ig_456",
      "commenter_999",
      {
        title: "Prompting Guide",
        subtitle: "In 7 Schritten",
        imageUrl: "https://cdn.example.com/cover.jpg",
        button: {
          title: "Jetzt holen",
          url: expect.stringMatching(new RegExp(`/o/guide_slug\\?r=${TOKEN}$`)),
        },
      }
    );
    expect(mockPrisma.postbackDelivery.create).toHaveBeenCalledWith({
      data: { id: claimId("card", 0) },
    });
    expect(mockPrisma.contactOffer.updateMany).toHaveBeenCalledWith({
      where: { id: "co1", sentAt: null },
      data: { sentAt: new Date(NOW), sentVia: "CARD" },
    });
    expect(mockPrisma.contactTag.createMany).toHaveBeenCalledWith(tagWrite("Guide gesendet"));
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("records BUTTON when the card fell back to a button message", async () => {
    mockSendDirectMessageWithCard.mockRejectedValue(
      new MetaApiError(100, undefined, undefined, "Invalid image_url")
    );

    await processOffer(offerJob({ phase: "card", contactOfferId: "co1" }));

    expect(mockSendDirectMessageWithLinkButton).toHaveBeenCalledWith(
      META_AUTH,
      "ig_456",
      "commenter_999",
      "Prompting Guide\nIn 7 Schritten",
      [{ title: "Jetzt holen", url: expect.stringContaining("/o/guide_slug?r=") }]
    );
    expect(mockPrisma.contactOffer.updateMany).toHaveBeenCalledWith({
      where: { id: "co1", sentAt: null },
      data: { sentAt: new Date(NOW), sentVia: "BUTTON" },
    });
  });

  it("counts a card an earlier run claimed as sent without guessing how", async () => {
    mockPrisma.postbackDelivery.create.mockRejectedValue({ code: "P2002" });

    await processOffer(offerJob({ phase: "card", contactOfferId: "co1" }));

    expect(sends()).toBe(0);
    expect(mockPrisma.contactOffer.updateMany).toHaveBeenCalledWith({
      where: { id: "co1", sentAt: null },
      data: { sentAt: new Date(NOW) },
    });
    expect(mockPrisma.contactTag.createMany).toHaveBeenCalledWith(tagWrite("Guide gesendet"));
  });

  // The row counts as sent since the reminder and keeps that time; from the
  // card on it says how the card went out, so a later tap knows it is out.
  it.each([
    { label: "sent by this run", claimed: false, via: "CARD" },
    { label: "an earlier run claimed", claimed: true, via: null },
  ])("records a card after the reminder, $label", async ({ claimed, via }) => {
    mockPrisma.contactOffer.findFirst.mockResolvedValue(interested(REMINDED));
    if (claimed) mockPrisma.postbackDelivery.create.mockRejectedValue({ code: "P2002" });
    mockPrisma.contactOffer.updateMany.mockResolvedValueOnce({ count: 0 });

    await processOffer(offerJob({ phase: "card", contactOfferId: "co1" }));

    expect(mockSendDirectMessageWithCard).toHaveBeenCalledTimes(claimed ? 0 : 1);
    expect(mockPrisma.contactOffer.updateMany.mock.calls).toEqual([
      [
        {
          where: { id: "co1", sentAt: null },
          data: { sentAt: new Date(NOW), ...(via ? { sentVia: via } : {}) },
        },
      ],
      [{ where: { id: "co1", sentVia: "REMINDER" }, data: { sentVia: via } }],
    ]);
    expect(mockPrisma.contactTag.createMany).toHaveBeenCalledWith(tagWrite("Guide gesendet"));
  });

  it("records nothing as sent when the card was refused", async () => {
    mockSendDirectMessageWithCard.mockRejectedValue(
      new MetaApiError(10, undefined, undefined, "This message is sent outside of allowed window.")
    );

    await processOffer(offerJob({ phase: "card", contactOfferId: "co1" }));

    expect(mockSendDirectMessageWithLinkButton).not.toHaveBeenCalled();
    expect(mockPrisma.contactOffer.updateMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.contactOffer.updateMany).toHaveBeenCalledWith(stopWrite("WINDOW_CLOSED"));
    expect(mockPrisma.contactTag.createMany).not.toHaveBeenCalled();
  });

  // The refused card's claim stays taken. A retry would find it, record the
  // card as sent and tag the person, so the refusal ends the card here.
  it("records nothing as sent for a refused card whose claim cannot be given back", async () => {
    mockSendDirectMessageWithCard.mockRejectedValue(
      new MetaApiError(10, undefined, undefined, "This message is sent outside of allowed window.")
    );
    mockPrisma.postbackDelivery.delete.mockRejectedValue(
      new Error("Connection terminated unexpectedly")
    );
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      processOffer(offerJob({ phase: "card", contactOfferId: "co1" }))
    ).resolves.toBeUndefined();

    expect(mockPrisma.contactOffer.updateMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.contactOffer.updateMany).toHaveBeenCalledWith(stopWrite("WINDOW_CLOSED"));
    expect(mockPrisma.contactTag.createMany).not.toHaveBeenCalled();
    expect(mockPrisma.operationalEvent.create).toHaveBeenCalledWith(
      event("WARNING", "Offer message claim not released after a refusal", {
        phase: "card",
        claim: claimId("card", 0),
      })
    );
  });

  // The reminder brought the link: the person got the offer. A confirmation
  // or the card failing after their tap does not make it one that stopped
  // early, which is what the funnel's "stopped" counts.
  it.each([
    {
      label: "the card is refused",
      phase: "card" as const,
      contact: { lastInteractionAt: new Date(NOW - 5000) },
      refuse: () =>
        mockSendDirectMessageWithCard.mockRejectedValue(
          new MetaApiError(10, undefined, undefined, "This message is sent outside of allowed window.")
        ),
      expectedSends: 1,
    },
    {
      label: "a confirmation is refused",
      phase: "confirm" as const,
      contact: { lastInteractionAt: new Date(NOW - 5000) },
      refuse: () =>
        mockSendDirectMessage.mockRejectedValue(
          new MetaApiError(10, undefined, undefined, "This message is sent outside of allowed window.")
        ),
      expectedSends: 1,
    },
    {
      label: "the window closed before the card",
      phase: "card" as const,
      contact: { lastInteractionAt: new Date(NOW - 24 * HOUR) },
      refuse: () => {},
      expectedSends: 0,
    },
  ])(
    "does not mark an offer the reminder delivered stopped when $label",
    async ({ phase, contact, refuse, expectedSends }) => {
      mockPrisma.contactOffer.findFirst.mockResolvedValue(
        contactOffer(
          {
            ...REMINDED,
            interestedAt: new Date(NOW - 5000),
            interestedMid: "mid_yes",
          },
          {},
          contact
        )
      );
      refuse();

      await expect(
        processOffer(offerJob({ phase, contactOfferId: "co1", step: 0 }))
      ).resolves.toBeUndefined();

      expect(sends()).toBe(expectedSends);
      expect(mockPrisma.contactOffer.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.contactTag.createMany).not.toHaveBeenCalled();
      expect(mockPrisma.operationalEvent.create).toHaveBeenCalledWith(
        event("INFO", "Offer message not sent: messaging window closed", {
          reason: "WINDOW_CLOSED",
        })
      );
      expect(mockQueueAdd).not.toHaveBeenCalled();
    }
  );
});

describe("the reminder", () => {
  const pitched = (
    row: Record<string, unknown> = {},
    offer: Partial<typeof OFFER> = {},
    contact: Partial<typeof CONTACT> = {}
  ) =>
    contactOffer({ pitchSentAt: new Date(NOW - 22 * HOUR), ...row }, offer, {
      lastInteractionAt: new Date(NOW - 23 * HOUR),
      ...contact,
    });

  const remind = () => processOffer(offerJob({ phase: "reminder", contactOfferId: "co1" }));

  beforeEach(() => {
    mockPrisma.contactOffer.findFirst.mockResolvedValue(pitched());
  });

  it("sends the text with the offer's link as a button and records the delivery", async () => {
    await remind();

    expect(mockSendDirectMessageWithLinkButton).toHaveBeenCalledWith(
      META_AUTH,
      "ig_456",
      "commenter_999",
      "Hey, nur kurz zur Info 👇",
      [
        {
          title: "Jetzt holen",
          url: expect.stringMatching(new RegExp(`/o/guide_slug\\?r=${TOKEN}$`)),
        },
      ]
    );
    expect(mockPrisma.postbackDelivery.create).toHaveBeenCalledWith({
      data: { id: claimId("reminder", 0) },
    });
    expect(mockPrisma.contactOffer.updateMany).toHaveBeenCalledWith({
      where: { id: "co1", reminderSentAt: null },
      data: { reminderSentAt: new Date(NOW) },
    });
    expect(mockPrisma.contactOffer.updateMany).toHaveBeenCalledWith({
      where: { id: "co1", sentAt: null },
      data: { sentAt: new Date(NOW), sentVia: "REMINDER" },
    });
    expect(mockPrisma.contactTag.createMany).toHaveBeenCalledWith(tagWrite("Guide gesendet"));
  });

  it("puts the link in the text when Instagram refuses the button template", async () => {
    mockSendDirectMessageWithLinkButton.mockRejectedValue(
      new MetaApiError(100, undefined, undefined, "Unsupported template")
    );

    await remind();

    expect(mockSendDirectMessage).toHaveBeenCalledWith(
      META_AUTH,
      "ig_456",
      "commenter_999",
      expect.stringMatching(new RegExp(`^Hey, nur kurz zur Info 👇\\n.*/o/guide_slug\\?r=${TOKEN}$`))
    );
    expect(mockPrisma.contactOffer.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { sentAt: new Date(NOW), sentVia: "REMINDER" } })
    );
  });

  it("still goes out while the offer is paused", async () => {
    mockPrisma.contactOffer.findFirst.mockResolvedValue(pitched({}, { isActive: false }));

    await remind();

    expect(mockSendDirectMessageWithLinkButton).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: "after the tap", row: { interestedAt: new Date(NOW - HOUR) }, offer: {} },
    { label: "a second time", row: { reminderSentAt: new Date(NOW - HOUR) }, offer: {} },
    { label: "after a stop", row: { stoppedAt: new Date(NOW - HOUR), stopReason: "REJECTED" }, offer: {} },
    { label: "once the reminder was switched off", row: {}, offer: { reminderEnabled: false } },
    { label: "without a text", row: {}, offer: { reminderMessage: "   " } },
    { label: "for a deleted offer", row: {}, offer: { archivedAt: new Date(NOW - HOUR) } },
    // None is queued for it; a reminder job that exists all the same sends nothing.
    { label: "for an offer that started late", row: { lateStart: true }, offer: {} },
  ])("sends nothing $label", async ({ row, offer }) => {
    mockPrisma.contactOffer.findFirst.mockResolvedValue(pitched(row, offer));

    await remind();

    expect(sends()).toBe(0);
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
    expect(mockPrisma.contactOffer.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.operationalEvent.create).not.toHaveBeenCalled();
  });

  it("stops with an INFO event when the window has closed", async () => {
    mockPrisma.contactOffer.findFirst.mockResolvedValue(
      pitched({}, {}, { lastInteractionAt: new Date(NOW - 24 * HOUR) })
    );

    await remind();

    expect(sends()).toBe(0);
    expect(mockPrisma.contactOffer.updateMany).toHaveBeenCalledWith(stopWrite("WINDOW_CLOSED"));
    expect(mockPrisma.operationalEvent.create).toHaveBeenCalledWith(
      event("INFO", "Offer reminder skipped: messaging window closed")
    );
  });
});

// After the landing page reported the sign-up (POST /api/offers/signup), one
// message in the chat confirms it, while Instagram still allows it. The person
// got the link long before, so nothing here ever marks the offer stopped.
describe("the sign-up confirmation", () => {
  // Tapped, got the card a minute ago, clicked and signed up just now.
  const signedUp = (
    row: Record<string, unknown> = {},
    offer: Partial<typeof OFFER> = {},
    contact: Partial<typeof CONTACT> = {}
  ) =>
    contactOffer(
      {
        pitchSentAt: new Date(NOW - 10 * MINUTE),
        interestedAt: new Date(TAP_TIME),
        sentAt: new Date(NOW - 50_000),
        sentVia: "CARD",
        clickedAt: new Date(NOW - 40_000),
        signupToken: "SgNuPcOdE_0123456789-xyz",
        signedUpAt: new Date(NOW - 1000),
        ...row,
      },
      {
        signupTrackingEnabled: true,
        signupMessage: "Danke fürs Eintragen, {username}! Ich habe dir alles per E-Mail geschickt 📩",
        ...offer,
      },
      contact
    );

  const confirm = (job: { attemptsMade?: number } = {}) =>
    processOffer(offerJob({ phase: "signup", contactOfferId: "co1" }, job));

  // A stop is never written for this message.
  const stopWrites = () =>
    mockPrisma.contactOffer.updateMany.mock.calls.filter(
      ([args]) => "stoppedAt" in (args as { data: object }).data
    );

  beforeEach(() => {
    mockPrisma.contactOffer.findFirst.mockResolvedValue(signedUp());
  });

  it("sends the offer's text with the name, under its own claim, and records it", async () => {
    await confirm();

    expect(mockPrisma.contactOffer.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "co1", workspaceId: "workspace_123" } })
    );
    expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
    expect(mockSendDirectMessage).toHaveBeenCalledWith(
      META_AUTH,
      "ig_456",
      "commenter_999",
      "Danke fürs Eintragen, commenter_user! Ich habe dir alles per E-Mail geschickt 📩"
    );
    expect(sends()).toBe(1);
    // Claimed before it is sent, so a retry never sends it twice.
    expect(mockPrisma.postbackDelivery.create).toHaveBeenCalledWith({
      data: { id: claimId("signup", 0) },
    });
    expect(mockPrisma.postbackDelivery.create.mock.invocationCallOrder[0]).toBeLessThan(
      mockSendDirectMessage.mock.invocationCallOrder[0]
    );
    // Counts toward the workspace's monthly DMs.
    expect(mockReserveWorkspaceDMSend).toHaveBeenCalledWith("workspace_123");
    expect(mockReleaseWorkspaceDMReservation).not.toHaveBeenCalled();
    expect(mockPrisma.contactOffer.updateMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.contactOffer.updateMany).toHaveBeenCalledWith({
      where: { id: "co1", signupMessageSentAt: null },
      data: { signupMessageSentAt: new Date(NOW) },
    });
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(mockPrisma.operationalEvent.create).not.toHaveBeenCalled();
  });

  it("sends nothing again for a claim an earlier run took, and records it as sent", async () => {
    mockPrisma.postbackDelivery.create.mockRejectedValue(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" })
    );

    await confirm();

    expect(sends()).toBe(0);
    expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalledWith("workspace_123", USAGE_PERIOD);
    expect(mockPrisma.contactOffer.updateMany).toHaveBeenCalledWith({
      where: { id: "co1", signupMessageSentAt: null },
      data: { signupMessageSentAt: new Date(NOW) },
    });
  });

  it("says so and sends nothing when the confirmation went out before", async () => {
    mockPrisma.contactOffer.findFirst.mockResolvedValue(
      signedUp({ signupMessageSentAt: new Date(NOW - 500) })
    );

    await confirm();

    expect(sends()).toBe(0);
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
    expect(mockPrisma.postbackDelivery.create).not.toHaveBeenCalled();
    expect(mockPrisma.contactOffer.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.operationalEvent.create).toHaveBeenCalledWith(
      event("INFO", "Sign-up confirmation not sent: it went out before", { phase: "signup" })
    );
  });

  it("skips with an INFO event when the window has closed, and stops nothing", async () => {
    // The double opt-in mail was confirmed a day after the last tap.
    mockPrisma.contactOffer.findFirst.mockResolvedValue(
      signedUp({}, {}, { lastInteractionAt: new Date(NOW - 24 * HOUR) })
    );

    await confirm();

    expect(sends()).toBe(0);
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
    expect(mockPrisma.contactOffer.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.operationalEvent.create).toHaveBeenCalledWith(
      event("INFO", "Sign-up confirmation not sent: messaging window closed", {
        phase: "signup",
        reason: "WINDOW_CLOSED",
      })
    );
  });

  it("goes out up to the end of the window, counted from the last tap or DM", async () => {
    mockPrisma.contactOffer.findFirst.mockResolvedValue(
      signedUp({}, {}, { lastInteractionAt: new Date(NOW - 23 * HOUR) })
    );

    await confirm();

    expect(sends()).toBe(1);
  });

  it("skips with an INFO event when the account is unavailable", async () => {
    mockPrisma.contactOffer.findFirst.mockResolvedValue(
      signedUp({}, {}, { instagramAccount: { ...ACCOUNT, accessToken: "" } })
    );

    await confirm();

    expect(sends()).toBe(0);
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
    expect(stopWrites()).toEqual([]);
    expect(mockPrisma.operationalEvent.create).toHaveBeenCalledWith(
      event("INFO", "Sign-up confirmation not sent: the Instagram account is unavailable", {
        phase: "signup",
        reason: "ACCOUNT_UNAVAILABLE",
      })
    );
  });

  it("reports a refusal as a WARNING, keeps the offer as it is and leaves it unsent", async () => {
    mockSendDirectMessage.mockRejectedValue(
      new MetaApiError(100, undefined, undefined, "Invalid parameter")
    );

    await confirm();

    expect(stopWrites()).toEqual([]);
    expect(mockPrisma.contactOffer.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.postbackDelivery.delete).toHaveBeenCalledWith({
      where: { id: claimId("signup", 0) },
    });
    expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalledTimes(1);
    expect(mockPrisma.operationalEvent.create).toHaveBeenCalledWith(
      event("WARNING", "Sign-up confirmation not sent: Instagram refused a message", {
        phase: "signup",
        reason: "REJECTED",
      })
    );
  });

  it("reports Instagram's closed window as INFO", async () => {
    mockSendDirectMessage.mockRejectedValue(
      new MetaApiError(10, 2534022, undefined, "This message is sent outside of allowed window.")
    );

    await confirm();

    expect(stopWrites()).toEqual([]);
    expect(mockPrisma.operationalEvent.create).toHaveBeenCalledWith(
      event("INFO", "Sign-up confirmation not sent: messaging window closed", {
        reason: "WINDOW_CLOSED",
      })
    );
  });

  it("retries Zernio's rate limit while attempts are left and reports it on the last one", async () => {
    mockSendDirectMessage.mockRejectedValue(zernioLimit());

    await expect(confirm({ attemptsMade: 0 })).rejects.toBeInstanceOf(RateLimitError);
    expect(mockPrisma.operationalEvent.create).not.toHaveBeenCalled();

    await confirm({ attemptsMade: 2 });

    expect(stopWrites()).toEqual([]);
    expect(mockPrisma.contactOffer.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.operationalEvent.create).toHaveBeenCalledWith(
      event("WARNING", "Sign-up confirmation not sent: Instagram rate limit reached", {
        reason: "RATE_LIMITED",
      })
    );
  });

  it("records an unknown outcome as sent, so it never goes out twice", async () => {
    mockSendDirectMessage.mockRejectedValue(
      new MetaApiError(1, undefined, undefined, "An unknown error occurred")
    );

    await confirm();

    expect(mockPrisma.contactOffer.updateMany).toHaveBeenCalledWith({
      where: { id: "co1", signupMessageSentAt: null },
      data: { signupMessageSentAt: new Date(NOW) },
    });
    expect(mockPrisma.operationalEvent.create).toHaveBeenCalledWith(
      event("WARNING", "Offer message delivery unconfirmed", { phase: "signup", step: 0 })
    );
  });

  it("reports the monthly limit as a WARNING and sends nothing", async () => {
    mockReserveWorkspaceDMSend.mockResolvedValue({
      allowed: false,
      reserved: false,
      remaining: 0,
      limit: 2000,
      periodStart: USAGE_PERIOD,
    });

    await confirm();

    expect(sends()).toBe(0);
    expect(mockPrisma.postbackDelivery.create).not.toHaveBeenCalled();
    expect(stopWrites()).toEqual([]);
    expect(mockPrisma.operationalEvent.create).toHaveBeenCalledWith(
      event("WARNING", "Sign-up confirmation not sent: monthly DM limit reached", {
        reason: "PLAN_LIMIT",
      })
    );
  });

  it("sends nothing for a deleted offer, and says so", async () => {
    mockPrisma.contactOffer.findFirst.mockResolvedValue(
      signedUp({}, { archivedAt: new Date(NOW - HOUR), isActive: false })
    );

    await confirm();

    expect(sends()).toBe(0);
    expect(mockPrisma.contactOffer.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.operationalEvent.create).toHaveBeenCalledWith(
      event("INFO", "Sign-up confirmation not sent: offer was deleted", { reason: "OFFER_ARCHIVED" })
    );
  });

  it("still goes out while the offer is paused", async () => {
    mockPrisma.contactOffer.findFirst.mockResolvedValue(signedUp({}, { isActive: false }));

    await confirm();

    expect(sends()).toBe(1);
  });

  it.each([
    { label: "without a recorded sign-up", row: { signedUpAt: null }, offer: {} },
    { label: "once the text was emptied", row: {}, offer: { signupMessage: "   " } },
    { label: "without a text", row: {}, offer: { signupMessage: null } },
  ])("sends nothing $label", async ({ row, offer }) => {
    mockPrisma.contactOffer.findFirst.mockResolvedValue(signedUp(row, offer));

    await confirm();

    expect(sends()).toBe(0);
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
    expect(mockPrisma.contactOffer.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.operationalEvent.create).not.toHaveBeenCalled();
  });

  it("does nothing for a row that is gone, as after the contact was deleted", async () => {
    mockPrisma.contactOffer.findFirst.mockResolvedValue(null);

    await confirm();

    expect(sends()).toBe(0);
    expect(mockPrisma.contactOffer.updateMany).not.toHaveBeenCalled();
  });
});

// R1: a Meta request limit costs an offer message time, not the message.
// While the account is paused, or once Instagram refused a message with a
// limit, the message's job runs again after the pause as <its id>_pause_<n>
// and sends the same message under the same claim. Only a closed window by
// then, and twelve waits, still stop the offer.
describe("Meta request limits: offer messages wait for the account's pause", () => {
  const PAUSE_KEY = "meta:pause:ig_456";
  const fake = () => redis.current as FakeRedis;

  // Meta's answer while the app is over its limit, as seen live.
  function limit(code = 4) {
    return Object.assign(
      new RateLimitError(
        `(#4) Application request limit reached (/v25.0/ig_456/messages) [code=${code} sub=- type=OAuthException trace=t]`
      ),
      { code }
    );
  }

  function pauseFor(minutes: number) {
    return fake().set(PAUSE_KEY, String(NOW + minutes * MINUTE), "PX", minutes * MINUTE);
  }

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

  function stopWrites() {
    return mockPrisma.contactOffer.updateMany.mock.calls.filter(
      ([args]) => "stopReason" in (args as { data: object }).data
    );
  }

  // The job BullMQ runs for a queued copy, at the time it was queued for.
  function runCopy([name, data, opts]: unknown[], extra: Record<string, unknown> = {}) {
    const { jobId, delay } = opts as { jobId: string; delay: number };
    vi.setSystemTime(NOW + delay);
    const job = {
      name,
      id: jobId,
      attemptsMade: 0,
      opts: { attempts: 3 },
      timestamp: NOW,
      data,
      ...extra,
    };
    return name === "process-postback"
      ? processOfferTap(job as unknown as Job<ProcessPostbackJob>)
      : processOffer(job as unknown as Job<ProcessOfferJob>);
  }

  const interested = (row: Record<string, unknown> = {}, offer: Partial<typeof OFFER> = {}) =>
    contactOffer(
      {
        pitchSentAt: new Date(NOW - 10 * MINUTE),
        interestedAt: new Date(NOW - 5000),
        interestedMid: "mid_yes",
        ...row,
      },
      offer,
      { lastInteractionAt: new Date(NOW - 5000) }
    );

  const step = (i: number, data: Partial<ProcessOfferJob> = {}, job = {}) =>
    processOffer(
      offerJob({ phase: "offer", contactOfferId: "co1", step: i, ...data }, job)
    );

  beforeEach(() => {
    mockPrisma.contactOffer.findFirst.mockResolvedValue(contactOffer());
  });

  it("waits for the pause without reserving, claiming or sending", async () => {
    await pauseFor(10);

    await expect(step(0)).resolves.toBeUndefined();

    expect(sends()).toBe(0);
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
    expect(mockPrisma.postbackDelivery.create).not.toHaveBeenCalled();
    // The offer goes on; it is not stopped.
    expect(stopWrites()).toEqual([]);
    expect(pauseCopies()).toEqual([
      [
        "process-offer",
        { ...JOB_BASE, phase: "offer", contactOfferId: "co1", step: 0, pauseRequeue: 1 },
        {
          jobId: "offer_co1_offer_0_pause_1",
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
    // The next message waits for this one.
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
  });

  it("pauses the account and waits when Instagram refuses a message with a request limit", async () => {
    mockSendDirectMessage.mockRejectedValueOnce(limit(4));

    // No error: BullMQ's retries after 5 and 15 minutes would only run into
    // the limit again.
    await expect(step(0)).resolves.toBeUndefined();

    // Refused: the claim and the reservation go back, as for any refusal.
    expect(mockPrisma.postbackDelivery.delete).toHaveBeenCalledWith({
      where: { id: claimId("offer", 0) },
    });
    expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalledTimes(1);
    await expect(fake().get(PAUSE_KEY)).resolves.toBe(String(NOW + 20 * MINUTE));
    expect(pauseEvents()).toHaveLength(1);
    expect(pauseEvents()[0][0].data).toMatchObject({
      workspaceId: "workspace_123",
      level: "WARNING",
      message: "Instagram request limit reached for @brand: sending paused until 12:30 UTC",
    });
    expect(stopWrites()).toEqual([]);
    expect(pauseCopies().map(([, , opts]) => opts.jobId)).toEqual([
      "offer_co1_offer_0_pause_1",
    ]);
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
  });

  it.each([17, 32, 613, 80002, 80006, 368])("waits for code %i as well", async (code) => {
    mockSendDirectMessage.mockRejectedValueOnce(limit(code));

    await expect(step(0)).resolves.toBeUndefined();

    expect(pauseCopies()).toHaveLength(1);
    await expect(fake().get(PAUSE_KEY)).resolves.toBe(
      String(NOW + (code === 368 ? 60 : 20) * MINUTE)
    );
  });

  it("sends the message with its copy after the pause, once, and goes on", async () => {
    const claims = new Set<string>();
    mockPrisma.postbackDelivery.create.mockImplementation(
      async ({ data }: { data: { id: string } }) => {
        if (claims.has(data.id)) throw { code: "P2002" };
        claims.add(data.id);
        return data;
      }
    );
    mockPrisma.postbackDelivery.delete.mockImplementation(
      async ({ where }: { where: { id: string } }) => {
        claims.delete(where.id);
      }
    );
    mockSendDirectMessage.mockRejectedValueOnce(limit(4));
    await step(0);
    const [copy] = pauseCopies();
    mockQueueAdd.mockClear();

    // The copy and a retry of the same step (a redelivered job) race.
    await Promise.all([runCopy(copy), step(0, {}, { attemptsMade: 1 })]);

    // The refused try and one send, under the step's one claim.
    expect(mockSendDirectMessage).toHaveBeenCalledTimes(2);
    expect(mockSendDirectMessage).toHaveBeenLastCalledWith(
      META_AUTH,
      "ig_456",
      "commenter_999",
      "Ich hab übrigens noch einen Guide, commenter_user."
    );
    expect([...claims]).toEqual([claimId("offer", 0)]);
    // Both go on with the next message, which its id keeps to one job.
    expect(mockQueueAdd.mock.calls.map(([, , opts]) => opts.jobId)).toEqual([
      "offer_co1_offer_1",
      "offer_co1_offer_1",
    ]);
  });

  it.each([
    {
      label: "the last offer message with its button",
      phase: "offer" as const,
      stepNo: 2,
      row: () => contactOffer(),
      refuse: () => mockSendDirectMessageWithButton.mockRejectedValueOnce(limit()),
      jobId: "offer_co1_offer_2_pause_1",
    },
    {
      label: "a confirmation",
      phase: "confirm" as const,
      stepNo: 1,
      row: () => interested(),
      refuse: () => mockSendDirectMessage.mockRejectedValueOnce(limit()),
      jobId: "offer_co1_confirm_1_pause_1",
    },
    {
      label: "the card",
      phase: "card" as const,
      stepNo: undefined,
      row: () => interested(),
      refuse: () => mockSendDirectMessageWithCard.mockRejectedValueOnce(limit()),
      jobId: "offer_co1_card_pause_1",
    },
    {
      label: "the card's button fallback",
      phase: "card" as const,
      stepNo: undefined,
      row: () => interested(),
      refuse: () => {
        mockSendDirectMessageWithCard.mockRejectedValueOnce(
          new MetaApiError(100, undefined, undefined, "Invalid image_url")
        );
        mockSendDirectMessageWithLinkButton.mockRejectedValueOnce(limit());
      },
      jobId: "offer_co1_card_pause_1",
    },
    {
      label: "the card's text fallback",
      phase: "card" as const,
      stepNo: undefined,
      row: () => interested(),
      refuse: () => {
        mockSendDirectMessageWithCard.mockRejectedValueOnce(
          new MetaApiError(100, undefined, undefined, "Invalid image_url")
        );
        mockSendDirectMessageWithLinkButton.mockRejectedValueOnce(
          new MetaApiError(100, undefined, undefined, "Unsupported button template")
        );
        mockSendDirectMessage.mockRejectedValueOnce(limit());
      },
      jobId: "offer_co1_card_pause_1",
    },
    {
      label: "the reminder",
      phase: "reminder" as const,
      stepNo: undefined,
      row: () =>
        contactOffer({ pitchSentAt: new Date(NOW - 22 * HOUR) }, {}, {
          lastInteractionAt: new Date(NOW - 23 * HOUR),
        }),
      refuse: () => mockSendDirectMessageWithLinkButton.mockRejectedValueOnce(limit()),
      jobId: "offer_co1_reminder_pause_1",
    },
    {
      label: "the reminder's text fallback",
      phase: "reminder" as const,
      stepNo: undefined,
      row: () =>
        contactOffer({ pitchSentAt: new Date(NOW - 22 * HOUR) }, {}, {
          lastInteractionAt: new Date(NOW - 23 * HOUR),
        }),
      refuse: () => {
        mockSendDirectMessageWithLinkButton.mockRejectedValueOnce(
          new MetaApiError(100, undefined, undefined, "Unsupported button template")
        );
        mockSendDirectMessage.mockRejectedValueOnce(limit());
      },
      jobId: "offer_co1_reminder_pause_1",
    },
  ])("waits with $label, as its own job", async ({ phase, stepNo, row, refuse, jobId }) => {
    mockPrisma.contactOffer.findFirst.mockResolvedValue(row());
    refuse();
    const data = {
      phase,
      contactOfferId: "co1",
      ...(stepNo === undefined ? {} : { step: stepNo }),
    };

    await expect(processOffer(offerJob(data))).resolves.toBeUndefined();

    expect(stopWrites()).toEqual([]);
    expect(pauseCopies()).toEqual([
      [
        "process-offer",
        { ...JOB_BASE, ...data, pauseRequeue: 1 },
        { jobId, delay: expect.any(Number), removeOnComplete: true },
      ],
    ]);
    // Nothing was delivered: nothing is recorded as sent, nothing queued next.
    expect(mockPrisma.contactOffer.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.contactTag.createMany).not.toHaveBeenCalled();
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
  });

  it("stops for the closed window when it closes before the pause ends", async () => {
    // The window closes 35 minutes from now (5 of them margin), the block
    // lasts an hour.
    mockPrisma.contactOffer.findFirst.mockResolvedValue(
      contactOffer({}, {}, { lastInteractionAt: new Date(NOW - 23 * HOUR - 20 * MINUTE) })
    );
    mockSendDirectMessage.mockRejectedValueOnce(limit(368));

    await expect(step(0)).resolves.toBeUndefined();

    expect(pauseCopies()).toEqual([]);
    expect(mockPrisma.contactOffer.updateMany).toHaveBeenCalledWith(stopWrite("WINDOW_CLOSED"));
    expect(mockPrisma.operationalEvent.create).toHaveBeenCalledWith(
      event("INFO", "Offer stopped: messaging window closed", {
        reason: "WINDOW_CLOSED",
        phase: "offer",
        step: 0,
        pausedUntil: "2026-11-20T13:10:00.000Z",
      })
    );
  });

  it("still waits late in the window when its copy runs before it closes", async () => {
    // 23 h 50 min after the last tap at the latest: inside the margin.
    mockPrisma.contactOffer.findFirst.mockResolvedValue(
      contactOffer({ pitchSentAt: new Date(NOW - 22 * HOUR) }, {}, {
        lastInteractionAt: new Date(NOW - 23 * HOUR - 30 * MINUTE),
      })
    );
    mockSendDirectMessageWithLinkButton.mockRejectedValueOnce(limit(4));

    await processOffer(offerJob({ phase: "reminder", contactOfferId: "co1" }));

    expect(stopWrites()).toEqual([]);
    expect(pauseCopies()).toHaveLength(1);
  });

  it("stops with RATE_LIMITED after the twelfth wait", async () => {
    mockSendDirectMessage.mockRejectedValueOnce(limit(4));

    await expect(step(0, { pauseRequeue: 12 })).resolves.toBeUndefined();

    expect(pauseCopies()).toEqual([]);
    expect(mockPrisma.contactOffer.updateMany).toHaveBeenCalledWith(stopWrite("RATE_LIMITED"));
    expect(mockPrisma.operationalEvent.create).toHaveBeenCalledWith(
      event("WARNING", "Offer stopped: Instagram rate limit reached", {
        reason: "RATE_LIMITED",
        phase: "offer",
        step: 0,
        waits: 12,
        error: expect.stringContaining("Application request limit reached"),
      })
    );
    // The account still pauses: the next message waits.
    await expect(fake().get(PAUSE_KEY)).resolves.toBe(String(NOW + 20 * MINUTE));
  });

  it("stops with RATE_LIMITED without calling Instagram when the thirteenth try still finds the pause", async () => {
    await pauseFor(10);

    await expect(step(0, { pauseRequeue: 12 })).resolves.toBeUndefined();

    expect(sends()).toBe(0);
    expect(mockReserveWorkspaceDMSend).not.toHaveBeenCalled();
    expect(pauseCopies()).toEqual([]);
    expect(mockPrisma.contactOffer.updateMany).toHaveBeenCalledWith(stopWrite("RATE_LIMITED"));
  });

  it("leaves Zernio's own limit to BullMQ's retries, pausing nothing", async () => {
    mockSendDirectMessage.mockRejectedValueOnce(zernioLimit());

    await expect(step(0)).rejects.toMatchObject({ name: "RateLimitError" });

    await expect(fake().get(PAUSE_KEY)).resolves.toBeNull();
    expect(pauseCopies()).toEqual([]);
  });

  it("sends as before when Redis cannot be read", async () => {
    redis.current = {
      get: async () => {
        throw new Error("Connection is closed.");
      },
    };
    vi.spyOn(console, "error").mockImplementation(() => {});

    await step(0);

    expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
  });

  describe("the sign-up confirmation", () => {
    const signedUp = (contact: Partial<typeof CONTACT> = {}) =>
      contactOffer(
        {
          pitchSentAt: new Date(NOW - 10 * MINUTE),
          interestedAt: new Date(TAP_TIME),
          sentAt: new Date(NOW - 50_000),
          sentVia: "CARD",
          signedUpAt: new Date(NOW - 1000),
        },
        { signupTrackingEnabled: true, signupMessage: "Danke fürs Eintragen!" },
        contact
      );
    const confirm = (data: Partial<ProcessOfferJob> = {}) =>
      processOffer(offerJob({ phase: "signup", contactOfferId: "co1", ...data }));

    beforeEach(() => {
      mockPrisma.contactOffer.findFirst.mockResolvedValue(signedUp());
    });

    it("waits for the pause and goes out after it", async () => {
      mockSendDirectMessage.mockRejectedValueOnce(limit(4));

      await expect(confirm()).resolves.toBeUndefined();

      expect(pauseCopies()).toEqual([
        [
          "process-offer",
          { ...JOB_BASE, phase: "signup", contactOfferId: "co1", pauseRequeue: 1 },
          { jobId: "offer_co1_signup_pause_1", delay: expect.any(Number), removeOnComplete: true },
        ],
      ]);
      expect(mockPrisma.contactOffer.updateMany).not.toHaveBeenCalled();

      await runCopy(pauseCopies()[0]);
      expect(mockSendDirectMessage).toHaveBeenCalledTimes(2);
      expect(mockPrisma.contactOffer.updateMany).toHaveBeenCalledWith({
        where: { id: "co1", signupMessageSentAt: null },
        data: { signupMessageSentAt: expect.any(Date) },
      });
    });

    it("reports a window that closes before the pause ends, and stops nothing", async () => {
      mockPrisma.contactOffer.findFirst.mockResolvedValue(
        signedUp({ lastInteractionAt: new Date(NOW - 23 * HOUR - 50 * MINUTE) })
      );
      mockSendDirectMessage.mockRejectedValueOnce(limit(4));

      await confirm();

      expect(pauseCopies()).toEqual([]);
      expect(stopWrites()).toEqual([]);
      expect(mockPrisma.operationalEvent.create).toHaveBeenCalledWith(
        event("INFO", "Sign-up confirmation not sent: messaging window closed", {
          phase: "signup",
          reason: "WINDOW_CLOSED",
        })
      );
    });

    it("reports the twelfth wait as a WARNING, and stops nothing", async () => {
      await pauseFor(10);

      await confirm({ pauseRequeue: 12 });

      expect(sends()).toBe(0);
      expect(stopWrites()).toEqual([]);
      expect(mockPrisma.operationalEvent.create).toHaveBeenCalledWith(
        event("WARNING", "Sign-up confirmation not sent: Instagram rate limit reached", {
          phase: "signup",
          reason: "RATE_LIMITED",
          waits: 12,
        })
      );
    });
  });

  describe("the card for a later tap", () => {
    const delivered = () =>
      contactOffer({
        pitchSentAt: new Date(NOW - 3 * HOUR),
        interestedAt: new Date(NOW - 2 * HOUR),
        interestedMid: "mid_yes",
        sentAt: new Date(NOW - 2 * HOUR),
        sentVia: "CARD",
      }, {}, { lastInteractionAt: new Date(NOW - 2 * HOUR) });
    const retapCopyId = `offer_co1_retap_${createHash("sha256")
      .update("mid_later")
      .digest("hex")}_pause_1`;

    beforeEach(() => {
      mockPrisma.contactOffer.findUnique.mockResolvedValue(delivered());
      mockPrisma.contactOffer.updateMany.mockResolvedValue({ count: 0 });
    });

    it("waits as a copy of the tap and sends the card once after the pause", async () => {
      mockSendDirectMessageWithCard.mockRejectedValueOnce(limit(4));

      await expect(processOfferTap(tapJob({ mid: "mid_later" }))).resolves.toBeUndefined();

      expect(pauseCopies()).toEqual([
        [
          "process-postback",
          {
            instagramAccountId: "ig_456",
            accountConnectionId: "ig_account_row_1",
            userId: "commenter_999",
            payload: "offer:co1",
            mid: "mid_later",
            tappedAt: NOW,
            tapId: "mid_later",
            pauseRequeue: 1,
          },
          { jobId: retapCopyId, delay: expect.any(Number), removeOnComplete: true },
        ],
      ]);

      await runCopy(pauseCopies()[0]);

      expect(mockSendDirectMessageWithCard).toHaveBeenCalledTimes(2);
      // The same claim as the tap's own try.
      expect(mockPrisma.postbackDelivery.create.mock.calls).toEqual([
        [{ data: { id: claimId("retap", "mid_later") } }],
        [{ data: { id: claimId("retap", "mid_later") } }],
      ]);
      // The window still counts from the tap, not from the copy.
      expect(mockPrisma.contact.updateMany).toHaveBeenLastCalledWith(
        expect.objectContaining({ data: { lastInteractionAt: new Date(NOW) } })
      );
    });

    it("counts the window from the tap, even when the row was read before it", async () => {
      // The person's last interaction before this tap was 23 h 50 min ago:
      // without the tap the window would be closed by the end of the pause.
      mockPrisma.contactOffer.findUnique.mockResolvedValue({
        ...delivered(),
        contact: { ...CONTACT, lastInteractionAt: new Date(NOW - 23 * HOUR - 50 * MINUTE) },
      });
      mockSendDirectMessageWithCard.mockRejectedValueOnce(limit(4));

      await processOfferTap(tapJob({ mid: "mid_later" }));

      expect(pauseCopies()).toHaveLength(1);
    });
  });
});

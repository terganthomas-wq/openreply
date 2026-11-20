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
    contact: { upsert: vi.fn(), updateMany: vi.fn() },
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
  OFFER_JOB_NAME: "process-offer",
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

  it("retries a rate limit while attempts are left", async () => {
    mockSendDirectMessage.mockRejectedValue(new RateLimitError("Too many messages"));

    await expect(step(0)).rejects.toMatchObject({ name: "RateLimitError" });

    // Refused, so the claim and the reservation go back for the retry.
    expect(mockPrisma.postbackDelivery.delete).toHaveBeenCalledWith({
      where: { id: claimId("offer", 0) },
    });
    expect(mockReleaseWorkspaceDMReservation).toHaveBeenCalledTimes(1);
    expect(mockPrisma.contactOffer.updateMany).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it("stops with RATE_LIMITED on the last attempt", async () => {
    mockSendDirectMessage.mockRejectedValue(new RateLimitError("Too many messages"));

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
      expect(mockQueueAdd).not.toHaveBeenCalled();
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

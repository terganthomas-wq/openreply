-- Additive only: eight InstagramAccount columns, seven nullable and one
-- integer with a default, and an index on WebhookEvent."createdAt". The
-- worker's messaging silence check (A2) records here that Instagram passes on
-- no button taps, DMs, read receipts or reactions: the first silent check
-- (messagingSilenceCheckAt), the open incident (messagingSilentSince), the
-- last one that ended (messagingSilenceResult), the warning e-mails
-- (messagingAlertSentAt, messagingAlertRearmedAt, messagingAlertCount) and
-- the all-clear (messagingAllClearDueAt, messagingAllClearSentAt). Existing
-- accounts start without an incident (every column NULL, the count 0), so
-- nothing changes for them until two checks find the messaging events
-- missing. The check reads the newest messaging events of an account with
-- every sweep; WebhookEvent rows are never deleted, so the index keeps that a
-- range read. The previous web app and worker never read the columns.

-- AlterTable
ALTER TABLE "InstagramAccount" ADD COLUMN     "messagingAlertCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "messagingAlertRearmedAt" TIMESTAMP(3),
ADD COLUMN     "messagingAlertSentAt" TIMESTAMP(3),
ADD COLUMN     "messagingAllClearDueAt" TIMESTAMP(3),
ADD COLUMN     "messagingAllClearSentAt" TIMESTAMP(3),
ADD COLUMN     "messagingSilenceCheckAt" TIMESTAMP(3),
ADD COLUMN     "messagingSilenceResult" JSONB,
ADD COLUMN     "messagingSilentSince" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "WebhookEvent_createdAt_idx" ON "WebhookEvent"("createdAt");

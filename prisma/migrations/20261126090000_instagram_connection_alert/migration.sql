-- Additive only: seven InstagramAccount columns, six nullable and one integer
-- with a default. The worker's connection check (A1) records a lost Instagram
-- connection here: the first failed check (connectionCheckFailedAt), the open
-- incident and its reason (connectionLostAt, connectionLostReason), the alert
-- e-mails (connectionAlertSentAt, connectionAlertCount), when it ended
-- (connectionRecoveredAt) and the start of an ended incident whose missed
-- comments are still to be caught up (connectionCatchUpFrom). Existing
-- accounts start without an incident (every column NULL, the count 0), so
-- nothing changes for them until a check fails twice. The previous web app
-- and worker never read the columns.

-- AlterTable
ALTER TABLE "InstagramAccount" ADD COLUMN     "connectionAlertCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "connectionAlertSentAt" TIMESTAMP(3),
ADD COLUMN     "connectionCatchUpFrom" TIMESTAMP(3),
ADD COLUMN     "connectionCheckFailedAt" TIMESTAMP(3),
ADD COLUMN     "connectionLostAt" TIMESTAMP(3),
ADD COLUMN     "connectionLostReason" TEXT,
ADD COLUMN     "connectionRecoveredAt" TIMESTAMP(3);

-- Additive only: two nullable InstagramAccount columns for the alert e-mail
-- about a lost Instagram connection (A1). connectionAllClearSentAt is when the
-- last all-clear e-mail ("Instagram-Verbindung wieder da") reached an owner or
-- admin, connectionAlertRearmedAt when an alert went out inside the 24 hours
-- of the last warning because such an all-clear came after it. A connection
-- that drops again after the all-clear then gets its alert at once instead of
-- up to 24 hours later, at most once per 24 hours. Existing accounts get NULL
-- in both, which keeps today's rule. The previous web app and worker never
-- read the columns.

-- AlterTable
ALTER TABLE "InstagramAccount" ADD COLUMN     "connectionAlertRearmedAt" TIMESTAMP(3),
ADD COLUMN     "connectionAllClearSentAt" TIMESTAMP(3);

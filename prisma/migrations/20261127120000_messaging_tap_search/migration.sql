-- Additive only: four nullable InstagramAccount columns. After a messaging
-- silence (A2) the worker searches the conversations of the people who got an
-- opening DM in it for the button taps Instagram swallowed, and continues
-- those flows: the silence whose search is owed (messagingTapSearchFrom, from
-- its start, and messagingTapSearchUntil, its end), the lease of the run that
-- searches right now (messagingTapSearchClaimedAt) and how far a run that
-- stopped early got (messagingTapSearchProgress). The result goes into the
-- existing messagingSilenceResult. Existing accounts owe no search (every
-- column NULL), so nothing changes for them until a silence ends. The
-- previous web app and worker never read the columns.

-- AlterTable
ALTER TABLE "InstagramAccount" ADD COLUMN     "messagingTapSearchClaimedAt" TIMESTAMP(3),
ADD COLUMN     "messagingTapSearchFrom" TIMESTAMP(3),
ADD COLUMN     "messagingTapSearchProgress" JSONB,
ADD COLUMN     "messagingTapSearchUntil" TIMESTAMP(3);

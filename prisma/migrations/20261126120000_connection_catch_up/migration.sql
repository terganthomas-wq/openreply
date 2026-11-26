-- Additive only: four nullable InstagramAccount columns for the catch-up
-- after a lost Instagram connection (A1). When an incident ends, the worker
-- reads the comments missed in the meantime and queues their DMs: the run
-- that does it holds connectionCatchUpClaimedAt, a run that stopped early (an
-- R1 pause, a Meta limit, a worker restart) keeps how far it got in
-- connectionCatchUpProgress, the finished catch-up is kept in
-- connectionCatchUpResult (Diagnostics and the all-clear e-mail read it), and
-- connectionAllClearDueAt says that its all-clear e-mail is still to go out.
-- Existing accounts get NULL everywhere, which means nothing is running or
-- owed. The previous app and worker never read these columns.

-- AlterTable
ALTER TABLE "InstagramAccount" ADD COLUMN     "connectionAllClearDueAt" TIMESTAMP(3),
ADD COLUMN     "connectionCatchUpClaimedAt" TIMESTAMP(3),
ADD COLUMN     "connectionCatchUpProgress" JSONB,
ADD COLUMN     "connectionCatchUpResult" JSONB;

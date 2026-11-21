-- Additive only: two columns with defaults. A campaign can start its offer 22
-- hours after the link instead of right after it (Automation.offerDelayHours),
-- and an offer row records that it started late, which leaves its reminder
-- out (ContactOffer.lateStart). Existing campaigns get 0 and existing offer
-- rows false: everything keeps starting right after the link and keeps its
-- reminder, as before. The previous web app and worker never read either
-- column.

-- AlterTable
ALTER TABLE "Automation" ADD COLUMN     "offerDelayHours" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "ContactOffer" ADD COLUMN     "lateStart" BOOLEAN NOT NULL DEFAULT false;

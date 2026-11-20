-- Additive only: one nullable Offer column. Deleting an offer archives it when
-- it was ever offered, so card links already sent keep redirecting. That used
-- to be read from the offer's ContactOffer rows, which go with their contacts
-- when an Instagram account is disconnected; the time of the first offer
-- survives that. The previous web app and worker never read the column.

-- AlterTable
ALTER TABLE "Offer" ADD COLUMN     "firstOfferedAt" TIMESTAMP(3);

-- Offers already started for someone count as offered since their first
-- start. Only unmarked offers are written, and updatedAt is left alone because
-- the offers themselves did not change.
UPDATE "Offer" AS offer
SET "firstOfferedAt" = started."offeredAt"
FROM (
  SELECT "offerId", MIN("offeredAt") AS "offeredAt"
  FROM "ContactOffer"
  GROUP BY "offerId"
) AS started
WHERE offer."id" = started."offerId"
  AND offer."firstOfferedAt" IS NULL;

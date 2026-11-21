-- Additive only: three Offer columns, three nullable ContactOffer columns and
-- one unique index. An offer can have its landing page report sign-ups back:
-- its links then carry a personal code (ContactOffer.signupToken, created on
-- the first click, NULL until then; NULLs never collide in the unique index),
-- a report sets signedUpAt and the offer's "signed up" tag (Offer.tagSignedUp),
-- and the chat confirmation (Offer.signupMessage) records signupMessageSentAt.
-- Existing offers keep it off (signupTrackingEnabled false, no message), so
-- their links and sends stay exactly as before. The previous web app and
-- worker never read the columns; the default '' of tagSignedUp only covers an
-- offer the previous web app creates while a deployment runs.

-- AlterTable
ALTER TABLE "Offer" ADD COLUMN     "signupMessage" TEXT,
ADD COLUMN     "signupTrackingEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "tagSignedUp" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "ContactOffer" ADD COLUMN     "signedUpAt" TIMESTAMP(3),
ADD COLUMN     "signupMessageSentAt" TIMESTAMP(3),
ADD COLUMN     "signupToken" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "ContactOffer_signupToken_key" ON "ContactOffer"("signupToken");

-- Existing offers get their "signed up" tag the way new ones get theirs from
-- the tag templates: the offer's name and the word for the stage. An offer
-- whose "offered" tag ends in "offered" (the English template) gets
-- "<name> signed up", every other one the German built-in set's
-- "<name> eingetragen". Cut to the 100 characters a tag may have. updatedAt is
-- left alone: the offers themselves did not change.
UPDATE "Offer"
SET "tagSignedUp" = btrim(left(
  btrim("name") || CASE WHEN "tagOffered" ILIKE '% offered' THEN ' signed up' ELSE ' eingetragen' END,
  100
))
WHERE "tagSignedUp" = '';

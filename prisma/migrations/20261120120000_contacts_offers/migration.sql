-- Additive only: four new tables, six new Automation columns (all defaulting to
-- today's behaviour: offers off, question comments not ignored, no delivery tag),
-- one nullable Workspace column and two indexes. Campaign links, clicks and logs
-- are untouched, so the previous web app and worker keep working on this schema.

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "messageDefaults" JSONB;

-- AlterTable
ALTER TABLE "Automation" ADD COLUMN     "deliveryTag" TEXT,
ADD COLUMN     "followPromptRetryButtonLabel" TEXT,
ADD COLUMN     "followPromptRetryMessage" TEXT,
ADD COLUMN     "ignoreQuestionComments" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "offerIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "offersEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "igsid" TEXT NOT NULL,
    "username" TEXT,
    "recipientHash" TEXT NOT NULL,
    "lastInteractionAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactTag" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "tag" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Offer" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "archivedAt" TIMESTAMP(3),
    "offerMessages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "offerDelaysSeconds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "offerButtonLabel" TEXT NOT NULL,
    "confirmationMessages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "confirmationDelaysSeconds" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "cardImageUrl" TEXT,
    "cardTitle" TEXT NOT NULL,
    "cardSubtitle" TEXT,
    "cardButtonLabel" TEXT NOT NULL,
    "destinationUrl" TEXT NOT NULL,
    "linkSlug" TEXT NOT NULL,
    "reminderEnabled" BOOLEAN NOT NULL DEFAULT true,
    "reminderDelayHours" INTEGER NOT NULL DEFAULT 23,
    "reminderMessage" TEXT,
    "tagOffered" TEXT NOT NULL,
    "tagInterested" TEXT NOT NULL,
    "tagSent" TEXT NOT NULL,
    "tagClicked" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Offer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactOffer" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "automationId" TEXT,
    "startKey" TEXT,
    "offeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "pitchSentAt" TIMESTAMP(3),
    "interestedAt" TIMESTAMP(3),
    "interestedMid" TEXT,
    "sentAt" TIMESTAMP(3),
    "sentVia" TEXT,
    "reminderSentAt" TIMESTAMP(3),
    "clickedAt" TIMESTAMP(3),
    "stoppedAt" TIMESTAMP(3),
    "stopReason" TEXT,

    CONSTRAINT "ContactOffer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Contact_workspaceId_updatedAt_idx" ON "Contact"("workspaceId", "updatedAt");

-- CreateIndex
CREATE INDEX "Contact_workspaceId_recipientHash_idx" ON "Contact"("workspaceId", "recipientHash");

-- CreateIndex
CREATE UNIQUE INDEX "Contact_instagramAccountId_igsid_key" ON "Contact"("instagramAccountId", "igsid");

-- CreateIndex
CREATE INDEX "ContactTag_workspaceId_tag_idx" ON "ContactTag"("workspaceId", "tag");

-- CreateIndex
CREATE UNIQUE INDEX "ContactTag_contactId_tag_key" ON "ContactTag"("contactId", "tag");

-- CreateIndex
CREATE UNIQUE INDEX "Offer_linkSlug_key" ON "Offer"("linkSlug");

-- CreateIndex
CREATE INDEX "Offer_workspaceId_position_idx" ON "Offer"("workspaceId", "position");

-- CreateIndex
CREATE INDEX "ContactOffer_contactId_automationId_idx" ON "ContactOffer"("contactId", "automationId");

-- CreateIndex
CREATE INDEX "ContactOffer_workspaceId_offerId_idx" ON "ContactOffer"("workspaceId", "offerId");

-- CreateIndex
CREATE INDEX "ContactOffer_automationId_idx" ON "ContactOffer"("automationId");

-- CreateIndex
CREATE UNIQUE INDEX "ContactOffer_contactId_offerId_key" ON "ContactOffer"("contactId", "offerId");

-- CreateIndex
CREATE UNIQUE INDEX "ContactOffer_contactId_startKey_key" ON "ContactOffer"("contactId", "startKey");

-- CreateIndex
CREATE INDEX "DmLog_commenterId_idx" ON "DmLog"("commenterId");

-- CreateIndex
CREATE INDEX "LinkClick_workspaceId_recipientHash_idx" ON "LinkClick"("workspaceId", "recipientHash");

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_instagramAccountId_fkey" FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactTag" ADD CONSTRAINT "ContactTag_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactTag" ADD CONSTRAINT "ContactTag_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Offer" ADD CONSTRAINT "Offer_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactOffer" ADD CONSTRAINT "ContactOffer_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactOffer" ADD CONSTRAINT "ContactOffer_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactOffer" ADD CONSTRAINT "ContactOffer_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "Offer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactOffer" ADD CONSTRAINT "ContactOffer_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

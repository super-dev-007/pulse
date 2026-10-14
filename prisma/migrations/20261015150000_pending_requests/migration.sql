-- AlterTable
ALTER TABLE "Presence" ADD COLUMN "outgoingTo" TEXT;
-- CreateIndex
CREATE INDEX "Presence_outgoingTo_idx" ON "Presence"("outgoingTo");

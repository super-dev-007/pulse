-- AlterTable
ALTER TABLE "Presence" ADD COLUMN "partnerId" TEXT;

-- CreateIndex
CREATE INDEX "Presence_partnerId_idx" ON "Presence"("partnerId");

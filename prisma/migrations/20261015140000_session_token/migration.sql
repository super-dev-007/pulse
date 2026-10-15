-- Sessions now authenticate with a server-issued secret token. Existing rows
-- have no token and are transient coordination state anyway (live presence +
-- undelivered signals), so drop them: every client simply re-joins.
DELETE FROM "Signal";
DELETE FROM "Presence";

-- AlterTable
ALTER TABLE "Presence" ADD COLUMN "tokenHash" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Presence_tokenHash_key" ON "Presence"("tokenHash");

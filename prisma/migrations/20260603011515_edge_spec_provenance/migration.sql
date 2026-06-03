-- AlterTable
ALTER TABLE "Edge" ADD COLUMN     "sourceSpecId" TEXT,
ADD COLUMN     "specKey" TEXT;

-- CreateIndex
CREATE INDEX "Edge_sourceSpecId_idx" ON "Edge"("sourceSpecId");

-- AddForeignKey
ALTER TABLE "Edge" ADD CONSTRAINT "Edge_sourceSpecId_fkey" FOREIGN KEY ("sourceSpecId") REFERENCES "Spec"("id") ON DELETE SET NULL ON UPDATE CASCADE;


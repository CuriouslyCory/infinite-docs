-- AlterTable
ALTER TABLE "Node" ADD COLUMN     "embeddedProjectId" TEXT;

-- CreateIndex
CREATE INDEX "Node_embeddedProjectId_idx" ON "Node"("embeddedProjectId");

-- AddForeignKey
ALTER TABLE "Node" ADD CONSTRAINT "Node_embeddedProjectId_fkey" FOREIGN KEY ("embeddedProjectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;


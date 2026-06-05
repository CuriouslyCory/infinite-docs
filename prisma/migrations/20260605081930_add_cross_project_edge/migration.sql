-- CreateTable
CREATE TABLE "CrossProjectEdge" (
    "id" TEXT NOT NULL,
    "hostProjectId" TEXT NOT NULL,
    "hostNodeId" TEXT NOT NULL,
    "referenceNodeId" TEXT NOT NULL,
    "foreignProjectId" TEXT NOT NULL,
    "foreignNodeId" TEXT NOT NULL,
    "interaction" "Interaction" NOT NULL DEFAULT 'ASSOCIATION',
    "label" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrossProjectEdge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CrossProjectEdge_hostProjectId_idx" ON "CrossProjectEdge"("hostProjectId");

-- CreateIndex
CREATE INDEX "CrossProjectEdge_referenceNodeId_idx" ON "CrossProjectEdge"("referenceNodeId");

-- CreateIndex
CREATE INDEX "CrossProjectEdge_hostNodeId_idx" ON "CrossProjectEdge"("hostNodeId");

-- CreateIndex
CREATE INDEX "CrossProjectEdge_foreignNodeId_idx" ON "CrossProjectEdge"("foreignNodeId");

-- CreateIndex
CREATE INDEX "CrossProjectEdge_deletionId_idx" ON "CrossProjectEdge"("deletionId");

-- AddForeignKey
ALTER TABLE "CrossProjectEdge" ADD CONSTRAINT "CrossProjectEdge_hostProjectId_fkey" FOREIGN KEY ("hostProjectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrossProjectEdge" ADD CONSTRAINT "CrossProjectEdge_hostNodeId_fkey" FOREIGN KEY ("hostNodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrossProjectEdge" ADD CONSTRAINT "CrossProjectEdge_referenceNodeId_fkey" FOREIGN KEY ("referenceNodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;


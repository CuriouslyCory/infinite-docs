-- CreateTable
CREATE TABLE "Trace" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletionId" TEXT,

    CONSTRAINT "Trace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TracePoint" (
    "id" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TracePoint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Trace_projectId_idx" ON "Trace"("projectId");

-- CreateIndex
CREATE INDEX "Trace_deletionId_idx" ON "Trace"("deletionId");

-- CreateIndex
CREATE INDEX "TracePoint_traceId_idx" ON "TracePoint"("traceId");

-- CreateIndex
CREATE INDEX "TracePoint_nodeId_idx" ON "TracePoint"("nodeId");

-- CreateIndex
CREATE UNIQUE INDEX "TracePoint_traceId_nodeId_key" ON "TracePoint"("traceId", "nodeId");

-- AddForeignKey
ALTER TABLE "Trace" ADD CONSTRAINT "Trace_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TracePoint" ADD CONSTRAINT "TracePoint_traceId_fkey" FOREIGN KEY ("traceId") REFERENCES "Trace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TracePoint" ADD CONSTRAINT "TracePoint_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Unique Trace name per Project among LIVE rows only (#59). A soft-deleted Trace
-- must not reserve its name. Prisma cannot express a partial predicate, so this
-- is raw SQL, mirroring idx_spec_owner_live (ADR-0010). The service does its own
-- findFirst pre-check and maps a P2002 on this index to a ConflictError
-- (service-primary, index-backstop doctrine).
CREATE UNIQUE INDEX "idx_trace_name_per_project_live"
  ON "Trace" ("projectId", "name")
  WHERE "deletedAt" IS NULL;


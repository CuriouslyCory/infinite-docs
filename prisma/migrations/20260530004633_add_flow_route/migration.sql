-- CreateTable
CREATE TABLE "FlowRoute" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "outerEdgeId" TEXT NOT NULL,
    "innerEdgeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletionId" TEXT,

    CONSTRAINT "FlowRoute_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FlowRoute_projectId_idx" ON "FlowRoute"("projectId");

-- CreateIndex
CREATE INDEX "FlowRoute_flowId_idx" ON "FlowRoute"("flowId");

-- CreateIndex
CREATE INDEX "FlowRoute_outerEdgeId_idx" ON "FlowRoute"("outerEdgeId");

-- CreateIndex
CREATE INDEX "FlowRoute_innerEdgeId_idx" ON "FlowRoute"("innerEdgeId");

-- CreateIndex
CREATE INDEX "FlowRoute_deletionId_idx" ON "FlowRoute"("deletionId");

-- AddForeignKey
ALTER TABLE "FlowRoute" ADD CONSTRAINT "FlowRoute_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FlowRoute" ADD CONSTRAINT "FlowRoute_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "Flow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FlowRoute" ADD CONSTRAINT "FlowRoute_outerEdgeId_fkey" FOREIGN KEY ("outerEdgeId") REFERENCES "Edge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FlowRoute" ADD CONSTRAINT "FlowRoute_innerEdgeId_fkey" FOREIGN KEY ("innerEdgeId") REFERENCES "Edge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Fail loudly with a domain message if pre-existing duplicates would refuse
-- the unique index. Idempotent: subsequent runs find no duplicates and fall
-- through. ADR-0010 named pattern, third adopter (after idx_edge_dedup and
-- idx_flow_dedup).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "FlowRoute"
    WHERE "deletedAt" IS NULL
    GROUP BY "outerEdgeId", "flowId"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Refusing to create idx_flow_route_dedup: pre-existing duplicate active FlowRoutes. Resolve by soft-deleting the duplicates first.';
  END IF;
END$$;

-- Closes the TOCTOU window between findFirst and create in `routeFlow`.
-- Partial — not plain UNIQUE — so soft-delete-then-re-route still works
-- (deletedAt IS NOT NULL rows are out of the index). Service-layer findFirst
-- remains the readable fast path; this index is the backstop. See ADR-0010
-- (the named pattern) and the master plan at
-- docs/plans/flow-routed-connections.md.
--
-- NULLS NOT DISTINCT is deliberately omitted: both `outerEdgeId` and `flowId`
-- are NOT NULL on FlowRoute, unlike Edge's nullable `canvasNodeId` (where the
-- clause is load-bearing for root-Canvas de-dupe). Carrying it here would
-- mislead the next reader into hunting a null case that does not exist.
CREATE UNIQUE INDEX "idx_flow_route_dedup"
  ON "FlowRoute" ("outerEdgeId", "flowId")
  WHERE "deletedAt" IS NULL;

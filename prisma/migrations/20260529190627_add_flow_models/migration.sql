-- CreateEnum
CREATE TYPE "FlowKind" AS ENUM ('GENERIC', 'OPENAPI_OPERATION', 'ASYNCAPI_CHANNEL', 'SSE_STREAM', 'WEBSOCKET', 'FUNCTION_CALL', 'EVENT');

-- CreateEnum
CREATE TYPE "FlowSpecKind" AS ENUM ('OPENAPI', 'ASYNCAPI', 'TS_SIGNATURE', 'GRAPHQL', 'CUSTOM');

-- CreateEnum
CREATE TYPE "FlowPolarity" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateTable
CREATE TABLE "FlowSpec" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "ownerNodeId" TEXT NOT NULL,
    "kind" "FlowSpecKind" NOT NULL,
    "source" TEXT NOT NULL,
    "parsedAt" TIMESTAMP(3),
    "parseError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletionId" TEXT,

    CONSTRAINT "FlowSpec_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Flow" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "ownerNodeId" TEXT NOT NULL,
    "sourceSpecId" TEXT,
    "kind" "FlowKind" NOT NULL DEFAULT 'GENERIC',
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "polarity" "FlowPolarity" NOT NULL,
    "signature" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletionId" TEXT,

    CONSTRAINT "Flow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FlowSpec_ownerNodeId_key" ON "FlowSpec"("ownerNodeId");

-- CreateIndex
CREATE INDEX "FlowSpec_projectId_idx" ON "FlowSpec"("projectId");

-- CreateIndex
CREATE INDEX "FlowSpec_deletionId_idx" ON "FlowSpec"("deletionId");

-- CreateIndex
CREATE INDEX "Flow_projectId_ownerNodeId_idx" ON "Flow"("projectId", "ownerNodeId");

-- CreateIndex
CREATE INDEX "Flow_ownerNodeId_idx" ON "Flow"("ownerNodeId");

-- CreateIndex
CREATE INDEX "Flow_sourceSpecId_idx" ON "Flow"("sourceSpecId");

-- CreateIndex
CREATE INDEX "Flow_deletionId_idx" ON "Flow"("deletionId");

-- AddForeignKey
ALTER TABLE "FlowSpec" ADD CONSTRAINT "FlowSpec_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FlowSpec" ADD CONSTRAINT "FlowSpec_ownerNodeId_fkey" FOREIGN KEY ("ownerNodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Flow" ADD CONSTRAINT "Flow_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Flow" ADD CONSTRAINT "Flow_ownerNodeId_fkey" FOREIGN KEY ("ownerNodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Flow" ADD CONSTRAINT "Flow_sourceSpecId_fkey" FOREIGN KEY ("sourceSpecId") REFERENCES "FlowSpec"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Fail loudly with a domain message if pre-existing duplicates would refuse
-- the unique index. Idempotent: subsequent runs find no duplicates and fall
-- through. ADR-0010 named pattern, second adopter (after idx_edge_dedup).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Flow"
    WHERE "deletedAt" IS NULL
    GROUP BY "ownerNodeId", "key"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Refusing to create idx_flow_dedup: pre-existing duplicate active Flows. Resolve by soft-deleting the duplicates first.';
  END IF;
END$$;

-- Closes the TOCTOU window between findFirst and create in `addFlow` and the
-- upsert path inside `attachFlowSpec`. Partial — not plain UNIQUE — so
-- soft-delete-then-recreate still works (deletedAt IS NOT NULL rows are out of
-- the index). Service-layer findFirst remains the readable fast path; this
-- index is the backstop. See ADR-0010 (the named pattern) and ADR-0011 (this
-- adopter).
--
-- NULLS NOT DISTINCT is deliberately omitted: both `ownerNodeId` and `key` are
-- NOT NULL on Flow, unlike Edge's nullable `canvasNodeId` (where the clause is
-- load-bearing for root-Canvas de-dupe). Carrying it here would mislead the
-- next reader into hunting a null case that does not exist.
CREATE UNIQUE INDEX "idx_flow_dedup"
  ON "Flow" ("ownerNodeId", "key")
  WHERE "deletedAt" IS NULL;

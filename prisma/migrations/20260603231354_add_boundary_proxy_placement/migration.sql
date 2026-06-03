-- CreateTable
CREATE TABLE "BoundaryProxyPlacement" (
    "id" TEXT NOT NULL,
    "containerNodeId" TEXT,
    "realEndpointId" TEXT NOT NULL,
    "posX" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "posY" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BoundaryProxyPlacement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BoundaryProxyPlacement_containerNodeId_idx" ON "BoundaryProxyPlacement"("containerNodeId");

-- One placement per (scope, off-scope endpoint). Hand-authored because Prisma
-- cannot express NULLS NOT DISTINCT: the root scope is `containerNodeId IS NULL`,
-- and Postgres's default (NULLS DISTINCT) would treat every root-scope row as
-- unique and admit duplicate placements for the same root proxy. NULLS NOT
-- DISTINCT (Postgres 15+) collapses those nulls so the root scope gets exactly one
-- placement per endpoint, the same as any nested scope (#91 / ADR-0036, ADR-0010).
--
-- The `WHERE "realEndpointId" IS NOT NULL` predicate is always true (the column is
-- NOT NULL), so it changes NO row coverage — every row is still subject to the
-- uniqueness. It is present solely to make this a PARTIAL index, which Prisma's
-- `migrate diff` does not model and therefore leaves untouched, keeping `db:check`
-- clean — the same drift-suppression mechanism the `idx_edge_*` / `idx_spec_owner_live`
-- partial unique indexes rely on (ADR-0010). Without it, the diff would see a plain
-- unique index absent from the schema and perpetually want to DROP it.
CREATE UNIQUE INDEX "idx_boundary_proxy_placement"
  ON "BoundaryProxyPlacement" ("containerNodeId", "realEndpointId")
  NULLS NOT DISTINCT
  WHERE "realEndpointId" IS NOT NULL;

-- AddForeignKey
ALTER TABLE "BoundaryProxyPlacement" ADD CONSTRAINT "BoundaryProxyPlacement_containerNodeId_fkey" FOREIGN KEY ("containerNodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BoundaryProxyPlacement" ADD CONSTRAINT "BoundaryProxyPlacement_realEndpointId_fkey" FOREIGN KEY ("realEndpointId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;


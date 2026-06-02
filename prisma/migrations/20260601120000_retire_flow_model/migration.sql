-- Retire the Flow capability model; make a Connection a directed, typed Edge
-- that may link any two Components at any scope (#62 / ADR-0027, ADR-0028,
-- ADR-0030). Drops Flow / FlowRoute and the cross-scope routing machinery,
-- renames the 1:1 spec row's enum, drops the stored Edge scope (`canvasNodeId`),
-- and re-keys Edge de-dupe onto two partial unique indexes.
--
-- Node + plain Edge data are preserved; Flow-model data (Flow / FlowRoute /
-- FlowSpec rows) is droppable per the clean-redesign mandate. Every preserved
-- Edge backfills to `interaction = 'ASSOCIATION'`.
--
-- Re-run posture: DROPs carry `IF EXISTS` as best-effort defense-in-depth for a
-- hand-touched / half-applied prod DB. This is NOT full idempotency — the FK
-- drops target tables this same migration drops moments later, so a re-run that
-- starts after the DROP TABLEs would still fail at `ALTER TABLE "Flow"` (the
-- table is gone). The clean single-pass apply is the supported path.
--
-- Note: `idx_edge_dedup` is intentionally REUSED below — the old all-rows
-- `(canvasNodeId, LEAST, GREATEST)` index is dropped and the name is recreated
-- with a new directional `(projectId, sourceId, targetId, interaction)` shape.

-- CreateEnum. Fresh `Interaction` type with all five values (incl. the new
-- ASSOCIATION default) — a fresh CREATE TYPE avoids the Postgres "cannot use a
-- just-ADDed enum value in the same transaction" footgun a rename+ADD would hit.
CREATE TYPE "SpecKind" AS ENUM ('OPENAPI', 'ASYNCAPI', 'TS_SIGNATURE', 'GRAPHQL', 'SQL_DDL', 'CUSTOM');
CREATE TYPE "Interaction" AS ENUM ('ASSOCIATION', 'REQUEST', 'PUSH', 'SUBSCRIBE', 'DUPLEX');

-- Add the Edge interaction column. The DEFAULT backfills every existing Edge to
-- ASSOCIATION (a plain undirected line) — the structural successor to the old
-- undirected Connection.
ALTER TABLE "Edge" ADD COLUMN "interaction" "Interaction" NOT NULL DEFAULT 'ASSOCIATION';

-- Residual-duplicate guard (ADR-0010 pattern). De-dupe re-keys from the dropped
-- `canvasNodeId` to `projectId`. The old same-Canvas rule forced any endpoint
-- pair onto exactly one Canvas (a Node has a single `parentId`), so this is a
-- guarded no-op for clean data — but the re-key is not provably collision-free
-- under hand-crafted rows, so refuse loudly rather than let CREATE UNIQUE INDEX
-- fail with a bare Postgres error.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Edge"
    WHERE "deletedAt" IS NULL AND "interaction" = 'ASSOCIATION'
    GROUP BY "projectId", LEAST("sourceId", "targetId"), GREATEST("sourceId", "targetId")
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Refusing to create idx_edge_assoc_dedup: active ASSOCIATION Edges share a (projectId, unordered {source, target}) pair. Soft-delete the duplicates first.';
  END IF;
END$$;

-- Drop the old scope-keyed dedup index (raw SQL from 20260601000252) before
-- dropping the `canvasNodeId` column it references.
DROP INDEX IF EXISTS "idx_edge_dedup";

-- DropForeignKey (Flow model + the Edge canvas-scope FK).
ALTER TABLE "Edge" DROP CONSTRAINT IF EXISTS "Edge_canvasNodeId_fkey";
ALTER TABLE "Flow" DROP CONSTRAINT IF EXISTS "Flow_ownerNodeId_fkey";
ALTER TABLE "Flow" DROP CONSTRAINT IF EXISTS "Flow_projectId_fkey";
ALTER TABLE "Flow" DROP CONSTRAINT IF EXISTS "Flow_sourceSpecId_fkey";
ALTER TABLE "FlowRoute" DROP CONSTRAINT IF EXISTS "FlowRoute_flowId_fkey";
ALTER TABLE "FlowRoute" DROP CONSTRAINT IF EXISTS "FlowRoute_innerEdgeId_fkey";
ALTER TABLE "FlowRoute" DROP CONSTRAINT IF EXISTS "FlowRoute_outerEdgeId_fkey";
ALTER TABLE "FlowRoute" DROP CONSTRAINT IF EXISTS "FlowRoute_projectId_fkey";
ALTER TABLE "FlowSpec" DROP CONSTRAINT IF EXISTS "FlowSpec_ownerNodeId_fkey";
ALTER TABLE "FlowSpec" DROP CONSTRAINT IF EXISTS "FlowSpec_projectId_fkey";

-- DropIndex (Prisma-managed scope index).
DROP INDEX IF EXISTS "Edge_projectId_canvasNodeId_idx";

-- Edge: drop the stored Canvas scope. Scope is now derived from endpoint
-- ancestry (#63 / ADR-0028).
ALTER TABLE "Edge" DROP COLUMN IF EXISTS "canvasNodeId";

-- Node: generated-component provenance columns (#64 populates them; #62 lands
-- the columns + cascade).
ALTER TABLE "Node" ADD COLUMN "sourceSpecId" TEXT,
ADD COLUMN     "specKey" TEXT;

-- DropTable. FlowRoute first (it FKs Flow/Edge), then Flow (it FKs FlowSpec),
-- then FlowSpec — and before the enum drops below, since Flow.kind /
-- Flow.interaction / FlowSpec.kind are their last consumers.
DROP TABLE IF EXISTS "FlowRoute";
DROP TABLE IF EXISTS "Flow";
DROP TABLE IF EXISTS "FlowSpec";

-- DropEnum (after their tables are gone).
DROP TYPE IF EXISTS "FlowInteraction";
DROP TYPE IF EXISTS "FlowKind";
DROP TYPE IF EXISTS "FlowSpecKind";

-- CreateTable Spec (the renamed 1:1 import row; Prisma-canonical names so the
-- drift gate stays green). Flow-model FlowSpec data is dropped per the
-- clean-redesign mandate; the spec→Component generator is rebuilt in #64.
CREATE TABLE "Spec" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "ownerNodeId" TEXT NOT NULL,
    "kind" "SpecKind" NOT NULL,
    "source" TEXT NOT NULL,
    "parsedAt" TIMESTAMP(3),
    "parseError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "deletionId" TEXT,

    CONSTRAINT "Spec_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Spec_ownerNodeId_key" ON "Spec"("ownerNodeId");
CREATE INDEX "Spec_projectId_idx" ON "Spec"("projectId");
CREATE INDEX "Spec_deletionId_idx" ON "Spec"("deletionId");
CREATE INDEX "Node_sourceSpecId_idx" ON "Node"("sourceSpecId");

-- AddForeignKey
ALTER TABLE "Node" ADD CONSTRAINT "Node_sourceSpecId_fkey" FOREIGN KEY ("sourceSpecId") REFERENCES "Spec"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Spec" ADD CONSTRAINT "Spec_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Spec" ADD CONSTRAINT "Spec_ownerNodeId_fkey" FOREIGN KEY ("ownerNodeId") REFERENCES "Node"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The two partial unique indexes that replace the single scope-keyed
-- `idx_edge_dedup` (ADR-0010 named pattern, re-keyed on `projectId`). Raw SQL —
-- Prisma's schema cannot express partial predicates or LEAST/GREATEST
-- expressions. `NULLS NOT DISTINCT` is no longer needed: every key column is NOT
-- NULL now that the nullable `canvasNodeId` is gone.
--
--   directional: `interaction` is in the key, so A→B REQUEST and A→B PUSH are
--   distinct Connections, and the pair is ORDERED (A→B REQUEST ≠ B→A REQUEST).
CREATE UNIQUE INDEX "idx_edge_dedup"
  ON "Edge" ("projectId", "sourceId", "targetId", "interaction")
  WHERE "deletedAt" IS NULL AND "interaction" <> 'ASSOCIATION';

--   association: the UNORDERED pair, so A↔B and B↔A are one Association.
CREATE UNIQUE INDEX "idx_edge_assoc_dedup"
  ON "Edge" ("projectId", LEAST("sourceId", "targetId"), GREATEST("sourceId", "targetId"))
  WHERE "deletedAt" IS NULL AND "interaction" = 'ASSOCIATION';

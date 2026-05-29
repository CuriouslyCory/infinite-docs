-- Fail loudly with a domain message if pre-existing duplicates would refuse
-- the unique index. Postgres' default error names only the index, not the
-- offending rows or what they mean — this guard points at the fix instead.
-- Idempotent: subsequent runs find no duplicates and fall through.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Edge"
    WHERE "deletedAt" IS NULL
    GROUP BY "canvasNodeId", "sourceId", "targetId"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Refusing to create idx_edge_dedup: pre-existing duplicate active Edges. Resolve by soft-deleting the duplicates first.';
  END IF;
END$$;

-- Closes the TOCTOU window between findFirst and create in connectNodes
-- (and in restoreNode, and in any future Edge writer). Partial — not plain
-- UNIQUE — so soft-delete-then-recreate still works (deletedAt IS NOT NULL
-- rows are out of the index). Service-layer findFirst remains the readable
-- fast path; this index is the backstop. See ADR-0005 (original deferral)
-- and ADR-0010 (this hardening). Issue #25.
--
-- NULLS NOT DISTINCT is load-bearing: `canvasNodeId` is nullable (null = the
-- Project root Canvas), and Postgres' default treats NULL as distinct in
-- unique indexes — so two root-Canvas edges with the same (sourceId,
-- targetId) would both pass without this clause. Requires Postgres 15+.
CREATE UNIQUE INDEX "idx_edge_dedup"
  ON "Edge" ("canvasNodeId", "sourceId", "targetId")
  NULLS NOT DISTINCT
  WHERE "deletedAt" IS NULL;

-- The 4-column composite index from PR #24 was the fast-path precursor for
-- the same lookup; the partial unique index above subsumes it (Postgres uses
-- partial indexes for matching queries) and is the only remaining caller.
DROP INDEX "Edge_canvasNodeId_sourceId_targetId_deletedAt_idx";

-- Fail loudly with a domain message if pre-existing duplicates would refuse the
-- unique index. Postgres' default error names only the index, not the offending
-- rows or what they mean — this guard points at the fix instead. Idempotent:
-- subsequent runs find no duplicates and fall through.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "CrossProjectEdge"
    WHERE "deletedAt" IS NULL
    GROUP BY "hostNodeId", "foreignProjectId", "foreignNodeId", "interaction"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Refusing to create idx_cross_project_edge_dedup: pre-existing duplicate active CrossProjectEdges. Soft-delete the duplicates first.';
  END IF;
END$$;

-- Closes the TOCTOU window between findFirst and create in connectCrossProject
-- (and in the lone restoreCrossProjectEdge, and in deleteNode's cascade revival
-- via restoreNode) — #123, ADR-0010. Service-layer findFirst remains the readable
-- fast path; this index is the backstop, surfaced as a ConflictError via
-- isCrossProjectEdgeDedupCollision.
--
-- DIRECTIONAL by construction (NOT LEAST/GREATEST): a cross-project Connection's
-- host end and foreign end are categorically different (host Component vs foreign
-- Component reached through a portal), so there is no unordered-pair case even for
-- ASSOCIATION. The slot is the ordered tuple (hostNodeId, foreignProjectId,
-- foreignNodeId, interaction); `referenceNodeId` and `label` are OUT of the key
-- (two portals onto the same foreign project still de-dupe to one Connection per
-- host+foreign+interaction). Partial (WHERE "deletedAt" IS NULL) so a
-- soft-delete-then-recreate still works — tombstoned rows fall out of the index.
-- No NULLS NOT DISTINCT: all four key columns are NOT NULL on CrossProjectEdge.
CREATE UNIQUE INDEX "idx_cross_project_edge_dedup"
  ON "CrossProjectEdge" ("hostNodeId", "foreignProjectId", "foreignNodeId", "interaction")
  WHERE "deletedAt" IS NULL;

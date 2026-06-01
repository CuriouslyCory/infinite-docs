-- A Connection is undirected: there is exactly ONE Connection per Component pair
-- per Canvas, regardless of which way it was drawn (ADR-0023, superseding ADR-0009).
-- The de-dupe key becomes the UNORDERED pair (canvasNodeId, {sourceId, targetId}),
-- enforced by an expression-based partial unique index over LEAST/GREATEST of the
-- endpoints (keeps the name `idx_edge_dedup` so the service collision matcher is
-- unchanged; the columns stay in draw order, the index normalizes the pair).
--
-- Before the new index can exist, any pre-existing reverse pairs (A→B and B→A,
-- which ADR-0013's retired reverse-Connection dance could create) must be merged
-- into one canonical Connection. This is a value-preserving merge, never a hard
-- delete: FlowRoutes move to the surviving Edge and losers are soft-deleted under
-- one batch `deletionId` (ADR-0008 shape).

DO $$
DECLARE
  batch uuid := gen_random_uuid();
BEGIN
  -- Map every active Edge to its group's canonical winner (lowest id) within
  -- (canvasNodeId, unordered endpoint pair). Rows where loser_id = winner_id are
  -- already canonical and are skipped by the `<>` guards below.
  CREATE TEMP TABLE _edge_merge ON COMMIT DROP AS
  SELECT
    e.id AS loser_id,
    FIRST_VALUE(e.id) OVER (
      PARTITION BY
        e."canvasNodeId",
        LEAST(e."sourceId", e."targetId"),
        GREATEST(e."sourceId", e."targetId")
      ORDER BY e.id
    ) AS winner_id
  FROM "Edge" e
  WHERE e."deletedAt" IS NULL;

  -- 1. Re-point inner-Edge references onto the winner. `innerEdgeId` has no
  --    uniqueness (a shared pipe), so this never collides (ADR-0012).
  UPDATE "FlowRoute" fr
  SET "innerEdgeId" = m.winner_id
  FROM _edge_merge m
  WHERE fr."innerEdgeId" = m.loser_id
    AND m.loser_id <> m.winner_id
    AND fr."deletedAt" IS NULL;

  -- 2. Compute each active route's post-merge outer Edge (its group's winner, or
  --    itself if already canonical). The dedup must happen BEFORE the re-point:
  --    `idx_flow_route_dedup` is non-deferrable, so re-pointing two routes that
  --    share a flow onto the winner would violate it the instant the second row
  --    lands — before any later cleanup could run.
  CREATE TEMP TABLE _route_remap ON COMMIT DROP AS
  SELECT
    fr.id AS route_id,
    fr."flowId" AS flow_id,
    COALESCE(m.winner_id, fr."outerEdgeId") AS new_outer
  FROM "FlowRoute" fr
  LEFT JOIN _edge_merge m ON m.loser_id = fr."outerEdgeId"
  WHERE fr."deletedAt" IS NULL;

  -- 3. Soft-delete routes that would collide on the post-merge (new_outer,
  --    flowId) slot, keeping the lowest route id. Covers every collision shape
  --    (the Flow already routed on the winner, or two losers carried it) without
  --    enumerating them.
  UPDATE "FlowRoute" fr
  SET "deletedAt" = now(), "deletionId" = batch
  FROM _route_remap rr
  WHERE fr.id = rr.route_id
    AND fr.id <> (
      SELECT MIN(rr2.route_id)
      FROM _route_remap rr2
      WHERE rr2.new_outer = rr.new_outer
        AND rr2.flow_id = rr.flow_id
    );

  -- 4. Re-point the surviving routes onto the winner. After step 3 each survivor
  --    holds a distinct (new_outer, flowId), so no row transiently collides.
  UPDATE "FlowRoute" fr
  SET "outerEdgeId" = rr.new_outer
  FROM _route_remap rr
  WHERE fr.id = rr.route_id
    AND fr."deletedAt" IS NULL
    AND fr."outerEdgeId" <> rr.new_outer;

  -- 5. Soft-delete the loser Edges under the same batch handle.
  UPDATE "Edge" e
  SET "deletedAt" = now(), "deletionId" = batch
  FROM _edge_merge m
  WHERE e.id = m.loser_id
    AND m.loser_id <> m.winner_id
    AND e."deletedAt" IS NULL;
END$$;

-- Swap the ordered de-dupe index for the unordered one. Drop first so the name
-- is free; the merge above guarantees the new index can build.
DROP INDEX "idx_edge_dedup";

-- Fail loudly if (impossibly, after the merge) an unordered duplicate remains,
-- pointing at the fix rather than Postgres' bare index error.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Edge"
    WHERE "deletedAt" IS NULL
    GROUP BY "canvasNodeId", LEAST("sourceId", "targetId"), GREATEST("sourceId", "targetId")
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Refusing to create idx_edge_dedup: active Edges still share an unordered (canvasNodeId, {source, target}) pair. Soft-delete the duplicates first.';
  END IF;
END$$;

-- Unordered, partial (soft-delete-friendly), NULLS NOT DISTINCT (root-Canvas
-- edges have canvasNodeId = NULL). Expression index over LEAST/GREATEST so the
-- stored endpoint order is irrelevant — A→B and B→A collide as one Connection
-- (ADR-0023). Name kept as `idx_edge_dedup` so `isEdgeDedupCollision` matches.
CREATE UNIQUE INDEX "idx_edge_dedup"
  ON "Edge" ("canvasNodeId", LEAST("sourceId", "targetId"), GREATEST("sourceId", "targetId"))
  NULLS NOT DISTINCT
  WHERE "deletedAt" IS NULL;

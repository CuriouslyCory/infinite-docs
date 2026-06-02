-- Re-key Spec ownership uniqueness from all-rows to live-only (#62 follow-up).
--
-- `Spec` is soft-deleted (deletedAt/deletionId) and swept/restored with its
-- owner Node (ADR-0030). The all-rows `Spec_ownerNodeId_key` reserved the owner
-- even after the row was tombstoned, so a replacement Spec could not be attached
-- while an old tombstone survived — and the restore-time `conflictingSpecIds`
-- pre-check was unreachable (two rows for one owner could never coexist).
--
-- Replace it with a partial unique index scoped to live rows, mirroring the Edge
-- de-dupe indexes. Prisma's schema cannot express a partial predicate, so this
-- is raw SQL and the model drops its `@unique` (the relation becomes a list).
-- No residual-duplicate guard: the dropped all-rows unique already guaranteed at
-- most one Spec per owner, so at most one live row exists — the CREATE cannot
-- collide.

-- DropIndex (the old all-rows unique).
DROP INDEX IF EXISTS "Spec_ownerNodeId_key";

-- CreateIndex (live-only 1:1 — at most one non-deleted Spec per owner Node).
CREATE UNIQUE INDEX "idx_spec_owner_live"
  ON "Spec" ("ownerNodeId")
  WHERE "deletedAt" IS NULL;

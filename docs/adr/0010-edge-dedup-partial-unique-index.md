# 10. Edge de-dupe is hardened by a partial unique index; `connectNodes` translates `P2002` to `ConflictError`

## Status

Accepted *(realizes the partial-unique-index hardening ADR-0005 named as
deferred future work; amends ADR-0005's consequences §3 by name).*

## Context

ADR-0005 placed the three Edge invariants — same-Canvas, no self-link, no
duplicate active Edge — in `connectNodes` rather than at the database. The
deferred consequence was a TOCTOU window between the de-dupe `findFirst` and
the `create`: two concurrent callers can both pass the read and both
`INSERT`, leaving two identical active Edges. The race was accepted because
writes were single-owner and the optimistic UI made the window small.

Two pressures close that acceptance:

1. **`routeFlow` becomes a second Edge writer.** Slice 3 of
   `docs/plans/flow-routed-connections.md` introduces `routeFlow` — the
   gated cross-scope Edge writer that creates inner Edges when refining a
   Connection through a boundary proxy. Its correctness invariant ("two
   concurrent route attempts on the same outer Edge over the same
   `(sourceId, targetId)` interior pair converge on one inner Edge") makes
   the race no longer a cosmetic concern. It is correctness-defining.
2. **More invariants of the same shape are coming.** The flow-routed plan
   adds at least two more soft-deletable de-dupe rules
   (`Flow.(ownerNodeId, key)` and `FlowRoute.(outerEdgeId, flowId)`). The
   plan describes them as "service-enforced (ADR-0005 style)" — fuzzy
   wording that benefits from a named pattern with concrete shape.

The hardening path ADR-0005 named — a partial unique index — was deferred
because Prisma cannot express partial unique indexes declaratively (no
syntax for `WHERE deletedAt IS NULL` in the schema). Landing it requires
moving the repo from `prisma db push` to `prisma migrate`, so this ADR
covers both.

## Decision

1. **Add the partial unique index** in a raw SQL migration:

   ```sql
   CREATE UNIQUE INDEX "idx_edge_dedup"
     ON "Edge" ("canvasNodeId", "sourceId", "targetId")
     NULLS NOT DISTINCT
     WHERE "deletedAt" IS NULL;
   ```

   `NULLS NOT DISTINCT` is load-bearing — `canvasNodeId IS NULL` means the
   Project root Canvas, and Postgres's default would treat NULL as distinct
   in unique indexes, letting two root-Canvas duplicates both pass. Requires
   Postgres 15+. The migration also drops the legacy 4-column composite
   index that the partial unique subsumes for the canonical lookup.

2. **Service stays the policy.** `connectNodes` (and every future Edge
   writer) does its own `findFirst`/throw fast path. The index is the
   backstop, not a replacement. Both lines hold independently — defense in
   depth, not substitution.

3. **Catch `P2002` narrowed to this index** and map to the same
   `ConflictError` the fast path emits. One domain error, one stable
   contract; the caller cannot tell which path caught the duplicate, which
   is the point. The narrowing lives in
   `src/server/architecture/prisma-errors.ts` (`isEdgeDedupCollision`) and
   handles both Prisma error shapes — the legacy query engine
   (`meta.target`) and the `@prisma/adapter-pg` driver path
   (`meta.driverAdapterError.cause.originalMessage` / `constraint.fields`).

4. **`ConflictError` grows optional structured `details`.** The fast-path
   throw and the catch path both load the conflicting Edge and surface its
   id as `details.conflictingEdgeIds`. The tRPC `errorFormatter` flows the
   `details` to the client as `error.data.archDetails`; the future MCP
   adapter reads `cause.details` directly. The human `message` stays — the
   structured channel is the AI-readable companion, not its replacement.

5. **Move the repo from `prisma db push` to `prisma migrate`.** The partial
   unique index cannot be expressed in the Prisma schema model. The
   workflow is codified:

   - **Authoring**: `pnpm prisma migrate diff --from-empty --to-schema
     prisma/schema.prisma --script > <new-migration>/migration.sql`, then
     hand-edit for raw SQL. No shadow DB required.
   - **Applying** (everywhere — dev, test, prod): `pnpm prisma migrate
     deploy`. Idempotent; needs no shadow DB.
   - **Never used**: `prisma migrate dev`. That command needs a shadow DB,
     which would force every contributor (and every CI run) onto a
     two-branch Neon setup for nothing. The `db push` script is retired
     from `package.json` for the same reason — once on migration history,
     `db push` desyncs `_prisma_migrations` from reality and silently skips
     raw SQL migrations.
   - **Test global-setup** runs `migrate deploy` (not `db push`) so the
     test DB actually carries `idx_edge_dedup`. Without this change, the
     concurrency regression test passes for the wrong reason — the service
     `findFirst` happens to win every interleaving in a single-fork
     Vitest run.

6. **Promote the shape to a named pattern.** "Service-primary +
   partial-unique-backstop + named P2002 catch" is the canonical shape for
   every future soft-deletable de-dupe rule in this codebase. Preconditions
   for the pattern:

   - (a) the canonical key has bounded cardinality (composable into a
     Postgres index);
   - (b) the underlying row is soft-deletable (carries a `deletedAt`
     column);
   - (c) re-creation after soft-delete is expected behaviour.

   `Flow.(ownerNodeId, key)` and `FlowRoute.(outerEdgeId, flowId)` (from
   the flow-routed plan) satisfy all three; they MUST adopt the pattern.
   A future rule that violates (c) — re-creation is forbidden — should use
   a plain `@@unique` instead and is not subject to this ADR.

## Consequences

- **Service code and database both enforce the de-dupe rule.** The race
  ADR-0005 accepted is closed. The "Reviewers must not 'fix' this by
  adding a naive `@@unique`" caution from ADR-0005 still applies — a plain
  `@@unique` would forbid re-creation after soft-delete; only the
  `WHERE deletedAt IS NULL` partial form is correct.

### Reviewable invariants this slice adds

- "Every service that writes to `Edge` must catch `P2002` narrowed to
  `idx_edge_dedup` (via `isEdgeDedupCollision`) and map it to
  `ConflictError` with structured `details.conflictingEdgeIds`. The
  fast-path `findFirst` throw produces the same shape so callers cannot
  tell which path caught the duplicate."
- "The de-dupe key is exactly `(canvasNodeId, sourceId, targetId)` among
  `deletedAt IS NULL` rows. Widening the key (e.g. adding `projectId`)
  breaks the refinement-Connection plan; removing the `WHERE` clause
  breaks soft-delete-then-recreate; removing `NULLS NOT DISTINCT` breaks
  root-Canvas de-dupe."
- "Every future soft-deletable de-dupe rule that satisfies preconditions
  (a)/(b)/(c) MUST adopt the named pattern. A plain `@@unique` on such a
  rule is a reviewable regression."
- "Schema sync runs through `prisma migrate deploy` everywhere — dev,
  test, prod. `db push` is retired because it cannot apply partial unique
  indexes; `migrate dev` is avoided because it requires a shadow DB this
  repo deliberately does not configure."

### Operational notes

- **Pre-existing duplicates** would refuse to create the unique index.
  The migration's own `DO` block raises a domain-specific exception with
  the fix; this is defense-in-depth on top of Postgres's generic
  "duplicate values" error.
- **Baselining the migration history on existing databases** (one-time
  step on each environment): `pnpm prisma migrate resolve --applied
  <baseline-migration>` against each `DATABASE_URL`. Run before the first
  `migrate deploy` on any database that already carries the schema from
  the previous `db push` regime.
- **Drift gate** between schema and live DB before applying:
  `pnpm prisma migrate diff --from-schema prisma/schema.prisma
  --to-config-datasource --exit-code`. Exit code 0 = no drift.

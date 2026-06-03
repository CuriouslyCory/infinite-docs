# 35. Named Traces persist the point set as a `TracePoint` join; owner-only writes, slug-readable reads, saved route rides the project slug

## Status

Accepted (#59).

**Builds on** [ADR-0034](0034-trace-derived-cross-layer-projection.md): a Trace is
a derived cross-layer projection — only the POINT SET is state, the on-path
subgraph is recomputed on read by `getTraceView`. #59 makes that point set
first-class: named, saved, and shareable. It does NOT store the subgraph, does
NOT change `getTraceView`'s algorithm or signature — it only gives the point set
a persisted source alongside the per-browser working trace.

**Honours** [ADR-0001](0001-service-layer-db-actor-input.md): the five CRUD
functions follow the `(db, actor, input)` contract with narrow, required Zod
inputs; writes are owner-only at the SERVICE layer.

**Honours** [ADR-0002](0002-capability-slug-read-grant.md): reads are slug-bound
(possession of the capability slug IS the read grant); writes are owner-only
(`assertCanWrite`).

**Honours** [ADR-0010](0010-migration-without-shadow-db.md): the live-only
unique-name-per-Project rule is a raw-SQL partial unique index (Prisma can't
express the `WHERE deletedAt IS NULL` predicate), service-primary with the index
as a TOCTOU backstop, mirroring `idx_spec_owner_live`.

**Honours** [ADR-0030](0030-cascade-undo-without-flowroutes.md): delete is a
soft-delete stamped with one `deletionId` for forward-compatible undo.

## Context

#57 shipped the **working trace** (a per-browser `localStorage` set of trace-point
ids) and #58 the derived cross-layer **Trace view**. ADR-0034 explicitly named
the persistence layer — "the `Trace` Prisma model, migration, save/load/share,
named Traces, and the saved route" — as out of scope / a future seam. #59 builds
that seam. The downstream consumer is #60 (the markdown serializer's trace mode
and the MCP `architecture://trace/{traceId}` resource), which reads a saved
`Trace`; #59 stops at the service + tRPC + UI + saved route and touches none of
those files.

The load-bearing choices ADR-0034 left open, and that #60 must understand:

## Decision

### Persist the point set as a `TracePoint` join, not a `String[]`

A `Trace` owns a set of `TracePoint` rows, each a real foreign key to a `Node`
(`onDelete: Cascade`). Rationale over a `String[]` column:

- The "ignore points to soft-deleted Components" rule is read-time filtering
  against live `Node` rows. A relation lets the service join the point's `node`
  and check `node.deletedAt` in the same Project-scoped query.
- The FK cascade is the **hard-delete backstop only** — the normal removal path
  is the Node soft-delete, which the service filters at read time. A `String[]`
  would silently retain ids of hard-deleted nodes and cannot FK or index per
  point.
- A join row is the natural unit #60 reads to serialize a Trace's subgraph.

`TracePoint` carries **no `deletedAt`** — its lifecycle is its parent `Trace`'s
(cascade-delete on a Trace hard-delete; soft-delete lives on the `Trace`). A
point is only ever added at create; #59's `renameTrace` does not edit the point
set. Keeping `TracePoint` lifecycle-free avoids a second soft-delete axis.
De-dupe of a Component within a Trace is a plain `@@unique([traceId, nodeId])` —
Prisma-expressible (no soft-delete axis), so no raw SQL is needed for it.

### Live-only unique Trace name per Project

A saved Trace's name is unique per Project among non-deleted rows, enforced by a
raw-SQL partial unique index `idx_trace_name_per_project_live ON "Trace"
("projectId", "name") WHERE "deletedAt" IS NULL`. A soft-deleted Trace does not
reserve its name. The service does a `findFirst` live-name pre-check
(`ConflictError`) and maps a P2002 narrowed via `isTraceNameCollision` to the
same `ConflictError` (service-primary, index-backstop — ADR-0010). The issue
says "named", not "uniquely named"; enforcing a per-Project unique name is the
better UX and matches the repo's partial-unique discipline.

### Read = slug-bind, write = `assertCanWrite` — and why reads do NOT call `assertCanRead`

Reads (`listTraces`, `getTrace`) resolve the Project by slug and treat possession
of the slug as the read grant — they deliberately do NOT call `assertCanRead`, in
parity with `getTraceView`/`getCanvas` (ADR-0034 records exactly this). Both owner
and slug-only viewer reach them.

Writes (`createTrace`, `renameTrace`, `deleteTrace`) resolve the Project's
`ownerId` and call `assertCanWrite`. An authenticated NON-owner who holds the
slug is rejected HERE, at the service layer — not merely by hidden UI. The
`protectedProcedure` is only the transport gate (you must be signed in to
attempt a write); the owner-only decision is in the service. This is the
acceptance criterion "enforced at the service layer, not just hidden UI".

### Soft-delete with a stamped `deletionId`; no undo UI in #59

`deleteTrace` mints one `deletionId` and stamps `deletedAt` + `deletionId` on the
Trace (mirroring `deleteNode`, ADR-0030). `TracePoint` rows are not separately
stamped (no `deletedAt`); they ride the Trace. Reads filter `deletedAt: null`, so
a soft-deleted Trace vanishes from list/get and the saved route (`NotFound`).
#59 ships **no** `restoreTrace` UI, but the stamped id keeps that path
forward-compatible.

### Create filters to ≥2 live points; reads drop soft-deleted points

At create the service filters `nodeIds` to live, in-Project Components and rejects
with a `ValidationError` if fewer than two survive (no useless 1-point Trace). At
read a point whose `Node.deletedAt` is non-null is dropped from the returned
`nodeIds`, so a Trace can return fewer than two live points — the derived view
then shows the existing insufficient-points empty state. No new view code.

### Load replaces the working set, with an undo toast

Loading a saved Trace REPLACES the per-browser working trace with its points
(client-only `localStorage`, so loading is not a server write — ADR-0002). The
working-store gained a narrow `replace(ids)` that returns the prior set, so the
call site can offer an undo toast (`toast(..., { action: { label: "Undo" } })`,
mirroring the canvas delete-undo) that restores the prior set with a re-`replace`.
The toast fires only when unsaved points were discarded.

### Saved route loads into the working set (single render path)

`/p/[slug]/trace/[traceId]` rides the project capability slug. Rather than a
second, parallel "render directly from the persisted Trace" path (which would
duplicate and diverge from the #57/#58 working-set → `getTraceView` render path),
the saved route SEEDS the working set from the prefetched Trace ONCE (ref-guarded
so re-renders and a subsequent user edit are not clobbered), then the existing
render path takes over identically. Seeding fires the same discarded-points undo
toast as Load, for consistency.

## Consequences

- `Trace` + `TracePoint` are the persisted home of a saved Trace; #60 reads them.
- The only raw SQL is the live-only unique-name index; everything else is
  Prisma-expressible.
- A viewer (slug only) sees and can Load saved Traces but has no Save/Rename/Delete
  affordance, and a forged non-owner write is rejected at the service.
- The saved route is a single render path, so the Trace view's behavior is
  identical whether reached via the working set or a share URL.
- Editing a saved Trace's point set is future work; today the working-trace +
  re-save covers it. `restoreTrace` is additive (the `deletionId` is already
  stamped).

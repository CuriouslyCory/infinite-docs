# 36. Boundary proxies are draggable; their per-scope placement persists in a `BoundaryProxyPlacement` table keyed by `(containerNodeId, realEndpointId)`

## Status

Accepted (#91).

**Builds on** [ADR-0031](0031-cross-scope-read-derivation-and-per-edge-boundary-proxy.md):
a boundary proxy's IDENTITY stays fully derived from endpoint ancestry — `getCanvas`
still emits no proxy row, and the five derived fields
`{ nodeId, title, kind, realEndpointId, edgeId }` are frozen. This ADR adds ONLY a
view coordinate: where, on one scope's Canvas, the proxy sits. It reconciles
ADR-0031's "boundary proxies persist no rows" invariant — that invariant is about
the proxy's _identity_, which is still derived; a persisted _placement_ does not
materialize the proxy (the proxy exists iff the derivation emits it), so the
"derived, not stored" posture holds.

**Builds on** [#90](0031-cross-scope-read-derivation-and-per-edge-boundary-proxy.md)
(render-time coalescing): `getCanvas` emits ONE proxy row per crossing edge
(`proxy_<edgeId>`), and the client coalesces rows sharing a `realEndpointId` into a
single drawn node. The placement is therefore keyed by `realEndpointId` — the
COALESCED grain — never the per-edge `proxy_<edgeId>` view id, so all of an
endpoint's crossing edges read and write one shared placement.

**Honours** [ADR-0001](0001-service-layer-db-actor-input.md): the new
`upsertBoundaryProxyPlacement` follows the `(db, actor, input)` contract with a
narrow, required Zod input; the write is owner-only at the SERVICE layer
(`assertCanWrite`). It adds a fourth concurrent read to `getCanvas`'s `Promise.all`,
so the Canvas read stays a single round trip (the same amendment ADR-0031 made for
the cross-scope derivation).

**Honours** [ADR-0002](0002-capability-slug-read-grant.md): the placement read rides
the slug-bound `getCanvas` (possession of the slug IS the read grant); the placement
write is owner-only and addressed by an internal `projectId` handle, never the slug.

**Honours** [ADR-0010](0010-migration-without-shadow-db.md): uniqueness over
`(containerNodeId, realEndpointId)` is a hand-authored `NULLS NOT DISTINCT` unique
index in the migration (Prisma cannot express NULLS-NOT-DISTINCT, and the root scope
keys on a NULL `containerNodeId`), authored service-primary with the index as a
TOCTOU backstop, mirroring `idx_spec_owner_live` and the edge-dedup indexes.

**Amends** [ADR-0016](0016-passive-nodes-and-boundary-group-n1-stability.md): "a
passive node is never `draggable`" no longer holds for the boundary proxy — it is
draggable for an editor (inheriting `nodesDraggable={canEdit}`), the one interactive
exception to the passive contract.

## Context

A boundary proxy stands in for an off-scope endpoint of a cross-scope Connection.
Before #91 it seeded onto a fixed left rail and could not be moved: it was a passive
node, pinned `draggable:false` (ADR-0016, ADR-0031). On a dense Canvas the rail is a
poor default — the owner wants to place the off-scope stand-in near the Components it
connects to, and have that placement survive a reload and a scope re-entry (Descend
out and back). The proxy's _identity_ must stay derived (ADR-0031): we are not
materializing the proxy, only remembering where the user dropped it.

Three forces shape the design:

1. **Per scope, not per Component.** The same off-scope Component can appear as a
   proxy on many scopes (every scope a crossing Connection reaches it from); each
   placement is independent. The key must include the scope.
2. **Per off-scope endpoint, not per crossing edge.** #90 coalesces every crossing
   edge for one endpoint into a single drawn node. A placement keyed by the per-edge
   `proxy_<edgeId>` id would fragment — deleting the representative edge would lose
   the placement, and a second crossing edge would draw at the rail. The key must be
   `realEndpointId`.
3. **The root scope has no container Component.** A proxy on the Project's root
   Canvas has `canvasNodeId === null`. The scope key column is therefore nullable,
   and uniqueness must treat the root-scope NULL as a single value, not "distinct
   per row" (Postgres's default), or the root scope would admit duplicate placements.

## Decision

### A dedicated `BoundaryProxyPlacement` table, keyed by `(containerNodeId, realEndpointId)`

A new model persists ONLY the view coordinate:

```prisma
model BoundaryProxyPlacement {
    id              String   @id @default(cuid())
    containerNodeId String?            // null = the Project's root Canvas
    container       Node?    @relation("ContainerPlacements", ...)
    realEndpointId  String
    realEndpoint    Node     @relation("EndpointPlacements", ...)
    posX            Float    @default(0)
    posY            Float    @default(0)
    createdAt       DateTime @default(now())
    updatedAt       DateTime @updatedAt
    @@index([containerNodeId])
}
```

`containerNodeId` is the scope's container Component (the `canvasNodeId` of the
Canvas), nullable for the root scope. `realEndpointId` is the off-scope Component the
proxy stands in for — the coalesced key. Both FK to `Node` with `onDelete: Cascade`
(the hard-delete backstop; a placement is meaningless once either Node is gone).

### Uniqueness is a hand-authored `NULLS NOT DISTINCT` partial index, not `@@unique`

Prisma cannot express NULLS-NOT-DISTINCT, so no `@@unique` is declared; the schema
carries only the model + the `containerNodeId` lookup index. The migration
hand-authors:

```sql
CREATE UNIQUE INDEX "idx_boundary_proxy_placement"
  ON "BoundaryProxyPlacement" ("containerNodeId", "realEndpointId")
  NULLS NOT DISTINCT
  WHERE "realEndpointId" IS NOT NULL;
```

The `WHERE "realEndpointId" IS NOT NULL` predicate is always true (the column is NOT
NULL) so it changes no row coverage; it is present solely to make the index PARTIAL,
which `prisma migrate diff` does not model and therefore leaves untouched — the same
drift-suppression mechanism `idx_spec_owner_live` and `idx_edge_*` rely on (ADR-0010).
Without it, `db:check` would perpetually want to DROP a plain unique index absent from
the schema. `NULLS NOT DISTINCT` (Postgres 15+) collapses the root-scope NULLs so the
root Canvas gets exactly one placement per endpoint, the same as any nested scope.

### The service upserts BY HAND, not via `db.upsert`

Because uniqueness lives only in the hand-authored index, Prisma generates NO compound
`WhereUniqueInput` for `(containerNodeId, realEndpointId)` — `boundaryProxyPlacement`'s
only unique selector is `id`. Even a generated compound key would not honour
NULLS-NOT-DISTINCT for the root-scope `null` case. So `upsertBoundaryProxyPlacement`:

1. resolves the Project (filtering `deletedAt: null`) and `assertCanWrite(actor, …)`;
2. confirms both Node ids are live in this Project (the container only when non-null —
   `null` is the legitimate root scope), the `updatePositions` set-membership posture;
3. `findFirst({ where: { containerNodeId, realEndpointId } })` → `update` if found,
   else `create`; on a `P2002` from the create (the READ-COMMITTED race where two
   first-drags of the same proxy both miss the find), re-resolve and `update` the
   winner's row. Service-primary, index-backstop (ADR-0010).

### `getCanvas` joins the placement additively; the proxy seeds at it or falls to the rail

`getCanvas` adds a fourth concurrent read —
`boundaryProxyPlacement.findMany({ where: { containerNodeId: canvasNodeId } })` — to
the existing `Promise.all`, builds a `Map<realEndpointId, {posX,posY}>`, and attaches
`posX`/`posY` (else `null`) to each derived `boundaryProxies` row. The five derived
fields are unchanged; `posX`/`posY` are additive and nullable. The client seeds a
proxy at its stored placement when both are non-null, else onto the left rail (the
unchanged fallback). A never-dragged proxy reads `null` and lands on the rail exactly
as before.

### Drag is the one passive-node interactive exception; the key is `realEndpointId`

The proxy no longer pins `draggable:false`; it inherits the island's
`nodesDraggable={canEdit}`, so it is draggable for an editor and inert for a viewer
(ADR-0016, amended). `onNodeDragStop` routes a `boundary-proxy` node to
`persistProxyPlacement` (a single placement — a proxy is `selectable:false`, never
multi-dragged) and a Component to the existing batched `persistPositions`. The
optimistic path mirrors `persistPositions`: the RF store already shows the dropped
position; the cache mirror patches EVERY per-edge `boundaryProxies` row sharing the
`realEndpointId` (so a remount re-seeds the coalesced node to the dropped spot); the
owner-only `upsertBoundaryProxyPlacement` runs; on failure the store node snaps back
and the mirror restores, with a "Couldn't save the position" toast. The drag/seed/
persist key is `node.data.realEndpointId` throughout — NEVER the representative node
id `proxy_<edgeId>`.

## Consequences

- A boundary proxy's placement survives reload, scope re-entry, coalescing rep-edge
  changes (delete one of two crossing edges, the survivor stays placed — the key is
  the endpoint), and undo/reconnect (the re-seed prefers stored placement at every
  `toProxyRFNode` call site).
- The Canvas read stays one round trip; the placement write is one owner-only
  mutation per drag-stop, optimistic with rollback (the perf + convenience model).
- **Reviewable invariant — frozen derived identity.** The five derived
  `boundaryProxies` fields are unchanged; `posX`/`posY` are additive nullable adjunct
  fields joined from `BoundaryProxyPlacement`. Folding any derived identity field into
  the placement table, or persisting title/kind/realEndpointId, regresses ADR-0031.
- **Reviewable invariant — `realEndpointId` is the key, never `proxy_<edgeId>`.** The
  natural key, the drag key (`node.data.realEndpointId`), the seed key, and the cache
  mirror's patch predicate all key on the off-scope endpoint (the coalesced grain,
  #90). Keying any of them on the per-edge representative node id fragments the
  placement and regresses this ADR.
- **Reviewable invariant — owner-only at the service layer.** `assertCanWrite` gates
  the write; `protectedProcedure` is only the transport gate (ADR-0001). A viewer
  cannot drag (the proxy inherits `nodesDraggable={canEdit}`) AND cannot write (the
  service rejects).
- **Reviewable invariant — root-scope single placement.** The `NULLS NOT DISTINCT`
  index gives the root scope (`containerNodeId IS NULL`) exactly one placement per
  endpoint. Replacing it with a plain `@@unique`, or dropping NULLS-NOT-DISTINCT,
  re-admits duplicate root-scope rows; the hand-authored upsert's `findFirst` branch
  exists precisely because the generated client cannot express that uniqueness.
- **`pnpm check` cannot see into raw SQL or the index semantics** (ADR-0006/0010): the
  NULLS-NOT-DISTINCT behaviour and the join correctness rest on running against real
  Postgres (the dev-browser acceptance run + any future service tests), not on the
  type checker.
- A stale placement (an endpoint that no longer crosses this scope) finds no proxy to
  attach to and is silently ignored; the FK cascade reclaims it when either Node is
  hard-deleted. We do NOT garbage-collect placements on Connection delete — they are
  cheap, and a re-drawn crossing Connection should find its old placement waiting.

## Does NOT touch

Markdown export / MCP serialization is position-independent (ADR-0017): a placement is
a pure view coordinate, so no golden re-baseline, no tool-catalog or `llms.txt` change.

## Realized in #145

The placed-vs-rail layout this ADR defines (`placedProxyNodes`, `railPosition`,
`railOccupants`, `toProxyRFNode`, all keyed on `realEndpointId`) moved verbatim out of
the canvas island into the pure, framework-free `boundaryProxyView`
(`boundary-proxy-view.ts`), where it is unit-tested off-screen; no rendered behavior
changed.

## Realized in #149

The inline "does any surviving edge still reach this off-scope Component?" survival
re-derivations in the delete/undo paths (`commitDeleteConnection`'s `survivesElsewhere`
and `removeComponent`'s `survivingEndpoints`) now route through
`boundaryProxyView.survivingProxies`, the same pure module the layout helpers live in;
no behavior changed.

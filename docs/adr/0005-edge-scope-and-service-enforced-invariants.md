# 5. Edge scope is an explicit `canvasNodeId`; graph invariants live in the service, not the database

## Status

Accepted *(amended by ADR-0009 — the "direction is cosmetic / never factors into de-dupe"
sub-decision below is superseded; the explicit `canvasNodeId` scope, the service-enforced
invariants, and the `(canvasNodeId, sourceId, targetId)` de-dupe key all remain in force.
Amended further by ADR-0010 — the named partial-unique-index hardening of the de-dupe
rule landed; the service remains the primary enforcement, the index is the backstop.
Amended further by [ADR-0012](0012-routeflow-sole-cross-scope-edge-writer.md) — the
anticipated same-Canvas loosening for the refinement Connection landed: `routeFlow` is
the sole bounded-loose cross-scope Edge writer, `connectNodes` stays strict.
Amended further by [ADR-0023](0023-connection-direction-derived-from-flows.md) — the
de-dupe key changes from the **ordered** triple to the **unordered** pair
`(canvasNodeId, {sourceId, targetId})`: a Connection is undirected, so A→B and B→A are
the same Connection. The explicit-scope and service-enforced-invariant decisions are
untouched; only the ordered-pair distinctness flips.
Amended further by [ADR-0028](0028-cross-scope-connections-lineal-ingress.md)
(#62) — the **same-Canvas endpoint invariant is RETIRED** and the explicit
`canvasNodeId` scope is **dropped**: scope is now derived from endpoint ancestry
(#63), `connectNodes` accepts cross-scope + **lineal** endpoints and rejects only
the self-link, and the "scope is explicit" reviewable invariant is **inverted**
(a future stored `canvasNodeId` is the regression). The service-enforced-invariant
*posture* survives; the Edge gains an `interaction` column
([ADR-0027](0027-connection-carries-its-own-interaction.md)).)*

## Context

This slice introduces the first **Edge** (the data-model representation of a
**Connection**; see CONTEXT.md). It raises two design questions that bind every
later graph slice, so they are worth deciding deliberately.

**1. How does an Edge know which Canvas it is on?** A **Canvas** is a *derived
view*, not a stored entity (`{ Nodes where parentId = N } ∪ { Edges where
canvasNodeId = N }`), so an Edge has no Canvas row to reference. The obvious
approach infers an Edge's Canvas from its endpoints: both endpoints share a
`parentId`, so that shared value *is* the scope. This works today, when every
Connection links two Components on one Canvas — but it has no answer for the M5
**refinement Connection**, which legitimately links a **boundary proxy** on an
interior Canvas to the real Component it stands for, i.e. endpoints that sit at
*different* scope levels. An inferred-scope model paints that corner the moment
endpoints diverge.

**2. Where are the Edge invariants enforced?** Three must hold: both endpoints
sit on the same Canvas as the Edge, an Edge never links a Node to itself, and no
two *active* Edges share the same source, target, and scope. These could be
enforced by database constraints (a partial unique index) or by the service
layer. The repo's testable-seam philosophy (ADR-0001) and isolated-Postgres
harness (ADR-0003) already make the service the place correctness is asserted.

## Decision

**Edge scope is an explicit `canvasNodeId` column** (the Component whose interior
Canvas owns the Edge; `null` = the Project root). Scope is *recorded*, never
inferred from the endpoints. The adapter supplies it (the client already knows
the Canvas it is drawing on); the service stores it. Because the value is
stored rather than derived, the M5 refinement Connection — whose endpoints span
levels — needs no schema change; only the validation rule will loosen.
`getCanvas` selects an Edge into a scope by `canvasNodeId`, mirroring how Nodes
are selected by `parentId`, preserving the single-round-trip read (ADR-0001).

**The three invariants are enforced in `connectNodes` in the service, not by
database constraints.** The function loads the endpoints, then:

- rejects a self-Connection (`sourceId === targetId`);
- confirms both endpoints belong to the owned Project and that each endpoint's
  `parentId` equals the supplied `canvasNodeId` (same-Canvas) — the endpoint
  re-validation reuses the set-membership pattern `updatePositions` uses to keep
  a foreign Node id out of a batch write;
- rejects a duplicate **active** Edge.

**The de-dupe key is the ordered triple `(canvasNodeId, sourceId, targetId)`,
matched only against non-soft-deleted Edges.** Consequences of that precise
definition:

- `A → B` is a **distinct** Connection from `B → A` — distinctness is the
  *ordered pair of endpoints* (which Node is `sourceId`, which is `targetId`),
  not any rendered metadata.
- The cosmetic `direction` (arrowheads) and `label` do **not** factor into
  duplicate-ness. Re-drawing `A → B` with a different arrowhead or label is the
  user editing the existing Connection (via `updateEdge`), not creating a second
  one.
- A soft-deleted Edge never blocks re-creation, so erase-and-redraw works.

A database **partial unique index** (`WHERE deletedAt IS NULL`) to harden the
de-dupe rule under concurrency is **explicitly out of scope** for this slice, the
same way ADR-0002 defers slug rotation.

Identity and authorization are unchanged from ADR-0001/0002: `connectNodes`,
`updateEdge`, and `deleteEdge` are owner-only via `access.assertCanWrite`;
ownership comes from the **actor**, never from `input`; a slug grants reads, never
writes. Removal is soft-delete (`deletedAt`), keeping every agent-made change
recoverable.

## Consequences

- The model supports cross-scope refinement Connections (M5) with no migration —
  the cost is one stored column and the discipline that scope is *passed in*,
  never derived. That payoff is the whole reason the non-obvious design is worth
  it. **"Scope is explicit, not inferred" is now a reviewable invariant:** a
  future change that starts deriving an Edge's Canvas from its endpoints is a
  regression against this ADR, not a simplification.
- The three invariants are **unit-testable against real Postgres** with no HTTP,
  session, or React in the way (ADR-0003), and are identical for the web and the
  future MCP path — the same reason authorization lives in the service.
- Because de-dupe is a service-time read-then-write rather than a DB constraint,
  a concurrent double-submit *could* in principle race two identical active
  Edges. Accepted for this slice: writes require the single signed-in owner and
  the UI is optimistic, so the window is negligible; the partial unique index is
  the named hardening path if it ever matters. **Reviewers must not "fix" this by
  adding a naive `@@unique`** — it would also forbid re-creating a Connection
  after soft-delete (the `deletedAt IS NULL` condition a plain unique index
  cannot express).
  **Realized by ADR-0010**: the partial unique index `idx_edge_dedup` now
  backstops the race; the service's `findFirst` remains the primary, readable
  enforcement path and both translate to the same `ConflictError`. The "no
  naive `@@unique`" caution above still applies — only the
  `WHERE "deletedAt" IS NULL NULLS NOT DISTINCT` partial form is correct.
- The shared domain-error vocabulary widens additively: `ConflictError`
  (`CONFLICT`, the duplicate) and `ValidationError` (`BAD_REQUEST`, the self-link
  and cross-Canvas cases) join `ForbiddenError`/`NotFoundError`. Each transport
  maps the stable `code` to its own shape; the future MCP adapter inherits this
  for free.

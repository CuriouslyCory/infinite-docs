# 28. A Connection may link any two Components at any scope; the same-Canvas invariant is retired

## Status

Accepted (#62, the re-founding slice).

**Supersedes** [ADR-0005](0005-edge-scope-and-service-enforced-invariants.md)'s
same-Canvas endpoint invariant and its explicit-`canvasNodeId`-scope decision:
an Edge no longer stores its scope; scope is *derived* from endpoint ancestry
(the derivation lands in #63). The service-enforced-invariant *posture*
(correctness lives in the service, not the DB) survives — only the same-Canvas
and explicit-scope sub-decisions are superseded.

**Supersedes** [ADR-0012](0012-routeflow-sole-cross-scope-edge-writer.md)
(`routeFlow` as the sole bounded cross-scope Edge writer) — the gated exception
is obsolete because *all* `connectNodes` writes may now be cross-scope;
`routeFlow` and the boundary-endpoint derivation are deleted with the Flow model.

**Amends** [ADR-0024](0024-movenode-reparent-reject-orphaning.md) (`moveNode`
drops its orphan-reject — see below). **Relates to**
[ADR-0027](0027-connection-carries-its-own-interaction.md) (the typed-Connection
half of the same re-founding).

## Context

ADR-0005 enforced "both endpoints sit on the same Canvas as the Edge," recording
scope in an explicit `canvasNodeId` and anticipating exactly one gated loosening
(the M5 refinement Connection, realized as `routeFlow` in ADR-0012).

The re-founding model makes cross-scope the *common* case, not a gated
exception: a Connection should link a top-level external API directly to a deep
internal handler, or a parent Component to a child it contains. The same-Canvas
rule and its single-exception writer are now friction, not safety.

A parent→child (**lineal**) Connection has real meaning: it records **ingress**
— traffic entering the parent and continuing to the child. The model must accept
lineal endpoints, not just sibling-cross-scope ones.

Storing scope (`canvasNodeId`) is now actively wrong: an Edge spanning scopes has
no single owning Canvas. Scope becomes a *derived* property of endpoint ancestry
(the derivation, and the boundary-proxy rendering it feeds, is #63).

## Decision

### `connectNodes` accepts cross-scope and lineal endpoints; rejects only the true self-link

The only endpoint integrity rule left is `sourceId !== targetId`.
Sibling-cross-scope, ancestor↔descendant (lineal), and same-Canvas endpoints are
all valid. The endpoint Nodes are still confirmed live and in the owned Project
(cross-project smuggling stays closed), but their `parentId`s are not
constrained.

### Lineal connections are allowed and express ingress

A parent→child Connection (an ancestor and one of its descendants) is explicitly
legal and means **ingress**: traffic entering the parent and continuing to the
descendant. There is no lineal-reject. *(This is the load-bearing record the
issue mandates — "lineal connections = ingress, recorded explicitly.")*

### Edge scope is derived from endpoint ancestry, not stored

Drop `canvasNodeId`. The derivation that answers "which scope(s) does this Edge
appear on" — and the boundary-proxy rendering it feeds — is #63 / ADR-0031. #62
lands the column drop and the loosened writer; until #63, a cross-scope Edge
renders on neither endpoint's Canvas (only same-Canvas Connections render).

### The cross-scope gated writer is deleted, not generalized

`routeFlow`, the boundary-endpoint derivation, the `FOR UPDATE` inner-Edge race
lock, and find-or-create inner-Edge convergence (all ADR-0012) are removed with
the Flow model. `connectNodes` is the single Edge writer and is now
unconditionally scope-agnostic.

### `moveNode` drops its orphan-reject

ADR-0024's orphan-reject existed solely because the same-Canvas invariant pinned
a Component's incident Edges to its Canvas, so a reparent would strand them. With
Connections allowed to span scopes, a reparented Component's incident Connections
simply become cross-scope — there is nothing to orphan. The orphan-reject and its
`conflictingEdgeIds` channel are removed. **The cycle-reject stays** — it is
independent of edge scope and remains `moveNode`'s sole rejection.

## Consequences

- **Reviewable invariant:** *`connectNodes` rejects only `sourceId === targetId`.
  Re-introducing a same-Canvas check, a stored `canvasNodeId`, a lineal-reject,
  or a separate gated cross-scope writer regresses this ADR.*
- ADR-0005's "scope is explicit, not inferred" reviewable invariant is
  **inverted**: scope is now *derived*, and a future stored `canvasNodeId` is the
  regression. Called out so a reviewer reading ADR-0005 in isolation is not
  misled.
- The Edge cascade sweep that unioned `canvasNodeId` (ADR-0008) loses that column
  from its predicate — endpoint membership (`sourceId ∈ S ∨ targetId ∈ S`) is now
  the whole rule, and stays complete precisely because scope is gone (ADR-0030).
- Net deletion: the boundary-endpoint derivation, the inner-Edge race lock, and
  find-or-create convergence (all ADR-0012) are gone with `routeFlow`.
- **Deferred to #63:** deriving an Edge's scope from ancestry; rendering an Edge
  whose endpoints span scopes (the redefined boundary proxy / ADR-0031). #62 can
  *create* cross-scope Edges but does not yet *render* them cross-scope.

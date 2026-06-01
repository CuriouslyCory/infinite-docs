# 24. `moveNode` reparents by writing only `parentId`, rejecting any move that would orphan an incident Connection

## Status

Accepted (#19, MCP write tools).

**Relates to** [ADR-0005](0005-edge-scope-and-service-enforced-invariants.md)
(`moveNode` preserves the same-Canvas invariant by rejecting; it is **not** a
new cross-scope writer),
[ADR-0008](0008-cascading-soft-delete-stamped-batch.md) and
[ADR-0014](0014-deleteedge-restoreedge-cascade.md) (contrast — `deleteNode`
cascades; `moveNode` deliberately does not),
[ADR-0010](0010-edge-dedup-partial-unique-index.md) (the
`ConflictError.details` self-correction channel `moveNode` reuses), and
[ADR-0012](0012-routeflow-sole-cross-scope-edge-writer.md) (the inner-Edge
exception — analyzed below as **not** breaking the reject's correctness).

## Context

`Node` carries `parentId`, but no service has written it past creation —
CONTEXT.md's `Node` entry has long flagged reparenting (`move`) with cycle
prevention as a "later milestone," and several comments in the codebase
(`node.service.ts` ANCESTRY_DEPTH_CAP, the `deleteNode` subtree CTE, the
`getCanvas` breadcrumb cap) treat cycle prevention as the move feature's
problem. #19 adds an MCP `move_component` tool; it needs a service to wrap.

A reparent is the first **structural** Node mutation. Two questions decide
its shape:

1. **Cycle prevention.** A move whose new parent sits inside the moving
   subtree would create a cycle and break every recursive walk in the
   codebase (breadcrumbs, boundary derivation, `deleteNode`).
2. **Incident Connections.** Before a move, the same-Canvas invariant
   (ADR-0005) guarantees every active Edge incident to the Component lives
   on its **old** Canvas (`canvasNodeId = oldParentId`). After a move, those
   Edges would dangle — endpoints on the new Canvas, but `canvasNodeId`
   pointing at the old one.

Three options for the incident-edge problem:

- **Cascade-move** — rewrite each incident Edge's `canvasNodeId` to the new
  parent. Forces a same-Canvas decision for **both** endpoints (the other
  endpoint did **not** move, so the Edge would now span two Canvases — the
  same loosening of ADR-0005 that `routeFlow` deliberately gates), and
  requires inventing "move-undo" semantics now.
- **Sever-and-restore** — soft-delete incident Edges with a stamped
  `deletionId`, like `deleteEdge`. Destroys user intent (the Connections)
  to make a structural op succeed — philosophy #6's "turn off the rule to
  pass" anti-pattern in soft-delete drag.
- **Reject** — refuse the move while any active incident Edge remains;
  surface the blocking ids; let the caller disconnect first.

Cycle prevention itself has the matching choice between **`ValidationError`
(BAD_REQUEST)** — "this request is invalid for this node, no state change
makes it valid" — and **`ConflictError` (CONFLICT)** — "valid request, change
the state and retry." Those mean different things to an MCP agent.

## Decision

### `moveNode(db, actor, { id, parentId })` writes only `parentId`

Single-field write. No cascade, no sever, no schema change. The
load-then-authorize shape from `updateNodeKind` / `updateNodeDocumentation`,
re-using `access.assertCanWrite` for owner-only authorization (ADR-0001).

### Cycle → `ValidationError` (BAD_REQUEST)

Compute the moving subtree with the same recursive `parentId` CTE
`deleteNode` uses. If `parentId !== null` and `parentId` falls in the subtree
(including depth 0, `parentId === node.id`), reject with
`ValidationError`. The semantic is "this request can never be valid for this
specific Node" — the agent must not retry with the same args.

### Orphaning incident Connections → `ConflictError` with structured details

Query active Edges with `sourceId = node.id OR targetId = node.id`. If any
remain, reject with `ConflictError` carrying
`details.conflictingEdgeIds`. The agent reads the blocking ids, calls
`delete_component_connection` (or whatever the appropriate tool is on the
slice that lands it), and retries the move. The structured channel is the
ADR-0010 named pattern, third adopter — same envelope `connectNodes` and
`restoreEdge` use.

### Idempotent no-op

A move to the current parent is a no-op (returns the node unchanged). The
canonical "agent retries the same call after a deferred state change" pattern
this admits is cheap and friendly.

### Considered: a refinement FlowRoute inside the moving subtree

A FlowRoute's `innerEdgeId` references a cross-scope inner Edge — the one
gated exception to ADR-0005. Under current writers, **no additional reject
is required**, because the constraints `routeFlow` and `connectNodes` enforce
make the case self-consistent:

- `routeFlow` pins `boundaryNodeId` (the Flow's owner) to an endpoint of the
  outer Edge.
- `connectNodes` keeps the outer Edge strictly same-Canvas — both endpoints
  share `parentId`.
- Combining the two: the inner Edge's `canvasNodeId` (the outer Edge's
  *other* endpoint) and the boundary endpoint share a parent.

So whenever the inner Edge's scope rides into the moving subtree, the
boundary endpoint rides with it. The route's "one scope below the outer
Edge's other endpoint" premise stays true after the move. Move-side cover
for the inner-Edge exception is **not needed today**.

If a future writer loosens these constraints (deeper refinement nesting,
boundary endpoints decoupled from the outer Edge, a hand-authored migration
that produces orphaned inner Edges), `moveNode` will need a third reject:
any active `FlowRoute` whose inner Edge has `canvasNodeId` in the moving
subtree, with `details.conflictingFlowRouteIds`. The placement is named
explicitly so the future change is local.

### Out of scope

- A reparent-by-drag UI / tRPC `move` procedure. The service is exercised by
  vitest and the MCP `move_component` tool only this slice.
- Cascade-move and sever-and-restore. Both are defensible follow-ups; both
  require move-undo semantics that don't exist.
- Cross-project moves. The new parent must live in the moved Node's project,
  same posture `createNode` uses for the child case.

## Consequences

- **Cycle prevention is now realized**, not just defended. The previous
  comments at `ANCESTRY_DEPTH_CAP` and the `deleteNode` subtree CTE that
  named "a future move/reparent feature" as the cap's reason are updated to
  name `moveNode` as the owner. The cap remains a belt-and-suspenders bound
  and a real depth limit.
- **The `(db, actor, input) → result` contract holds**, and `moveNode`
  routes authorization through the `access` module like every other write.
  An MCP agent calling `move_component` and a (future) web caller hit the
  same gates.
- **`ConflictError.details` adds no new key.** The existing
  `conflictingEdgeIds` (added by ADR-0010 for `connectNodes` and reused by
  `restoreEdge`) carries the orphaning case verbatim. The MCP write adapter
  (`toMcpWriteError`) reads `cause.details` generically and exposes it as
  `data.archDetails` — the wire shape future Flow / FlowRoute tools (#40 /
  #42) reuse unchanged.
- **The "lone delete" carve-out is intact.** This ADR mints no new
  `deletionId` — `moveNode` is a single-row update, and rejected moves write
  nothing. The cascade machinery (ADR-0008 / ADR-0014) stays exactly as is.
- **TOCTOU**: a concurrent `connectNodes` could commit an incident Edge
  between the orphan check and the `parentId` write. `moveNode` therefore
  contracts that the caller wraps in `db.$transaction` — the MCP tool
  registry does. A racer that slips past at most adds a valid edge the
  *next* move call will catch; nothing corrupts.

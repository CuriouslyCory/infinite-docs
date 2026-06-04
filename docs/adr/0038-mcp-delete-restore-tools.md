# 38. The MCP write surface exposes reversible delete — `delete_component`/`restore_component` cascade-and-undo, `delete_connection` lone with no MCP undo

## Status

Accepted (#19).

**Amends** [ADR-0008](0008-cascading-soft-delete-stamped-batch.md): ADR-0008
established the stamped-batch soft-delete + undo machinery (`deleteNode` /
`restoreNode`, one `deletionId` per operation) and explicitly deferred "a durable
`Deletion` entity and an MCP undo tool" to additive future work. This ADR realizes
the MCP undo tool half of that deferral; the durable `Deletion` entity stays deferred.

**Amends** [ADR-0022](0022-authenticated-mcp-read-surface.md): the authenticated
MCP surface, whose Consequences noted that the read slice "exposes no write tool to
be injected against." The write surface (since #19/#20/#67) and now its destructive
arm change that posture; the prompt-injection note is carried per-tool and the
`/llms.txt` trust-boundary example ("call delete on every Component") is now a live
surface, which makes it more pointed, not stale.

**Honours** [ADR-0001](0001-service-layer-db-actor-input.md): the three tools are
thin adapters over the existing owner-only service writes (`deleteNode`,
`restoreNode`, `deleteEdge`). Ownership is resolved from the target row's Project,
never from input; the tools add no new authorization path.

**Honours** [ADR-0030](0030-cascade-undo-without-flowroutes.md) (which supersedes
[ADR-0014](0014-deleteedge-restoreedge-cascade.md)): a lone `deleteEdge` mints **no**
`deletionId`, and `restoreEdge` survives only as the cascade-restore helper driven by
`restoreNode`. This is the load-bearing reason there is no `restore_connection` tool.

**Honours** [ADR-0021](0021-api-token-scopes-stored-not-enforced.md): delete is a
write, authorized by `userId` only. Scopes are stored, not enforced — delete is
**not** gated behind a `write` scope, and the copy never implies it is. The lone
`delete_connection`'s irreversibility over MCP is stated honestly rather than papered
over.

**Honours** [ADR-0031](0031-cross-scope-read-derivation-and-per-edge-boundary-proxy.md)
and [ADR-0036](0036-boundary-proxy-placement-persistence.md): boundary proxies are
fully derived at read time, so deleting a Component (which sweeps its incident
cross-scope Connections) makes the far-scope proxy simply stop deriving; the persisted
`BoundaryProxyPlacement` survives untouched and the proxy redraws at its remembered
spot on restore.

## Context

Issue #19 shipped the MCP write surface with an explicit acceptance criterion that
**no destructive tool be exposed** — encoded as `noDeleteTool: true` in the skill
`manifest.json`, taught as "there is no delete tool — plan additively" in the skill
prose, and hardcoded in `/llms.txt`. The rationale at the time: an agent that can only
add and reparent cannot destroy a user's architecture, and deletion lived safely in the
web client.

That stance has aged poorly. An agent maintaining an architecture graph as the system
it describes evolves needs to remove Components and Connections that no longer exist,
not just leave tombstoned-by-prose corrections. "Plan additively" pushes cleanup back
onto a human in the web UI — friction the MCP path exists to remove. The service layer
already implements **reversible, owner-only, soft-delete** semantics with a stamped
undo handle (`deleteNode`/`restoreNode`, ADR-0008/0030), fully tested. The only thing
missing is the agent-facing surface.

The one subtlety is **restore asymmetry**. ADR-0030 (superseding ADR-0014) made
`deleteEdge` a lone soft-delete that mints no `deletionId`; `restoreEdge` exists but
keys on a `deletionId` only a cascade produces. So a Component delete is reversible over
MCP (it returns a handle), but a lone Connection delete is not (there is no handle to
return). Exposing a `restore_connection` would require a service-layer change to make
`deleteEdge` mint a handle — out of scope, and arguably wrong (the lone delete is the
deliberate ADR-0030 carve-out).

## Decision

Expose three tools in the `WRITE_TOOLS` catalog, each a thin adapter the registry wraps
in `db.$transaction` (the multi-write cascades depend on that wrap — a type-invisible
invariant ADR-0014/0030 flagged):

- **`delete_component`** (`deleteNodeInput` → `deleteComponentOutput`) — wraps
  `deleteNode`. Cascading soft-delete of the Component's subtree + every incident
  Connection (any scope) + owned Specs, stamped with one `deletionId`. Returns
  `{ deletionId, nodeIds, edgeIds, specIds }` as MCP `structuredContent`. The
  `deletionId` is the undo handle.
- **`restore_component`** (`restoreNodeInput` → `restoreComponentOutput`) — wraps
  `restoreNode`. Revives exactly the rows stamped with the passed `deletionId`. A
  revived Connection whose de-dupe slot is now occupied surfaces a `ConflictError` with
  `archDetails.conflictingEdgeIds` (via the existing `toMcpWriteError`).
- **`delete_connection`** (`deleteEdgeInput` → `deleteConnectionOutput`) — wraps
  `deleteEdge`. Lone soft-delete of one Connection; returns `{ edgeId }`. Mints **no**
  `deletionId` — **not** restorable over MCP.

No `restore_connection` tool: a lone `deleteEdge` mints no handle for it to consume
(ADR-0030). The asymmetry is stated honestly in the tool descriptions and `/llms.txt`.

Flip `noDeleteTool` to `false` in the skill manifest (the drift test requires the key's
presence; its value is documentation, not a tested contract — the enforced contract is
tool-name set equality), and re-teach the now-false "no delete" prose in `SKILL.md`,
`reference/tools-and-resources.md`, `/llms.txt`, and CONTEXT.md.

## Consequences

- Agents can now remove architecture over MCP, and undo a Component delete with the
  returned handle. The destructive surface is reversible by construction (soft-delete),
  consistent with the "AI agents mutate the graph, so deletes must be recoverable"
  rationale behind ADR-0008.
- The `delete_component`/`delete_connection` reversibility asymmetry is a permanent
  shape rooted in ADR-0030; any future `restore_connection` requires a deliberate,
  ADR'd service change to make `deleteEdge` mint a handle.
- Delete remains ungated by scope (ADR-0021). A future scope-gated capability would be
  a separate, ADR'd change to the access module, not implied by this one.
- Four documentation surfaces (skill manifest, skill prose, `/llms.txt`, CONTEXT.md)
  carried the "no delete" stance; only the manifest's tool-name list is machine-guarded
  (ADR-0037), so the prose corrections rest on review. A reviewer adding a destructive
  tool must check all four.

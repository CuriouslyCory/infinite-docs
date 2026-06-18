/**
 * The pure, DOM-free VIEW logic for boundary proxies — the off-scope stand-ins a
 * cross-scope Connection renders for its far endpoint (ADR-0031). Extracted out of
 * the Canvas island so the fragile layout + coalescing rules are unit-testable
 * off-screen (#145), mirroring `optimistic-write.ts` as the structural template:
 * no `"use client"`, no hooks, no React or DOM, and `@xyflow/react` stays a
 * TYPE-ONLY dependency (never a value import), so the module ships in the Canvas
 * client island without dragging the diagramming library into a test's node graph.
 *
 * What lives here:
 * - `repOnScope` — `rep(N, S)` of ADR-0031 (the on-scope representative walk).
 * - `coalesceProxies` — render-time fold of per-edge proxy rows onto ONE node per
 *   distinct off-scope Component (#90), with the stable representative-id rule.
 * - rail-vs-placement layout (`placedProxyNodes`, `railPosition`, `railOccupants`,
 *   `toProxyRFNode`) keyed on `realEndpointId` (#91 / ADR-0036).
 * - `survivingProxies` — which off-scope endpoints still have a retained edge.
 */

import type { CanvasBoundaryProxy, ProjectComponent } from "~/lib/types";

import type { BoundaryProxyNode } from "./boundary-proxy";
import type { CanvasRFNode } from "./canvas";

// The left-rail seed slot for the `i`-th distinct off-scope endpoint with no
// stored placement — the fallback layout that reads a proxy as an off-scope
// stand-in rather than a free Component (ADR-0031).
export const RAIL_X = -280;
export function railPosition(i: number): { x: number; y: number } {
  return { x: RAIL_X, y: i * 72 };
}

// Whether a boundary proxy carries a stored placement (#91 / ADR-0036). Both
// coordinates non-null is the "placed" signal; either null means never-dragged on
// this scope, so it falls back to the left rail.
function isPlaced(p: CanvasBoundaryProxy): boolean {
  return p.posX !== null && p.posY !== null;
}

// How many boundary-proxy nodes currently sit ON the left rail (x === RAIL_X) —
// the count an incremental add seeds the NEXT unplaced rail node below. Placed
// proxies (#91) live off the rail at their stored coordinate, so they don't count;
// the RF node carries no posX/posY, so the rail is identified by x position.
export function railOccupants(nodes: readonly CanvasRFNode[]): number {
  return nodes.filter(
    (n) => n.type === "boundary-proxy" && n.position.x === RAIL_X,
  ).length;
}

// Lay out a group of coalesced boundary-proxy reps (#90): each PLACED proxy seeds
// at its stored coordinate (#91 / ADR-0036), each unplaced one takes the NEXT
// rail slot below `railBase`, so placed proxies never consume a rail slot and the
// remaining rail stays tight. The drag/seed/persist key is `realEndpointId`
// (stable, coalesced), so a placement persisted for one crossing edge re-seeds
// every edge's coalesced node to the same spot.
export function placedProxyNodes(
  reps: readonly CanvasBoundaryProxy[],
  breadcrumbIds: ReadonlySet<string>,
  railBase = 0,
): BoundaryProxyNode[] {
  let rail = railBase;
  return reps.map((p) =>
    toProxyRFNode(
      p,
      breadcrumbIds,
      isPlaced(p) ? { x: p.posX!, y: p.posY! } : railPosition(rail++),
    ),
  );
}

// A boundary proxy renders as a passive, read-only stand-in for the off-scope
// endpoint of a cross-scope Connection (ADR-0031). `lineal` is true when the real
// endpoint is an ANCESTOR of this scope (it appears on the breadcrumb trail) — the
// ingress case the proxy must label distinctly so it doesn't read as "the host
// inside itself".
//
// Dragging is the ONE interactive exception (#91 / ADR-0036): a proxy can be
// dragged so its per-scope placement persists. We do NOT set per-node `draggable`
// here — that would override the island's `nodesDraggable={canEdit}` and let a
// VIEWER drag it; instead the proxy INHERITS that flag, exactly like a Component,
// so it is draggable for an editor and inert for a viewer. It stays explicitly
// non-selectable / non-connectable / non-deletable — passive everywhere else
// (ADR-0016). Maps a single proxy ROW; coalescing rows that share a `realEndpointId`
// is the seed's concern (`coalesceProxies`, #90), not this helper's.
export function toProxyRFNode(
  p: CanvasBoundaryProxy,
  breadcrumbIds: ReadonlySet<string>,
  position: { x: number; y: number },
): BoundaryProxyNode {
  return {
    id: p.nodeId,
    type: "boundary-proxy",
    position,
    selectable: false,
    connectable: false,
    deletable: false,
    data: {
      title: p.title,
      kind: p.kind,
      realEndpointId: p.realEndpointId,
      lineal: breadcrumbIds.has(p.realEndpointId),
      // Cross-project proxy marker (#122): carry the foreign Project title through
      // so the node renders "From [Foreign Project]". Undefined for an ordinary
      // same-project cross-scope proxy.
      foreignProjectTitle: p.foreignProjectTitle,
      // Cross-boundary "Go to" routing (#123): the portal to push onto `?via=` and
      // the foreign scope to land on. Present only for a cross-project proxy.
      referenceNodeId: p.referenceNodeId,
      foreignParentScopeId: p.foreignParentScopeId,
    },
  };
}

// Render-time coalescing (#90): getCanvas emits ONE boundary-proxy row per
// crossing edge (`proxy_<edgeId>`, ADR-0031), so several interior Components
// connecting to the SAME off-scope Component yield several rows sharing a
// `realEndpointId`. Group them so the Canvas draws ONE node per distinct off-scope
// Component, and return a `remap` from every member's `nodeId` to that group's
// representative so each crossing edge routes to the shared node (`toRFEdge`).
//
// This is a VIEW-ONLY fold: the cache mirror, getCanvas, and the sidebar
// CONNECTIONS list stay strictly per-edge (ADR-0031's per-crossing-edge
// invariant) — de-duping them to match the view would strip the per-edge keys
// `removeComponent`/undo and the Connections list depend on.
//
// The representative is the lexicographically-smallest `nodeId` among the group's
// REAL (non-`temp_`) members, falling back to a temp member only when the whole
// group is still optimistic — so a second connection reconciling temp → real never
// churns the rep id out from under the edges already routed to it. `title` / `kind`
// / `realEndpointId` / `lineal` are identical across a group (same real Node, same
// breadcrumbs), so any member is a valid representative for display + navigation.
export function coalesceProxies(proxies: readonly CanvasBoundaryProxy[]): {
  reps: CanvasBoundaryProxy[];
  remap: ReadonlyMap<string, string>;
} {
  const groups = new Map<string, CanvasBoundaryProxy[]>();
  for (const p of proxies) {
    const g = groups.get(p.realEndpointId);
    if (g) g.push(p);
    else groups.set(p.realEndpointId, [p]);
  }
  const reps: CanvasBoundaryProxy[] = [];
  const remap = new Map<string, string>();
  // Sort the distinct endpoints so rail order is deterministic regardless of edge
  // insertion order (and so a remount re-seeds the same rail layout).
  for (const realEndpointId of [...groups.keys()].sort()) {
    const members = groups.get(realEndpointId)!;
    const real = members.filter((m) => !m.edgeId.startsWith("temp_"));
    const pool = real.length > 0 ? real : members;
    const rep = pool.reduce((a, b) => (a.nodeId <= b.nodeId ? a : b));
    reps.push(rep);
    for (const m of members) remap.set(m.nodeId, rep.nodeId);
  }
  return { reps, remap };
}

// The id of the coalesced boundary-proxy node currently standing in for
// `realEndpointId` in the RF store, or null if none (#90). The RF store — not the
// cache mirror — is the routing source of truth: a joined edge's reconcile can
// leave the mirror's chosen representative ahead of the node actually rendered, so
// incremental paths resolve "is there already a node for this endpoint?" against
// the live nodes, never the per-edge mirror.
export function existingProxyNodeIdFor(
  nodes: readonly CanvasRFNode[],
  realEndpointId: string,
): string | null {
  const hit = nodes.find(
    (n) =>
      n.type === "boundary-proxy" && n.data.realEndpointId === realEndpointId,
  );
  return hit ? hit.id : null;
}

/**
 * The on-scope representative of `targetId` for scope `scopeId` — the `rep(N, S)`
 * of ADR-0031, computed client-side from the flat `parentId` map the project-wide
 * read returns: the ancestor of the target whose parent IS the scope, or `null`
 * when the scope is not on the target's ancestor chain (the target is off-scope,
 * and its far end renders as a boundary proxy). Returns the target itself when it
 * is interior to the scope. The `parentId === scopeId` test handles the root scope
 * (`scopeId === null`) too. Bounded by the map size — cycles are impossible
 * (`moveNode` rejects them, ADR-0024), so the guard is a belt-and-suspenders fuse.
 */
export function repOnScope(
  targetId: string,
  scopeId: string | null,
  byId: ReadonlyMap<string, ProjectComponent>,
): string | null {
  let cur = byId.get(targetId);
  let guard = 0;
  while (cur && guard <= byId.size) {
    if (cur.parentId === scopeId) return cur.id;
    if (cur.parentId === null) return null;
    cur = byId.get(cur.parentId);
    guard += 1;
  }
  return null;
}

/**
 * The set of off-scope `realEndpointId`s that still have a retained crossing edge —
 * the coalesced "does ANY surviving edge still reach this off-scope Component?"
 * question, framed on `retainedEdgeIds` (what survives) so it composes for the
 * delete/undo/connect paths that decide whether to keep or drop a coalesced proxy
 * node (#149). Generalizes the inline `survivesElsewhere` boolean: for endpoint
 * `ep`, `survivesElsewhere === survivingProxies(all, all∖{thisEdge}).has(ep)`.
 */
export function survivingProxies(
  proxies: readonly CanvasBoundaryProxy[],
  retainedEdgeIds: ReadonlySet<string>,
): ReadonlySet<string> {
  const out = new Set<string>();
  for (const p of proxies)
    if (retainedEdgeIds.has(p.edgeId)) out.add(p.realEndpointId);
  return out;
}

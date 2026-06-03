"use client";

import "@xyflow/react/dist/style.css";

import {
  addEdge,
  Background,
  type Connection,
  ConnectionMode,
  Controls,
  MarkerType,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import { useRouter } from "next/navigation";
import { Suspense, useCallback, useMemo, useRef, useState } from "react";
import { Toaster, toast } from "sonner";

import { arrowEnds } from "~/lib/connection-direction";
import { canConnect } from "~/lib/connection-rules";
import { type Interaction, type NodeKind, type SpecKind } from "~/lib/schemas";
import {
  type CanvasBoundaryProxy,
  type CanvasData,
  type CanvasEdge,
  type CanvasNode,
  type ProjectComponent,
} from "~/lib/types";
import { api, type RouterOutputs } from "~/trpc/react";

import { AddComponent } from "./add-component";
import {
  BoundaryProxyNodeView,
  type BoundaryProxyNode,
} from "./boundary-proxy";
import { type ConnectTarget } from "./connect-to-palette";
import { CopyMarkdownToolbar } from "./copy-markdown";
import {
  ComponentDetailPanel,
  prefetchDocsEditor,
} from "./component-detail-panel";
import {
  SpecConflictModal,
  type SpecApplyDecisions,
} from "./spec-conflict-modal";
import {
  CanEditContext,
  ComponentNodeView,
  DeleteComponentContext,
  DescendComponentContext,
  RenameComponentContext,
  type ComponentNode,
} from "./component-node";
import {
  ConnectionEdgeView,
  EditEdgeContext,
  SetEdgeInteractionContext,
  type ConnectionEdge,
} from "./connection-edge";

/**
 * The Canvas island — the ONLY module that statically imports `@xyflow/react`.
 * Loaded via `next/dynamic({ ssr: false })` from `./index`, so the diagramming
 * library never runs on the server and never lands in the page's first-load
 * bundle; the stylesheet is imported locally here so it ships only with this
 * lazy chunk (ADR-0004).
 *
 * Source-of-truth model (PRD perf model): the query cache is the persistence
 * mirror — seeded server-side via prefetch → HydrateClient → `useSuspenseQuery`
 * — and React Flow's internal store is the source of truth during interaction.
 * New Components and Connections render optimistically with a `temp_…` id
 * reconciled to the real id on success; failures roll back and toast. Drag-stop,
 * inline rename, drawing/labeling/removing a Connection all persist through the
 * same model — one mutation per gesture — writing the store and the cache mirror
 * together (via `patchCanvas`, which preserves sibling keys) and rolling both
 * back with a toast on failure.
 *
 * The cross-scope read shape (`boundaryProxies`, per-edge `sourceRepr` /
 * `targetRepr`) is derived by `getCanvas` as of #63 (ADR-0031). This island
 * consumes it (#65): Connections attach to each endpoint's on-scope
 * representative (a real Component or a boundary proxy), arrowheads derive from
 * the interaction via the canonical `arrowEnds` helper (ADR-0027), and each
 * off-scope endpoint renders as a read-only boundary-proxy passive node.
 */

// Module-level: React Flow re-mounts every node/edge (and warns) if `nodeTypes`
// / `edgeTypes` is a fresh object each render. Defining them once is the key
// React Flow perf guard.
const nodeTypes = {
  component: ComponentNodeView,
  "boundary-proxy": BoundaryProxyNodeView,
};
const edgeTypes = { connection: ConnectionEdgeView };

/**
 * The discriminated union of every React Flow node the Canvas renders: the
 * interactive Component and the passive boundary proxy. Typing the `ReactFlow`
 * element and `isPassiveNode` to this union is the extension point for new passive
 * kinds — a new member forces `isPassiveNode` to acknowledge it (ADR-0016).
 */
type CanvasRFNode = ComponentNode | BoundaryProxyNode;

/**
 * The single discriminator that excludes a node from every interactive pointer
 * handler (detail panel, Descent, hover-prefetch). A passive node carries no
 * `Node` row and is inert with respect to the Canvas's interactive surfaces
 * (ADR-0016, as amended by ADR-0031 — the boundary proxy is the sole passive kind;
 * the transitive boundary-group is retired). The three handlers below call this in
 * identical shape (`if (isPassiveNode(node)) return;`), so passive extensions stay
 * out of the interactive paths without sprinkling fresh inline guards.
 */
function isPassiveNode(node: CanvasRFNode): boolean {
  return node.type === "boundary-proxy";
}

function toRFNode(n: CanvasNode): ComponentNode {
  return {
    id: n.id,
    type: "component",
    position: { x: n.posX, y: n.posY },
    // Keyboard Delete is reserved for Connections; a Component is removed only
    // through its explicit (undoable) trash control, never a stray Backspace.
    deletable: false,
    data: {
      title: n.title,
      kind: n.kind,
      optimistic: n.id.startsWith("temp_"),
    },
  };
}

// React Flow's `MarkerType.ArrowClosed`, applied to whichever end the canonical
// `arrowEnds` helper says bears an arrow. The marker mapping lives HERE (the
// island), never in `~/lib` (keeps `@xyflow/react` out of the shared helper,
// ADR-0004) and never inline in the edge component (one place owns it, ADR-0027).
const ARROW_MARKER = { type: MarkerType.ArrowClosed } as const;

// A Connection attaches to each endpoint's on-scope REPRESENTATIVE — the real
// Component when on-scope, an ancestor for the altitude view, or a boundary
// proxy's synthetic id for an off-scope end (ADR-0031) — never the raw endpoint
// id, which may not have a node on this Canvas. Arrowheads derive from the
// interaction via `arrowEnds`; draw order is honored by binding `atSource` to
// `markerStart` (the source end) and `atTarget` to `markerEnd` (ADR-0027).
//
// `remap` folds a per-edge proxy repr (`proxy_<edgeId>`) onto the COALESCED node
// that stands in for its `realEndpointId` (#90); a same-Canvas/altitude repr is a
// real node id absent from the map, so `?? repr` is an identity no-op. A proxy may
// stand in for the source OR target off-scope end, so BOTH ends pass through it.
function toRFEdge(
  e: CanvasEdge,
  remap?: ReadonlyMap<string, string>,
): ConnectionEdge {
  const ends = arrowEnds(e.interaction);
  return {
    id: e.id,
    type: "connection",
    source: remap?.get(e.sourceRepr) ?? e.sourceRepr,
    target: remap?.get(e.targetRepr) ?? e.targetRepr,
    markerStart: ends.atSource ? ARROW_MARKER : undefined,
    markerEnd: ends.atTarget ? ARROW_MARKER : undefined,
    data: {
      label: e.label,
      interaction: e.interaction,
      optimistic: e.id.startsWith("temp_"),
    },
  };
}

// Restyle an existing RF edge from an updated row, PRESERVING its `source`/`target`
// (already the coalesced rep, #90). Label/interaction edits never move endpoints, so
// rebuilding through `toRFEdge` — which re-derives the ends from the per-edge reprs —
// would detach a cross-scope edge from its shared node; this keeps it attached while
// flipping the interaction-derived arrowheads (ADR-0027) this frame.
function restyledRFEdge(
  existing: ConnectionEdge,
  next: CanvasEdge,
): ConnectionEdge {
  const ends = arrowEnds(next.interaction);
  return {
    ...existing,
    markerStart: ends.atSource ? ARROW_MARKER : undefined,
    markerEnd: ends.atTarget ? ARROW_MARKER : undefined,
    data: {
      label: next.label,
      interaction: next.interaction,
      optimistic: next.id.startsWith("temp_"),
    },
  };
}

// The left-rail seed slot for the `i`-th distinct off-scope endpoint with no
// stored placement — the fallback layout that reads a proxy as an off-scope
// stand-in rather than a free Component (ADR-0031).
const RAIL_X = -280;
function railPosition(i: number): { x: number; y: number } {
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
function railOccupants(nodes: readonly CanvasRFNode[]): number {
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
function placedProxyNodes(
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
function toProxyRFNode(
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
function coalesceProxies(proxies: readonly CanvasBoundaryProxy[]): {
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
function existingProxyNodeIdFor(
  nodes: readonly CanvasRFNode[],
  realEndpointId: string,
): string | null {
  const hit = nodes.find(
    (n) =>
      n.type === "boundary-proxy" && n.data.realEndpointId === realEndpointId,
  );
  return hit ? hit.id : null;
}

function optimisticCanvasNode(
  id: string,
  projectId: string,
  parentId: string | null,
  kind: NodeKind,
  position: { x: number; y: number },
): CanvasNode {
  const now = new Date();
  return {
    id,
    projectId,
    parentId,
    title: "Untitled",
    kind,
    posX: position.x,
    posY: position.y,
    documentation: "",
    metadata: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    deletionId: null,
    // Generated-component provenance is null for a hand-added Component (#64).
    sourceSpecId: null,
    specKey: null,
  };
}

// A freshly drawn Connection is same-Canvas — both endpoints render here, so each
// endpoint IS its own on-scope representative (`sourceRepr`/`targetRepr` === the
// endpoint ids). getCanvas derives the reprs server-side for every cross-scope
// case (ADR-0031); the optimistic + reconcile paths only ever build same-Canvas
// rows, so they set the reprs to the endpoint ids directly.
function optimisticCanvasEdge(
  id: string,
  sourceId: string,
  targetId: string,
): CanvasEdge {
  return {
    id,
    sourceId,
    targetId,
    sourceRepr: sourceId,
    targetRepr: targetId,
    // A freshly-drawn Connection is an ASSOCIATION (a plain line) until the user
    // types it (#65). The optimistic shape must match the getCanvas edge row so
    // remount reconciliation never flickers (ADR-0027).
    interaction: "ASSOCIATION",
    label: null,
  };
}

// Map the `connectNodes` result (a raw server Edge) onto the Canvas edge shape
// getCanvas returns, for the optimistic temp → real reconcile. Same-Canvas, so
// the reprs are the endpoint ids (see {@link optimisticCanvasEdge}).
function reconciledCanvasEdge(real: {
  id: string;
  sourceId: string;
  targetId: string;
  interaction: Interaction;
  label: string | null;
}): CanvasEdge {
  return {
    id: real.id,
    sourceId: real.sourceId,
    targetId: real.targetId,
    sourceRepr: real.sourceId,
    targetRepr: real.targetId,
    interaction: real.interaction,
    label: real.label,
  };
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
function repOnScope(
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
 * Picks the toast message for a failed `updateNodeDocumentation` autosave.
 * The only Zod issue the input schema raises is the byte cap (id is a bare
 * non-empty string), so a `BAD_REQUEST` with a `zodError` payload means the
 * doc exceeded `MAX_NODE_DOCUMENTATION_BYTES` — surface that distinctly so a
 * user pasting a too-large doc sees WHY each keystroke fails, instead of a
 * generic "try again" loop.
 */
function messageForDocsSaveFailure(error: unknown): string {
  if (error && typeof error === "object" && "data" in error) {
    const data = (error as { data?: { code?: string; zodError?: unknown } })
      .data;
    if (data?.code === "BAD_REQUEST" && data.zodError) {
      return "Doc is too long to save (cap is ~100 KB). Trim the text to keep autosaving.";
    }
  }
  return "Couldn't save documentation. Please try again.";
}

/**
 * Picks the toast message for a failed `updateEdgeInteraction`. A `CONFLICT`
 * means the target directional slot is already taken by another Connection
 * between the same Components (the de-dupe key includes `interaction`; ADR-0027) —
 * surface that distinctly so the user learns WHY the upgrade was refused instead
 * of a generic "try again".
 */
function messageForInteractionFailure(error: unknown): string {
  if (error && typeof error === "object" && "data" in error) {
    const data = (error as { data?: { code?: string } }).data;
    if (data?.code === "CONFLICT") {
      return "That interaction already exists between these components.";
    }
  }
  return "Couldn’t change the interaction. Please try again.";
}

/**
 * Picks the toast message for a failed `commitConnect` (the "Connect to…"
 * gesture). A `CONFLICT` means the de-dupe slot is already taken — the same
 * Connection (or its reverse ASSOCIATION) already exists. The palette pre-excludes
 * already-connected targets, so this is mostly a concurrent-write backstop; surface
 * it distinctly all the same.
 */
function messageForConnectFailure(error: unknown): string {
  if (error && typeof error === "object" && "data" in error) {
    const data = (error as { data?: { code?: string } }).data;
    if (data?.code === "CONFLICT") {
      return "That connection already exists.";
    }
  }
  return "Couldn’t add the connection. Please try again.";
}

/**
 * True when a tRPC failure is a `NOT_FOUND`. `deleteEdge` is idempotent in
 * spirit: an already-deleted Edge reads as not-found (edge.service.ts), so a
 * concurrent or multi-tab delete surfaces `NOT_FOUND` while the desired end
 * state — "deleted" — already holds. Both delete paths treat it as terminal
 * success and keep the optimistic removal rather than resurrecting a stale row.
 */
function isNotFoundError(error: unknown): boolean {
  return (
    error != null &&
    typeof error === "object" &&
    "data" in error &&
    (error as { data?: { code?: string } }).data?.code === "NOT_FOUND"
  );
}

function CanvasInner({
  scope,
  slug,
  projectId,
  canEdit,
}: {
  scope: string;
  slug: string;
  projectId: string;
  canEdit: boolean;
}) {
  const utils = api.useUtils();
  const router = useRouter();
  // The root scope is the sentinel string "root" at the island boundary
  // (ADR-0004); every other scope IS a Node id — the parentId of this Canvas's
  // Components. (An Edge no longer stores a scope; ADR-0028.)
  const canvasNodeId = scope === "root" ? null : scope;
  // Stable across renders so it stays a single query key and a stable callback dep.
  const canvasInput = useMemo(
    () => ({ slug, canvasNodeId }),
    [slug, canvasNodeId],
  );
  const [{ interiorNodes, interiorEdges, boundaryProxies, breadcrumbs }] =
    api.architecture.getCanvas.useSuspenseQuery(canvasInput);

  // The kind palette ranks its suggestions by the scope's own Component kind —
  // the parent of any Component added here (CONTEXT.md "Kind affinity"). The
  // current scope is the last breadcrumb; the root scope has none, so `null`
  // keys the root affinity.
  const parentKind = breadcrumbs.at(-1)?.kind ?? null;

  // The scope's ancestor ids — a boundary proxy whose real endpoint is one of
  // them is a lineal/ingress proxy (it stands in for an ancestor on that
  // ancestor's own interior Canvas) and must be labelled distinctly (ADR-0031).
  // Stable across renders so seeding and undo recompute the same flag.
  const breadcrumbIds = useMemo(
    () => new Set(breadcrumbs.map((b) => b.id)),
    [breadcrumbs],
  );

  // Seed React Flow's store ONCE from the hydrated query; thereafter the store
  // owns interaction state. The island is keyed by scope (./index), so a Descent
  // (a scope change) remounts and re-seeds rather than inheriting these.
  // Persistence flows through one batched/single mutation per gesture (below),
  // with the query cache kept in lockstep so a remount re-seeds it. Boundary
  // proxies seed at their STORED per-scope placement when they have one (#91 /
  // ADR-0036), else onto a vertical rail off the left edge so they read as
  // off-scope stand-ins rather than free Components; rows sharing a
  // `realEndpointId` coalesce to ONE node (#90), keyed by the endpoint, so a
  // placement re-seeds every crossing edge's shared node to the same spot, and the
  // rail counter (`placedProxyNodes`) counts only the UNPLACED distinct endpoints,
  // not crossing edges. Every crossing edge is routed to its shared node through
  // `seedRemap`.
  const { reps: seedProxyReps, remap: seedRemap } =
    coalesceProxies(boundaryProxies);
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasRFNode>([
    ...interiorNodes.map(toRFNode),
    ...placedProxyNodes(seedProxyReps, breadcrumbIds),
  ]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<ConnectionEdge>(
    interiorEdges.map((e) => toRFEdge(e, seedRemap)),
  );

  const { screenToFlowPosition, getNodes } = useReactFlow<
    CanvasRFNode,
    ConnectionEdge
  >();
  const createNode = api.architecture.createNode.useMutation();
  // Destructured so the stable `mutateAsync` can be a dep of the context values
  // below without dragging the whole (per-render) mutation object into them.
  const { mutateAsync: renameNode } = api.architecture.updateNode.useMutation();
  const { mutateAsync: changeNodeKind } =
    api.architecture.updateNodeKind.useMutation();
  const { mutateAsync: editDocumentation } =
    api.architecture.updateNodeDocumentation.useMutation();
  const updatePositions = api.architecture.updatePositions.useMutation();
  const upsertProxyPlacement =
    api.architecture.upsertBoundaryProxyPlacement.useMutation();
  const connectNodes = api.architecture.connectNodes.useMutation();
  const { mutateAsync: editEdge } = api.architecture.updateEdge.useMutation();
  const { mutateAsync: setEdgeInteraction } =
    api.architecture.updateEdgeInteraction.useMutation();
  const { mutateAsync: removeEdge } = api.architecture.deleteEdge.useMutation();
  const { mutateAsync: deleteComponent } =
    api.architecture.deleteNode.useMutation();
  const { mutateAsync: restoreComponent } =
    api.architecture.restoreNode.useMutation();
  const previewSpec = api.architecture.previewSpec.useMutation();
  const applySpec = api.architecture.applySpec.useMutation();

  // The query cache is the re-seed mirror. EVERY write goes through this merge
  // helper so a partial update can never drop a sibling key (e.g. node edits
  // silently erasing `interiorEdges`) — the regression `getCanvas` growing a
  // second key would otherwise invite. It spreads the prior value, so callers
  // return only the slice they changed.
  const patchCanvas = useCallback(
    (patch: (prev: CanvasData) => Partial<CanvasData>) => {
      utils.architecture.getCanvas.setData(canvasInput, (old) => {
        // The zero-value defaults are load-bearing — a partial update on a cold
        // cache would otherwise patch against a base that lacks a key and drop
        // it. Keep EVERY getCanvas key here.
        const base: CanvasData = old ?? {
          interiorNodes: [],
          interiorEdges: [],
          boundaryProxies: [],
          breadcrumbs: [],
        };
        return { ...base, ...patch(base) };
      });
    },
    [utils, canvasInput],
  );

  const addComponent = useCallback(
    async (kind: NodeKind) => {
      // A client-minted temporary id, reconciled to the server id on success.
      // The `temp_` prefix is also the convention `onConnect` uses to refuse a
      // Connection to a still-optimistic endpoint.
      const tempId = `temp_${crypto.randomUUID()}`;
      const position = screenToFlowPosition({
        x: window.innerWidth / 2,
        y: window.innerHeight / 2,
      });

      // Optimistic: show the Component this frame — in the RF store (pixels) and
      // the query cache (the re-seed mirror), so both stay consistent.
      setNodes((ns) => [
        ...ns,
        {
          id: tempId,
          type: "component",
          position,
          deletable: false,
          data: { title: "Untitled", kind, optimistic: true },
        },
      ]);
      patchCanvas((c) => ({
        interiorNodes: [
          ...c.interiorNodes,
          optimisticCanvasNode(tempId, projectId, canvasNodeId, kind, position),
        ],
      }));

      try {
        const real = await createNode.mutateAsync({
          projectId,
          parentId: canvasNodeId,
          kind,
          posX: position.x,
          posY: position.y,
        });
        // Reconcile temp → real id in both stores, atomically by id.
        setNodes((ns) => ns.map((n) => (n.id === tempId ? toRFNode(real) : n)));
        patchCanvas((c) => ({
          interiorNodes: c.interiorNodes.map((n) =>
            n.id === tempId ? real : n,
          ),
        }));
      } catch {
        // Roll back both stores and tell the user (PRD: "rolls back with a toast").
        setNodes((ns) => ns.filter((n) => n.id !== tempId));
        patchCanvas((c) => ({
          interiorNodes: c.interiorNodes.filter((n) => n.id !== tempId),
        }));
        toast.error("Couldn’t add the component. Please try again.");
      }
    },
    [
      screenToFlowPosition,
      projectId,
      canvasNodeId,
      setNodes,
      patchCanvas,
      createNode,
    ],
  );

  // Persist a renamed Component: optimistic title in the store + cache mirror,
  // one updateNode mutation, both rolled back with a toast on failure. Provided
  // to the nodes through context (below) so it stays one stable reference — the
  // nodes never re-render just because the island re-rendered mid-drag.
  //
  // Rollback is CONDITIONAL on the cache still showing what this rename wrote:
  // a fast-typing rename A→B can overlap a failing A→B′, and an unconditional
  // rollback to the pre-A snapshot would clobber B's successful optimistic
  // patch. Same fix lives in `commitDocumentation` for the autosave path.
  const commitRename = useCallback(
    (id: string, title: string): void => {
      const prevTitle = utils.architecture.getCanvas
        .getData(canvasInput)
        ?.interiorNodes.find((n) => n.id === id)?.title;

      setNodes((ns) =>
        ns.map((n) =>
          n.id === id && n.type === "component"
            ? { ...n, data: { ...n.data, title } }
            : n,
        ),
      );
      patchCanvas((c) => ({
        interiorNodes: c.interiorNodes.map((n) =>
          n.id === id ? { ...n, title } : n,
        ),
      }));

      void renameNode({ id, title }).catch(() => {
        const currentTitle = utils.architecture.getCanvas
          .getData(canvasInput)
          ?.interiorNodes.find((n) => n.id === id)?.title;
        // Only restore if the cache still shows what THIS rename optimistically
        // wrote — a newer rename's optimistic patch must not be undone.
        if (currentTitle === title && prevTitle !== undefined) {
          setNodes((ns) =>
            ns.map((n) =>
              n.id === id && n.type === "component"
                ? { ...n, data: { ...n.data, title: prevTitle } }
                : n,
            ),
          );
          patchCanvas((c) => ({
            interiorNodes: c.interiorNodes.map((n) =>
              n.id === id ? { ...n, title: prevTitle } : n,
            ),
          }));
        }
        toast.error("Couldn’t rename the component. Please try again.");
      });
    },
    [setNodes, utils, canvasInput, patchCanvas, renameNode],
  );

  // Change a Component's kind: optimistic icon swap in the store + cache mirror,
  // one updateNodeKind mutation, both rolled back with a toast on failure. Same
  // conditional-rollback shape as `commitRename` (a newer change's optimistic
  // patch must not be clobbered by an older failing change's rollback). Kind is
  // cosmetic, so no edge state is touched (ADR-0018).
  const commitNodeKind = useCallback(
    (id: string, kind: NodeKind): void => {
      const prevKind = utils.architecture.getCanvas
        .getData(canvasInput)
        ?.interiorNodes.find((n) => n.id === id)?.kind;

      setNodes((ns) =>
        ns.map((n) =>
          n.id === id && n.type === "component"
            ? { ...n, data: { ...n.data, kind } }
            : n,
        ),
      );
      patchCanvas((c) => ({
        interiorNodes: c.interiorNodes.map((n) =>
          n.id === id ? { ...n, kind } : n,
        ),
      }));

      void changeNodeKind({ id, kind }).catch(() => {
        const currentKind = utils.architecture.getCanvas
          .getData(canvasInput)
          ?.interiorNodes.find((n) => n.id === id)?.kind;
        if (currentKind === kind && prevKind !== undefined) {
          setNodes((ns) =>
            ns.map((n) =>
              n.id === id && n.type === "component"
                ? { ...n, data: { ...n.data, kind: prevKind } }
                : n,
            ),
          );
          patchCanvas((c) => ({
            interiorNodes: c.interiorNodes.map((n) =>
              n.id === id ? { ...n, kind: prevKind } : n,
            ),
          }));
        }
        toast.error("Couldn’t change the kind. Please try again.");
      });
    },
    [setNodes, utils, canvasInput, patchCanvas, changeNodeKind],
  );

  // Per-ownerNodeId chain of in-flight docs saves. Two debounced saves crossing
  // a network hop must land on the server in the order the user typed them —
  // an older payload landing after a newer one would persist stale text while
  // the cache shows the latest, surfacing as data loss on next page refresh.
  // The map's slot is cleared in the chain's `finally` only when this save is
  // still the head, so concurrent writers don't race on the delete.
  const inflightDocSavesRef = useRef(new Map<string, Promise<void>>());

  // Persist a Component's documentation on the debounced autosave from the
  // detail panel. Optimistic on the query-cache mirror only — `documentation`
  // is not drawn on the node body, so the React Flow store needs no patch; the
  // mirror keeps a deselect-then-reselect showing the latest text without a
  // refetch. Fire-and-forget with a CONDITIONAL snapshot rollback + toast on
  // failure: a newer successful save's optimistic patch must not be undone by
  // an older failing save's rollback (the same fix `commitRename` carries).
  // Saves are SERIALIZED per id so the server's row never lands on a stale
  // payload (see `inflightDocSavesRef`).
  const commitDocumentation = useCallback(
    (id: string, documentation: string): void => {
      const prevDoc = utils.architecture.getCanvas
        .getData(canvasInput)
        ?.interiorNodes.find((n) => n.id === id)?.documentation;

      patchCanvas((c) => ({
        interiorNodes: c.interiorNodes.map((n) =>
          n.id === id ? { ...n, documentation } : n,
        ),
      }));

      const prior = inflightDocSavesRef.current.get(id) ?? Promise.resolve();
      // `prior.catch(() => undefined)` so a prior failure doesn't poison the
      // chain — each save's failure handling is local to its own .catch below.
      const next: Promise<void> = prior
        .catch(() => undefined)
        .then(() => editDocumentation({ id, documentation }))
        .then(() => undefined)
        .catch((error: unknown) => {
          const currentDoc = utils.architecture.getCanvas
            .getData(canvasInput)
            ?.interiorNodes.find((n) => n.id === id)?.documentation;
          if (currentDoc === documentation && prevDoc !== undefined) {
            patchCanvas((c) => ({
              interiorNodes: c.interiorNodes.map((n) =>
                n.id === id ? { ...n, documentation: prevDoc } : n,
              ),
            }));
          }
          toast.error(messageForDocsSaveFailure(error));
        })
        .finally(() => {
          // Only release the slot if this save is still the chain head; a
          // newer save will have replaced it and is responsible for clearing.
          if (inflightDocSavesRef.current.get(id) === next) {
            inflightDocSavesRef.current.delete(id);
          }
        });
      inflightDocSavesRef.current.set(id, next);
    },
    [utils, canvasInput, patchCanvas, editDocumentation],
  );

  // Persist Component positions on drag-stop in ONE batched mutation, so a
  // multi-select drag (onSelectionDragStop also routes here) commits together.
  // Rolls back store + cache and toasts on failure.
  const persistPositions = useCallback(
    async (moved: CanvasRFNode[]) => {
      const cached = utils.architecture.getCanvas.getData(canvasInput);
      const byId = new Map(
        cached?.interiorNodes.map((n) => [n.id, n] as const) ?? [],
      );

      const changed: {
        id: string;
        prev: CanvasNode;
        posX: number;
        posY: number;
      }[] = [];
      for (const n of moved) {
        if (n.id.startsWith("temp_")) continue;
        const prev = byId.get(n.id);
        if (!prev) continue;
        if (prev.posX === n.position.x && prev.posY === n.position.y) continue;
        changed.push({
          id: n.id,
          prev,
          posX: n.position.x,
          posY: n.position.y,
        });
      }
      if (changed.length === 0) return;

      const positions = changed.map(({ id, posX, posY }) => ({
        id,
        posX,
        posY,
      }));

      // The RF store already shows the final position; mirror it into the cache.
      patchCanvas((c) => ({
        interiorNodes: c.interiorNodes.map((n) => {
          const x = changed.find((ch) => ch.id === n.id);
          return x ? { ...n, posX: x.posX, posY: x.posY } : n;
        }),
      }));

      try {
        await updatePositions.mutateAsync({ projectId, positions });
      } catch {
        setNodes((ns) =>
          ns.map((n) => {
            const x = changed.find((ch) => ch.id === n.id);
            return x
              ? { ...n, position: { x: x.prev.posX, y: x.prev.posY } }
              : n;
          }),
        );
        patchCanvas((c) => ({
          interiorNodes: c.interiorNodes.map((n) => {
            const x = changed.find((ch) => ch.id === n.id);
            return x ? { ...n, posX: x.prev.posX, posY: x.prev.posY } : n;
          }),
        }));
        toast.error("Couldn’t save the new position. Please try again.");
      }
    },
    [utils, canvasInput, projectId, updatePositions, setNodes, patchCanvas],
  );

  // Persist a boundary proxy's placement on this scope when its drag stops (#91 /
  // ADR-0036). Unlike `persistPositions`, this writes ONE placement, never a batch:
  // a proxy is `selectable:false`, so it can never be part of a multi-select drag.
  // The drag/seed/persist key is `realEndpointId` (stable, coalesced #90), NEVER the
  // representative node id (`proxy_<edgeId>`); a placement persists per off-scope
  // endpoint, so the cache mirror patches EVERY per-edge `boundaryProxies` row
  // sharing that endpoint (faithful to getCanvas, which joins the same coordinate
  // onto all of them). The RF store already shows the dropped position; mirror it,
  // call the owner-only upsert, and roll BOTH store and mirror back + toast on
  // failure. A `temp_` endpoint has no server id to key on, so it is skipped.
  const persistProxyPlacement = useCallback(
    async (proxyNode: CanvasRFNode) => {
      if (proxyNode.type !== "boundary-proxy") return;
      const realEndpointId = proxyNode.data.realEndpointId;
      if (realEndpointId.startsWith("temp_")) return;

      const cached = utils.architecture.getCanvas.getData(canvasInput);
      const prev = cached?.boundaryProxies.find(
        (p) => p.realEndpointId === realEndpointId,
      );
      const prevPosX = prev?.posX ?? null;
      const prevPosY = prev?.posY ?? null;

      const posX = proxyNode.position.x;
      const posY = proxyNode.position.y;
      if (prevPosX === posX && prevPosY === posY) return;

      // Mirror the new coordinate onto EVERY per-edge row for this endpoint so a
      // remount re-seeds the coalesced node to the dropped spot (#90/#91).
      patchCanvas((c) => ({
        boundaryProxies: c.boundaryProxies.map((p) =>
          p.realEndpointId === realEndpointId ? { ...p, posX, posY } : p,
        ),
      }));

      try {
        await upsertProxyPlacement.mutateAsync({
          projectId,
          containerNodeId: canvasNodeId,
          realEndpointId,
          posX,
          posY,
        });
      } catch {
        // Snap the dragged node back and restore the mirror's prior coordinate on
        // every row for this endpoint. A proxy that had a prior placement returns
        // to it; one that had none (was on the rail) returns to the next rail slot
        // among the OTHER proxies, the same fallback the seed would pick.
        setNodes((ns) =>
          ns.map((n) =>
            n.id === proxyNode.id
              ? {
                  ...n,
                  position:
                    prevPosX !== null && prevPosY !== null
                      ? { x: prevPosX, y: prevPosY }
                      : railPosition(
                          railOccupants(ns.filter((o) => o.id !== n.id)),
                        ),
                }
              : n,
          ),
        );
        patchCanvas((c) => ({
          boundaryProxies: c.boundaryProxies.map((p) =>
            p.realEndpointId === realEndpointId
              ? { ...p, posX: prevPosX, posY: prevPosY }
              : p,
          ),
        }));
        toast.error("Couldn’t save the position. Please try again.");
      }
    },
    [
      utils,
      canvasInput,
      projectId,
      canvasNodeId,
      upsertProxyPlacement,
      setNodes,
      patchCanvas,
    ],
  );

  // Draw a Connection. Refuses a still-optimistic (temp_) endpoint (no real id
  // to persist yet), then pre-flights the pure topology rules — no self-link, no
  // duplicate — via `canConnect`, so the user gets instant feedback rather than a
  // doomed round trip (the service stays authoritative). Optimistic edge in store
  // + cache mirror, one connectNodes mutation, reconcile temp → real id, roll
  // back + toast on failure. A freshly drawn Connection is an ASSOCIATION (#65
  // adds the interaction picker).
  const handleConnect = useCallback(
    async (connection: Connection) => {
      const { source, target } = connection;
      if (!source || !target) return;

      if (source.startsWith("temp_") || target.startsWith("temp_")) {
        toast.error("Finish adding that component before connecting it.");
        return;
      }
      const existing =
        utils.architecture.getCanvas.getData(canvasInput)?.interiorEdges ?? [];
      const check = canConnect(
        { source, target },
        existing.map((e) => ({ source: e.sourceId, target: e.targetId })),
      );
      if (!check.ok) {
        toast.error(
          check.reason === "self-link"
            ? "A component can’t connect to itself."
            : "That connection already exists.",
        );
        return;
      }

      const tempId = `temp_${crypto.randomUUID()}`;
      // Build the optimistic RF edge through `toRFEdge` so its markers + data
      // (interaction ASSOCIATION → no arrows) match the reconciled shape exactly,
      // and a same-Canvas draw's reprs equal its endpoint ids (ADR-0031).
      setEdges((es) =>
        addEdge(toRFEdge(optimisticCanvasEdge(tempId, source, target)), es),
      );
      patchCanvas((c) => ({
        interiorEdges: [
          ...c.interiorEdges,
          optimisticCanvasEdge(tempId, source, target),
        ],
      }));

      try {
        const real = reconciledCanvasEdge(
          await connectNodes.mutateAsync({
            projectId,
            sourceId: source,
            targetId: target,
          }),
        );
        setEdges((es) => es.map((e) => (e.id === tempId ? toRFEdge(real) : e)));
        patchCanvas((c) => ({
          interiorEdges: c.interiorEdges.map((e) =>
            e.id === tempId ? real : e,
          ),
        }));
      } catch {
        setEdges((es) => es.filter((e) => e.id !== tempId));
        patchCanvas((c) => ({
          interiorEdges: c.interiorEdges.filter((e) => e.id !== tempId),
        }));
        toast.error("Couldn’t add the connection. Please try again.");
      }
    },
    [utils, canvasInput, setEdges, patchCanvas, projectId, connectNodes],
  );

  // The "Connect to…" gesture (#66): wire the selected Component to ANY other
  // Component the project-wide search returns — same-Canvas, cross-scope, or
  // lineal. Generalizes `handleConnect`'s optimistic pattern to the off-scope
  // case, inserting the far-end boundary proxy row this frame (the new edge
  // coalesces onto an existing far node if one is already on the rail — no
  // duplicate, #90), then reconciling temp → real ids on success (the RF store is
  // seeded once and is NOT re-seeded by a query refetch, so the reconcile is
  // manual, exactly like `handleConnect`).
  //
  // Where the connection renders on THIS scope follows the SAME `rep(N, S)`
  // partition `getCanvas` derives server-side (ADR-0031), computed client-side
  // from the flat `parentId` map the palette already loaded
  // (`listProjectComponents`) — no extra fetch, no shipping ancestry we don't
  // have. The selected Component is interior to this scope, so it is its own
  // representative; only the target's rep must be resolved:
  //   - target rep absent  → off-scope: render real-source → far-end proxy.
  //   - target rep is self  → lineal to our own descendant: it COLLAPSES on this
  //     scope (getCanvas would not draw it), so we add it only to the Connections
  //     list, never the Canvas.
  //   - else (a real on-scope node, possibly an ancestor for the altitude view)
  //     → a plain interior edge to that representative, no proxy.
  const commitConnect = useCallback(
    async (sourceNodeId: string, target: ConnectTarget) => {
      // Pre-check against the source's Connection list (self-link + duplicate),
      // mirroring `handleConnect`'s drag-time guard so the user gets instant
      // feedback instead of a server round trip + toast.
      const existing =
        utils.architecture.listNodeConnections
          .getData({ slug, nodeId: sourceNodeId })
          ?.map((c) => ({ source: sourceNodeId, target: c.other.id })) ?? [];
      const check = canConnect(
        { source: sourceNodeId, target: target.id },
        existing,
      );
      if (!check.ok) {
        toast.error(
          check.reason === "self-link"
            ? "A component can’t connect to itself."
            : "That connection already exists.",
        );
        return;
      }

      // Resolve the target's on-scope representative from the project-wide map the
      // palette loaded — the same `rep(N, S)` getCanvas derives (ADR-0031).
      const components =
        utils.architecture.listProjectComponents.getData({ slug }) ?? [];
      const byId = new Map(components.map((c) => [c.id, c] as const));
      const targetRep = repOnScope(target.id, canvasNodeId, byId);
      const collapses = targetRep === sourceNodeId;
      const offScope = targetRep === null;

      const tempId = `temp_${crypto.randomUUID()}`;
      const proxyNodeId = `proxy_${tempId}`;

      // If this scope already draws a boundary proxy for the off-scope target, the
      // new crossing edge routes to that EXISTING coalesced node instead of
      // spawning a duplicate (#90). The edge still gains its own per-edge proxy row
      // below (faithful to getCanvas) — only the VIEW coalesces.
      const existingRepNodeId = offScope
        ? existingProxyNodeIdFor(getNodes(), target.id)
        : null;

      // The optimistic Connection-list row (the panel updates this frame). The
      // selected Component is the source, so `sourceIsSelf` is true.
      const optimisticListRow = {
        id: tempId,
        interaction: "ASSOCIATION" as const,
        label: null,
        sourceIsSelf: true,
        other: { id: target.id, title: target.title, kind: target.kind },
      };
      utils.architecture.listNodeConnections.setData(
        { slug, nodeId: sourceNodeId },
        (old) => [...(old ?? []), optimisticListRow],
      );

      // A lineal Connection to our own descendant collapses on this scope — it is
      // real and listed, but getCanvas draws nothing here, so neither do we.
      const optimisticEdge: CanvasEdge | null = collapses
        ? null
        : {
            id: tempId,
            sourceId: sourceNodeId,
            targetId: target.id,
            sourceRepr: sourceNodeId,
            targetRepr: offScope ? proxyNodeId : targetRep,
            interaction: "ASSOCIATION",
            label: null,
          };
      const optimisticProxy: CanvasBoundaryProxy | null =
        optimisticEdge && offScope
          ? {
              nodeId: proxyNodeId,
              title: target.title,
              kind: target.kind,
              realEndpointId: target.id,
              edgeId: tempId,
              // A freshly drawn crossing Connection has no stored placement yet —
              // its proxy seeds onto the left rail (#91). If the endpoint already
              // had a placement on this scope, an existing rep node already carries
              // it and this edge folds onto it (existingRepNodeId), so a null here
              // never overrides a placed node.
              posX: null,
              posY: null,
            }
          : null;

      // View remap for this gesture: fold this edge's own per-edge proxy onto the
      // existing coalesced node when one already stands in for the target (#90);
      // identity otherwise (this edge becomes the group's representative).
      const viewRemap = new Map<string, string>();
      if (offScope)
        viewRemap.set(proxyNodeId, existingRepNodeId ?? proxyNodeId);

      if (optimisticEdge) {
        setEdges((es) => addEdge(toRFEdge(optimisticEdge, viewRemap), es));
        patchCanvas((c) => ({
          interiorEdges: [...c.interiorEdges, optimisticEdge],
        }));
      }
      if (optimisticProxy) {
        // Cache mirror: the per-edge proxy row, ALWAYS (faithful to getCanvas,
        // ADR-0031). RF node: only when no coalesced node yet stands in for this
        // endpoint — otherwise the edge above already routed to the existing one,
        // so adding a node would be the transient duplicate #90 forbids.
        patchCanvas((c) => ({
          boundaryProxies: [...c.boundaryProxies, optimisticProxy],
        }));
        if (existingRepNodeId === null) {
          // Seed the far-end stand-in at its stored placement when one exists for
          // this endpoint on this scope (#91), else onto the left rail below any
          // already there — the same placement the delete-undo path uses (ADR-0031).
          setNodes((ns) => [
            ...ns,
            ...placedProxyNodes(
              [optimisticProxy],
              breadcrumbIds,
              railOccupants(ns),
            ),
          ]);
        }
      }

      try {
        const real = await connectNodes.mutateAsync({
          projectId,
          sourceId: sourceNodeId,
          targetId: target.id,
        });

        // Reconcile temp → real ids in the RF store AND the cache mirror (the
        // store is not re-seeded by a refetch). The real proxy id is
        // `proxy_<realEdgeId>`, matching what getCanvas emits, so a later remount
        // reconciles without a flicker.
        const realProxyNodeId = `proxy_${real.id}`;
        const reconciledEdge: CanvasEdge | null = optimisticEdge
          ? {
              ...optimisticEdge,
              id: real.id,
              targetRepr: offScope
                ? realProxyNodeId
                : optimisticEdge.targetRepr,
            }
          : null;
        const reconciledProxy: CanvasBoundaryProxy | null = optimisticProxy
          ? { ...optimisticProxy, nodeId: realProxyNodeId, edgeId: real.id }
          : null;

        // Keep the edge on its coalesced node across reconcile (#90): if this edge
        // owns the rep, the rep's id moves temp → real with it (identity remap);
        // if it joined an existing rep, route the reconciled own-proxy id back onto
        // that rep so the edge stays attached.
        const reconcileRemap = new Map<string, string>();
        if (offScope) {
          reconcileRemap.set(
            realProxyNodeId,
            existingRepNodeId ?? realProxyNodeId,
          );
        }

        if (reconciledEdge) {
          setEdges((es) =>
            es.map((e) =>
              e.id === tempId ? toRFEdge(reconciledEdge, reconcileRemap) : e,
            ),
          );
          patchCanvas((c) => ({
            interiorEdges: c.interiorEdges.map((e) =>
              e.id === tempId ? reconciledEdge : e,
            ),
          }));
        }
        if (reconciledProxy) {
          // Cache mirror reconciles the per-edge row always; the RF rep node is
          // renamed temp → real only when THIS edge owns it (no pre-existing rep).
          patchCanvas((c) => ({
            boundaryProxies: c.boundaryProxies.map((p) =>
              p.nodeId === proxyNodeId ? reconciledProxy : p,
            ),
          }));
          if (existingRepNodeId === null) {
            setNodes((ns) =>
              ns.map((n) =>
                n.id === proxyNodeId
                  ? toProxyRFNode(reconciledProxy, breadcrumbIds, n.position)
                  : n,
              ),
            );
          }
        }
        utils.architecture.listNodeConnections.setData(
          { slug, nodeId: sourceNodeId },
          (old) =>
            (old ?? []).map((c) =>
              c.id === tempId ? { ...c, id: real.id } : c,
            ),
        );

        // Belt-and-suspenders against a target reparented (e.g. via the MCP
        // `move_component` tool) between the palette load and this success: the
        // RF store keeps its already-correct reconciled state, but a background
        // refetch of `getCanvas` (and the project-wide map the next palette open
        // reads) ensures the next remount re-seeds from authoritative ancestry.
        // In the common (no-reparent) case the refetch is a no-op; in the edge
        // case it self-heals without a flicker (ADR-0032).
        void utils.architecture.getCanvas.invalidate(canvasInput);
        void utils.architecture.listProjectComponents.invalidate({ slug });
      } catch (error) {
        // Roll the optimistic edge, proxy, and list row back out of every store.
        if (optimisticEdge) {
          setEdges((es) => es.filter((e) => e.id !== tempId));
          patchCanvas((c) => ({
            interiorEdges: c.interiorEdges.filter((e) => e.id !== tempId),
          }));
        }
        if (optimisticProxy) {
          // Mirror: drop the per-edge row always. RF node: remove it only if THIS
          // edge added it (a joined edge shares another edge's rep node — leave it).
          patchCanvas((c) => ({
            boundaryProxies: c.boundaryProxies.filter(
              (p) => p.nodeId !== proxyNodeId,
            ),
          }));
          if (existingRepNodeId === null) {
            setNodes((ns) => ns.filter((n) => n.id !== proxyNodeId));
          }
        }
        utils.architecture.listNodeConnections.setData(
          { slug, nodeId: sourceNodeId },
          (old) => (old ?? []).filter((c) => c.id !== tempId),
        );
        toast.error(messageForConnectFailure(error));
      }
    },
    [
      utils,
      slug,
      canvasInput,
      canvasNodeId,
      breadcrumbIds,
      getNodes,
      setEdges,
      setNodes,
      patchCanvas,
      projectId,
      connectNodes,
    ],
  );

  // Remove a Connection (React Flow's Delete/Backspace). `onEdgesChange`
  // already dropped it from the store; here we mirror the removal into the
  // cache and soft-delete it server-side (a plain lone soft-delete — ADR-0030).
  // A still-optimistic edge was never persisted, so it just disappears. Failure
  // re-adds the edge to both stores and toasts.
  const handleEdgesDelete = useCallback(
    (deleted: ConnectionEdge[]) => {
      const cached = utils.architecture.getCanvas.getData(canvasInput);
      for (const edge of deleted) {
        if (edge.id.startsWith("temp_")) continue;
        const prev = cached?.interiorEdges.find((e) => e.id === edge.id);
        patchCanvas((c) => ({
          interiorEdges: c.interiorEdges.filter((e) => e.id !== edge.id),
        }));
        void removeEdge({ id: edge.id }).catch((error: unknown) => {
          // A NOT_FOUND means the Edge was already deleted (concurrent/multi-tab)
          // — the removal already holds, so leave it dropped instead of re-adding.
          if (isNotFoundError(error)) return;
          setEdges((es) =>
            es.some((e) => e.id === edge.id) ? es : [...es, edge],
          );
          if (prev) {
            patchCanvas((c) => ({
              interiorEdges: [...c.interiorEdges, prev],
            }));
          }
          toast.error("Couldn’t remove the connection. Please try again.");
        });
      }
    },
    [utils, canvasInput, patchCanvas, setEdges, removeEdge],
  );

  // Remove a Connection from the Component-detail panel's row trash control.
  // Unlike `handleEdgesDelete` (React Flow already dropped the edge from its
  // store), here nothing has touched any store yet, so we drive the full
  // optimistic removal: the owner's Connection-list row updates this frame, and
  // if the Connection is drawn at THIS scope we also pull its edge and any
  // per-edge boundary proxy (ADR-0031) out of the RF store + cache mirror. A
  // cross-scope Connection not drawn here simply has no local edge to pull. The
  // soft-delete is the same lone delete the keyboard path uses (ADR-0030);
  // failure rolls every store back and toasts.
  const commitDeleteConnection = useCallback(
    async (ownerNodeId: string, connectionId: string) => {
      const cached = utils.architecture.getCanvas.getData(canvasInput);
      const prevRow = utils.architecture.listNodeConnections
        .getData({ slug, nodeId: ownerNodeId })
        ?.find((c) => c.id === connectionId);
      const prevEdge = cached?.interiorEdges.find((e) => e.id === connectionId);
      const prevProxy = cached?.boundaryProxies.find(
        (p) => p.edgeId === connectionId,
      );

      utils.architecture.listNodeConnections.setData(
        { slug, nodeId: ownerNodeId },
        (old) => (old ?? []).filter((c) => c.id !== connectionId),
      );
      if (prevEdge) {
        setEdges((es) => es.filter((e) => e.id !== connectionId));
        patchCanvas((c) => ({
          interiorEdges: c.interiorEdges.filter((e) => e.id !== connectionId),
        }));
      }
      if (prevProxy) {
        // Mirror: drop this edge's per-edge row always. RF node: remove the
        // coalesced stand-in only if NO other crossing edge still reaches the same
        // off-scope Component (#90) — else surviving edges would orphan.
        const survivesElsewhere = (cached?.boundaryProxies ?? []).some(
          (p) =>
            p.edgeId !== connectionId &&
            p.realEndpointId === prevProxy.realEndpointId,
        );
        patchCanvas((c) => ({
          boundaryProxies: c.boundaryProxies.filter(
            (p) => p.edgeId !== connectionId,
          ),
        }));
        if (!survivesElsewhere) {
          const repNodeId = existingProxyNodeIdFor(
            getNodes(),
            prevProxy.realEndpointId,
          );
          if (repNodeId) {
            setNodes((ns) => ns.filter((n) => n.id !== repNodeId));
          }
        }
      }

      try {
        await removeEdge({ id: connectionId });
        void utils.architecture.getCanvas.invalidate(canvasInput);
        void utils.architecture.listProjectComponents.invalidate({ slug });
      } catch (error: unknown) {
        // A NOT_FOUND means the Connection was already deleted (a concurrent or
        // multi-tab delete) — the desired "deleted" state already holds, so keep
        // the optimistic removal rather than resurrecting a stale row/edge/proxy.
        if (isNotFoundError(error)) return;
        if (prevRow) {
          utils.architecture.listNodeConnections.setData(
            { slug, nodeId: ownerNodeId },
            (old) =>
              (old ?? []).some((c) => c.id === connectionId)
                ? (old ?? [])
                : [...(old ?? []), prevRow],
          );
        }
        // Restore the proxy BEFORE the edge so the edge can route to the coalesced
        // node it must re-attach to (#90). Mirror row re-adds always (if absent);
        // the RF node re-adds only when no node yet stands in for this endpoint —
        // otherwise the restored edge folds onto the existing coalesced node.
        let repForEdge: string | null = null;
        if (prevProxy) {
          patchCanvas((c) => ({
            boundaryProxies: c.boundaryProxies.some(
              (p) => p.edgeId === connectionId,
            )
              ? c.boundaryProxies
              : [...c.boundaryProxies, prevProxy],
          }));
          const existing = existingProxyNodeIdFor(
            getNodes(),
            prevProxy.realEndpointId,
          );
          if (existing) {
            repForEdge = existing;
          } else {
            repForEdge = prevProxy.nodeId;
            setNodes((ns) => {
              if (ns.some((n) => n.id === prevProxy.nodeId)) return ns;
              // Re-seed at the proxy's stored placement when it had one (#91), else
              // onto the left rail below any already there.
              return [
                ...ns,
                ...placedProxyNodes(
                  [prevProxy],
                  breadcrumbIds,
                  railOccupants(ns),
                ),
              ];
            });
          }
        }
        if (prevEdge) {
          // Fold this edge's per-edge proxy repr onto the coalesced node; a
          // same-Canvas edge has no proxy end, so the map is then never consulted.
          const remap =
            prevProxy && repForEdge
              ? new Map([[prevProxy.nodeId, repForEdge]])
              : undefined;
          setEdges((es) =>
            es.some((e) => e.id === connectionId)
              ? es
              : addEdge(toRFEdge(prevEdge, remap), es),
          );
          patchCanvas((c) => ({
            interiorEdges: c.interiorEdges.some((e) => e.id === connectionId)
              ? c.interiorEdges
              : [...c.interiorEdges, prevEdge],
          }));
        }
        toast.error("Couldn’t remove the connection. Please try again.");
      }
    },
    [
      utils,
      slug,
      canvasInput,
      getNodes,
      setEdges,
      setNodes,
      patchCanvas,
      removeEdge,
      breadcrumbIds,
    ],
  );

  // Re-add incident cross-scope edges + their per-edge boundary proxies to the RF
  // store AND the cache mirror, coalesced per #90: per off-scope endpoint, reuse
  // the rep node a surviving edge already keeps (resolved against the LIVE nodes,
  // never the mirror), else add ONE node for the group; every re-added edge folds
  // onto that rep. The mirror always re-gains every per-edge row (faithful to
  // getCanvas). Returns the rep node ids THIS call added, so a later rollback
  // removes only those — never a reused survivor node other live edges still need.
  const readdCrossScope = useCallback(
    (
      incidentEdges: CanvasEdge[],
      incidentProxies: CanvasBoundaryProxy[],
    ): ReadonlySet<string> => {
      const liveNodes = getNodes();
      const repByEndpoint = new Map<string, string>();
      const proxiesToAdd: CanvasBoundaryProxy[] = [];
      for (const p of incidentProxies) {
        if (repByEndpoint.has(p.realEndpointId)) continue;
        const existing = existingProxyNodeIdFor(liveNodes, p.realEndpointId);
        if (existing) {
          repByEndpoint.set(p.realEndpointId, existing);
        } else {
          repByEndpoint.set(p.realEndpointId, p.nodeId);
          proxiesToAdd.push(p);
        }
      }
      const remap = new Map(
        incidentProxies.map(
          (p) => [p.nodeId, repByEndpoint.get(p.realEndpointId)!] as const,
        ),
      );

      setNodes((ns) => {
        const present = new Set(ns.map((n) => n.id));
        const add = proxiesToAdd.filter((p) => !present.has(p.nodeId));
        // Re-seed each at its stored placement when it had one (#91), else append
        // below any proxies still on the rail so it never lands on an existing one.
        return add.length
          ? [...ns, ...placedProxyNodes(add, breadcrumbIds, railOccupants(ns))]
          : ns;
      });
      setEdges((es) => {
        const present = new Set(es.map((e) => e.id));
        const add = incidentEdges.filter((e) => !present.has(e.id));
        return add.length ? [...es, ...add.map((e) => toRFEdge(e, remap))] : es;
      });
      patchCanvas((c) => {
        const presentEdges = new Set(c.interiorEdges.map((e) => e.id));
        const addEdges = incidentEdges.filter((e) => !presentEdges.has(e.id));
        const presentProxies = new Set(c.boundaryProxies.map((p) => p.nodeId));
        const addProxies = incidentProxies.filter(
          (p) => !presentProxies.has(p.nodeId),
        );
        return {
          ...(addEdges.length
            ? { interiorEdges: [...c.interiorEdges, ...addEdges] }
            : {}),
          ...(addProxies.length
            ? { boundaryProxies: [...c.boundaryProxies, ...addProxies] }
            : {}),
        };
      });

      return new Set(proxiesToAdd.map((p) => p.nodeId));
    },
    [getNodes, setNodes, setEdges, patchCanvas, breadcrumbIds],
  );

  // Undo a Component delete: optimistically re-add the on-canvas rows the delete
  // removed (the off-canvas subtree + interior Connections are restored
  // server-side and reappear on descent), then restore the whole batch by its
  // deletionId. A failed restore re-removes the rows and toasts. Defined before
  // `removeComponent` because that callback references it.
  const undoRemoveComponent = useCallback(
    (
      deletionId: string,
      node: CanvasNode | undefined,
      incidentEdges: CanvasEdge[],
      incidentProxies: CanvasBoundaryProxy[],
    ): void => {
      if (node) {
        setNodes((ns) =>
          ns.some((n) => n.id === node.id) ? ns : [...ns, toRFNode(node)],
        );
        patchCanvas((c) => ({
          interiorNodes: c.interiorNodes.some((n) => n.id === node.id)
            ? c.interiorNodes
            : [...c.interiorNodes, node],
        }));
      }
      const addedProxyIds = readdCrossScope(incidentEdges, incidentProxies);

      void restoreComponent({ deletionId })
        .then(() => void utils.architecture.getCanvas.invalidate())
        .catch(() => {
          if (node) {
            setNodes((ns) => ns.filter((n) => n.id !== node.id));
            patchCanvas((c) => ({
              interiorNodes: c.interiorNodes.filter((n) => n.id !== node.id),
            }));
          }
          const ids = new Set(incidentEdges.map((e) => e.id));
          const proxyIds = new Set(incidentProxies.map((p) => p.nodeId));
          // Remove only the rep nodes THIS undo added (a reused survivor node must
          // stay — other live edges still attach to it, #90); the mirror drops all
          // per-edge rows the undo re-added.
          setNodes((ns) => ns.filter((n) => !addedProxyIds.has(n.id)));
          setEdges((es) => es.filter((e) => !ids.has(e.id)));
          patchCanvas((c) => ({
            interiorEdges: c.interiorEdges.filter((e) => !ids.has(e.id)),
            boundaryProxies: c.boundaryProxies.filter(
              (p) => !proxyIds.has(p.nodeId),
            ),
          }));
          toast.error("Couldn’t undo. Please try again.");
        });
    },
    [setNodes, setEdges, patchCanvas, restoreComponent, utils, readdCrossScope],
  );

  // Component-detail panel: opens when the owner single-selects a real (non-
  // temp_) Component. Sourced from React Flow's selection events rather than
  // from React Flow's internal selection state so a node added optimistically
  // never auto-opens the panel before its server id arrives. Cleared on pane
  // click, scope change, or when the selected node is removed.
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const closeDetailPanel = useCallback(() => setSelectedNodeId(null), []);

  // Spec attach / merge state (#64 / ADR-0029). `specPreviewError` and
  // `activePreviewOwnerId` are each scoped to the node that STARTED the preview
  // (an `ownerNodeId`): the panel renders for whatever node is currently
  // selected, so a preview for A resolving after the user clicks B must not leak
  // A's error/spinner into B's panel. `pendingPreview` carries the source the
  // user pasted so the modal's confirm can re-apply it without re-pasting, and
  // `specPreview` is the diff classification the modal renders.
  const [specPreviewError, setSpecPreviewError] = useState<{
    ownerNodeId: string;
    message: string;
  } | null>(null);
  const [activePreviewOwnerId, setActivePreviewOwnerId] = useState<
    string | null
  >(null);
  const [pendingPreview, setPendingPreview] = useState<{
    ownerNodeId: string;
    kind: SpecKind;
    source: string;
  } | null>(null);
  const [specPreview, setSpecPreview] = useState<
    RouterOutputs["architecture"]["previewSpec"] | null
  >(null);

  // Re-seed the cross-scope VIEW (boundary proxies + edges) from a refetched
  // canvas after a spec apply — coalesced per #90 — without touching component
  // nodes, so the owner's selection survives. Replacing the boundary-proxy subset
  // (rather than re-seeding edges alone) keeps nodes and the remapped edges
  // mutually consistent when the apply shifted this scope's cross-scope reprs.
  const reseedCrossScope = useCallback(
    (canvas: CanvasData) => {
      const { reps, remap } = coalesceProxies(canvas.boundaryProxies);
      setNodes((ns) => [
        ...ns.filter((n) => n.type !== "boundary-proxy"),
        // Each rep seeds at its stored placement when it has one (#91), else onto
        // the rail; the whole proxy subset was just cleared, so the rail starts at 0.
        ...placedProxyNodes(reps, breadcrumbIds),
      ]);
      setEdges(canvas.interiorEdges.map((e) => toRFEdge(e, remap)));
    },
    [setNodes, setEdges, breadcrumbIds],
  );

  const handlePreviewSpec = useCallback(
    (ownerNodeId: string, input: { kind: SpecKind; source: string }) => {
      setSpecPreviewError(null);
      setActivePreviewOwnerId(ownerNodeId);
      previewSpec.mutate(
        { ownerNodeId, kind: input.kind, source: input.source },
        {
          onSuccess: (result) => {
            if (result.parseError !== null) {
              setSpecPreviewError({ ownerNodeId, message: result.parseError });
              setActivePreviewOwnerId(null);
              return;
            }
            // First-attach with only NEW (no existing spec) skips the modal —
            // convenience philosophy. Anything else opens the modal.
            const firstAttach =
              !result.hasExistingSpec &&
              result.changed.length === 0 &&
              result.dropped.length === 0;
            if (firstAttach) {
              applySpec.mutate(
                {
                  ownerNodeId,
                  kind: input.kind,
                  source: input.source,
                  changed: [],
                  dropped: [],
                },
                {
                  onSuccess: () => {
                    // Re-sync from the REFETCHED cache: read inside `.then` so it
                    // sees post-refetch data, not the stale pre-apply snapshot
                    // (`void` keeps this callback void-returning for the mutation
                    // option type). A spec apply mutates the owner's INTERIOR (its
                    // children), never this canvas's own nodes, so only cross-scope
                    // Connection reprs (ADR-0031) can change here — re-seed edges,
                    // not nodes (re-seeding nodes would needlessly drop the owner's
                    // selection).
                    void utils.architecture.getCanvas.invalidate().then(() => {
                      const canvas =
                        utils.architecture.getCanvas.getData(canvasInput);
                      if (canvas) reseedCrossScope(canvas);
                    });
                    toast.success(
                      `Attached spec — created ${result.new.length} component${
                        result.new.length === 1 ? "" : "s"
                      }.`,
                    );
                  },
                  onError: (error) => {
                    toast.error(
                      error.message ||
                        "Couldn’t attach the spec. Please try again.",
                    );
                  },
                  onSettled: () => setActivePreviewOwnerId(null),
                },
              );
              return;
            }
            // The modal takes over the pending/error surface from here.
            setActivePreviewOwnerId(null);
            setSpecPreview(result);
            setPendingPreview({
              ownerNodeId,
              kind: input.kind,
              source: input.source,
            });
          },
          onError: (error) => {
            setSpecPreviewError({
              ownerNodeId,
              message:
                error.message ||
                "Couldn’t preview this spec. Please try again.",
            });
            setActivePreviewOwnerId(null);
          },
        },
      );
    },
    [previewSpec, applySpec, utils, canvasInput, reseedCrossScope],
  );

  const closeSpecModal = useCallback(() => {
    setSpecPreview(null);
    setPendingPreview(null);
  }, []);

  const handleApplySpec = useCallback(
    (decisions: SpecApplyDecisions) => {
      if (!pendingPreview) return;
      applySpec.mutate(
        {
          ownerNodeId: pendingPreview.ownerNodeId,
          kind: pendingPreview.kind,
          source: pendingPreview.source,
          changed: decisions.changed,
          dropped: decisions.dropped,
        },
        {
          onSuccess: (result) => {
            // Read inside `.then` so the re-sync sees post-refetch data, not the
            // stale pre-apply snapshot. Only cross-scope Connection reprs change
            // on this canvas (the apply touches the owner's interior), so re-seed
            // edges, not nodes. See handlePreviewSpec for the rationale.
            void utils.architecture.getCanvas.invalidate().then(() => {
              const canvas = utils.architecture.getCanvas.getData(canvasInput);
              if (canvas) reseedCrossScope(canvas);
            });
            closeSpecModal();
            toast.success(
              `Applied spec — ${result.created} created, ${result.overwritten} overwritten, ${result.detached} detached, ${result.deleted} deleted.`,
            );
          },
          onError: (error) => {
            toast.error(
              error.message || "Couldn’t apply the spec. Please try again.",
            );
          },
        },
      );
    },
    [
      pendingPreview,
      applySpec,
      utils,
      closeSpecModal,
      canvasInput,
      reseedCrossScope,
    ],
  );

  // Delete a Component: a cascading soft-delete. Optimistically remove it and its
  // ON-CANVAS incident Connections from the store + cache mirror (descendants and
  // interior Connections live off-canvas — the server cascade handles them), then
  // one deleteNode mutation. On success raise an Undo toast keyed by the returned
  // deletionId; on failure roll the removal back and toast. Provided to the nodes
  // through DeleteComponentContext so it stays one stable reference.
  const removeComponent = useCallback(
    (id: string): void => {
      if (id.startsWith("temp_")) return; // no real id to soft-delete yet
      const cached = utils.architecture.getCanvas.getData(canvasInput);
      const node = cached?.interiorNodes.find((n) => n.id === id);
      // Incident-on-canvas edges are those whose on-scope REPRESENTATIVE is the
      // deleted node — covering same-Canvas, altitude (id is a deeper endpoint's
      // ancestor rep), and cross-scope near-end edges uniformly. Matching on the
      // raw `sourceId`/`targetId` would miss the altitude case (ADR-0031). For a
      // same-Canvas edge `sourceRepr === sourceId`, so this is strictly a superset.
      const incidentEdges =
        cached?.interiorEdges.filter(
          (e) => e.sourceRepr === id || e.targetRepr === id,
        ) ?? [];
      // The boundary proxies belonging to those incident cross-scope edges — they
      // must vanish with the edge, or a far-end stand-in floats with no partner.
      const incidentEdgeIds = new Set(incidentEdges.map((e) => e.id));
      const incidentProxies =
        cached?.boundaryProxies.filter((p) => incidentEdgeIds.has(p.edgeId)) ??
        [];
      // An off-scope endpoint still reached by a NON-incident crossing edge keeps
      // its coalesced node; only a fully-orphaned endpoint loses it (#90) — else a
      // surviving sibling's edge would dangle off a removed stand-in.
      const survivingEndpoints = new Set(
        (cached?.boundaryProxies ?? [])
          .filter((p) => !incidentEdgeIds.has(p.edgeId))
          .map((p) => p.realEndpointId),
      );

      if (selectedNodeId === id) closeDetailPanel();

      setNodes((ns) =>
        ns.filter(
          (n) =>
            n.id !== id &&
            !(
              n.type === "boundary-proxy" &&
              !survivingEndpoints.has(n.data.realEndpointId)
            ),
        ),
      );
      setEdges((es) => es.filter((e) => e.source !== id && e.target !== id));
      patchCanvas((c) => ({
        interiorNodes: c.interiorNodes.filter((n) => n.id !== id),
        interiorEdges: c.interiorEdges.filter(
          (e) => e.sourceRepr !== id && e.targetRepr !== id,
        ),
        boundaryProxies: c.boundaryProxies.filter(
          (p) => !incidentEdgeIds.has(p.edgeId),
        ),
      }));

      void deleteComponent({ id })
        .then(({ deletionId }) => {
          void utils.architecture.getCanvas.invalidate();
          toast("Component deleted", {
            action: {
              label: "Undo",
              onClick: () =>
                undoRemoveComponent(
                  deletionId,
                  node,
                  incidentEdges,
                  incidentProxies,
                ),
            },
          });
        })
        .catch(() => {
          if (node) {
            setNodes((ns) =>
              ns.some((n) => n.id === id) ? ns : [...ns, toRFNode(node)],
            );
            patchCanvas((c) => ({
              interiorNodes: c.interiorNodes.some((n) => n.id === id)
                ? c.interiorNodes
                : [...c.interiorNodes, node],
            }));
          }
          readdCrossScope(incidentEdges, incidentProxies);
          toast.error("Couldn’t delete the component. Please try again.");
        });
    },
    [
      utils,
      canvasInput,
      setNodes,
      setEdges,
      patchCanvas,
      deleteComponent,
      undoRemoveComponent,
      readdCrossScope,
      selectedNodeId,
      closeDetailPanel,
    ],
  );

  // Edit a Connection's label: optimistic in store + cache mirror, one updateEdge
  // mutation, both rolled back with a toast on failure. Provided to the edges
  // through context (below) so it stays one stable reference. A label edit never
  // collides (label is in no de-dupe key), so this stays a plain update — the
  // interaction picker (which CAN collide) is `commitEdgeInteraction` below.
  const commitEdgeEdit = useCallback(
    (id: string, label: string | null): void => {
      const prev = utils.architecture.getCanvas
        .getData(canvasInput)
        ?.interiorEdges.find((e) => e.id === id);
      if (!prev) return;

      const next: CanvasEdge = { ...prev, label };
      setEdges((es) =>
        es.map((e) => (e.id === id ? restyledRFEdge(e, next) : e)),
      );
      patchCanvas((c) => ({
        interiorEdges: c.interiorEdges.map((e) => (e.id === id ? next : e)),
      }));

      void editEdge({ id, label }).catch(() => {
        toast.error("Couldn’t save the connection. Please try again.");
        const current = utils.architecture.getCanvas
          .getData(canvasInput)
          ?.interiorEdges.find((e) => e.id === id);
        // Roll back ONLY the label, and only if the cache still shows what this
        // edit wrote — restore against the CURRENT row (not the captured `prev`)
        // so a concurrent interaction change that succeeded in the interim is
        // preserved rather than clobbered by a stale full-object restore.
        if (current?.label !== label) return;
        const reverted: CanvasEdge = { ...current, label: prev.label };
        setEdges((es) =>
          es.map((e) => (e.id === id ? restyledRFEdge(e, reverted) : e)),
        );
        patchCanvas((c) => ({
          interiorEdges: c.interiorEdges.map((e) =>
            e.id === id ? reverted : e,
          ),
        }));
      });
    },
    [utils, canvasInput, setEdges, patchCanvas, editEdge],
  );

  // Upgrade a Connection's interaction from the picker on the selected edge (#65).
  // Optimistic in store + cache mirror — and because the arrowheads live on the RF
  // edge object (not `data`), the optimistic edge is rebuilt through `toRFEdge` so
  // the markers flip THIS frame, not after the round trip. One
  // updateEdgeInteraction mutation; CONDITIONAL rollback (a newer change's
  // optimistic patch must not be clobbered by an older failing one, the same shape
  // commitRename carries) + a conflict-aware toast: upgrading into a directional
  // slot another Connection already holds returns a CONFLICT (ADR-0027), surfaced
  // distinctly so the user learns WHY rather than seeing a generic retry.
  const commitEdgeInteraction = useCallback(
    (id: string, interaction: Interaction): void => {
      const prev = utils.architecture.getCanvas
        .getData(canvasInput)
        ?.interiorEdges.find((e) => e.id === id);
      if (!prev || prev.interaction === interaction) return;

      const next: CanvasEdge = { ...prev, interaction };
      setEdges((es) =>
        es.map((e) => (e.id === id ? restyledRFEdge(e, next) : e)),
      );
      patchCanvas((c) => ({
        interiorEdges: c.interiorEdges.map((e) => (e.id === id ? next : e)),
      }));

      void setEdgeInteraction({ id, interaction }).catch((error: unknown) => {
        toast.error(messageForInteractionFailure(error));
        const current = utils.architecture.getCanvas
          .getData(canvasInput)
          ?.interiorEdges.find((e) => e.id === id);
        // Roll back ONLY the interaction, and only if the cache still shows what
        // THIS change wrote — restore against the CURRENT row so a concurrent
        // label edit that succeeded in the interim survives (the field-scoped
        // analogue of `commitEdgeEdit`'s rollback).
        if (current?.interaction !== interaction) return;
        const reverted: CanvasEdge = {
          ...current,
          interaction: prev.interaction,
        };
        setEdges((es) =>
          es.map((e) => (e.id === id ? restyledRFEdge(e, reverted) : e)),
        );
        patchCanvas((c) => ({
          interiorEdges: c.interiorEdges.map((e) =>
            e.id === id ? reverted : e,
          ),
        }));
      });
    },
    [utils, canvasInput, setEdges, patchCanvas, setEdgeInteraction],
  );

  // Descent: open a Component's interior Canvas. One callback shared by the
  // node's "Open" button (via DescendComponentContext) and the flow's
  // double-click handler, so the route + prefetch logic lives in one place.
  const descend = useCallback(
    (nodeId: string) => {
      if (nodeId.startsWith("temp_")) return; // no real interior yet
      // Pre-warm in case this wasn't preceded by a hover (keyboard activation).
      void utils.architecture.getCanvas.prefetch({
        slug,
        canvasNodeId: nodeId,
      });
      router.prefetch(`/p/${slug}/n/${nodeId}`);
      router.push(`/p/${slug}/n/${nodeId}`);
    },
    [utils, router, slug],
  );

  // Resolve the selected Component once for the detail panel (owner-edit or
  // viewer-read), de-duping the kind/documentation lookups.
  const selectedNode =
    selectedNodeId === null
      ? undefined
      : interiorNodes.find((n) => n.id === selectedNodeId);

  return (
    <RenameComponentContext.Provider value={commitRename}>
      <EditEdgeContext.Provider value={commitEdgeEdit}>
        <SetEdgeInteractionContext.Provider value={commitEdgeInteraction}>
          <DescendComponentContext.Provider value={descend}>
            <DeleteComponentContext.Provider value={removeComponent}>
              <CanEditContext.Provider value={canEdit}>
                <ReactFlow<CanvasRFNode, ConnectionEdge>
                  nodes={nodes}
                  edges={edges}
                  onNodesChange={onNodesChange}
                  onEdgesChange={onEdgesChange}
                  onConnect={(c) => void handleConnect(c)}
                  // Loose connection mode: a Connection can be drawn between any
                  // two handles in either direction — Components are not
                  // directional, so a Port has no input/output role and the drag
                  // direction carries no meaning here (a Connection's interaction
                  // is set separately; #65). The draw order is preserved on the
                  // Edge for the eventual arrowhead derivation (ADR-0027).
                  connectionMode={ConnectionMode.Loose}
                  // Instant drag feedback: reject a self-link and a still-optimistic
                  // (temp_) endpoint by snapping back. Duplicates are deliberately
                  // allowed through (passing [] skips the duplicate rule) so
                  // onConnect can surface a toast — blocking them here would snap a
                  // duplicate back silently, with no explanation.
                  isValidConnection={(c) => {
                    const { source, target } = c;
                    if (!source || !target) return false;
                    if (
                      source.startsWith("temp_") ||
                      target.startsWith("temp_")
                    ) {
                      return false;
                    }
                    return canConnect({ source, target }, []).ok;
                  }}
                  onEdgesDelete={handleEdgesDelete}
                  onNodeClick={(_event, node) => {
                    // Passive nodes (boundary proxies) have no editable record —
                    // never open the detail panel for them (ADR-0016).
                    if (isPassiveNode(node)) return;
                    // A `temp_…` Component has no server id yet; opening the
                    // detail panel would query for a node the server cannot
                    // find. Single-click selection only for real Components —
                    // double-click still descends.
                    if (node.id.startsWith("temp_")) return;
                    setSelectedNodeId(node.id);
                  }}
                  onPaneClick={() => setSelectedNodeId(null)}
                  onNodeDoubleClick={(_event, node) => {
                    // A boundary proxy descends through its own "go to real"
                    // affordance (to the off-scope endpoint), not the generic
                    // double-click (ADR-0016).
                    if (isPassiveNode(node)) return;
                    descend(node.id);
                  }}
                  onNodeMouseEnter={(_event, node) => {
                    // Make Descent feel instant: warm the interior Canvas payload (tRPC
                    // cache, the same key the descended island reads) and the route shell.
                    // Also warm the Plate docs-editor chunk so first selection of a
                    // Component doesn't pay a "Loading editor…" flash (ADR-0015 §6).
                    // Passive nodes have no interior to warm (ADR-0016).
                    if (isPassiveNode(node)) return;
                    if (node.id.startsWith("temp_")) return;
                    void utils.architecture.getCanvas.prefetch({
                      slug,
                      canvasNodeId: node.id,
                    });
                    router.prefetch(`/p/${slug}/n/${node.id}`);
                    // Viewers open the read-only docs panel too, so warm the
                    // Plate chunk for everyone — no first-open flash (perf #1).
                    prefetchDocsEditor();
                  }}
                  onNodeDragStop={(_event, node, dragged) => {
                    // A boundary proxy is the one draggable passive node (#91): it
                    // persists a single per-scope placement keyed by realEndpointId,
                    // never a batched Component position. It is `selectable:false`,
                    // so it can never be part of a multi-select drag — route it on
                    // its own; everything else is a Component position write.
                    if (node.type === "boundary-proxy") {
                      void persistProxyPlacement(node);
                    } else {
                      void persistPositions(dragged);
                    }
                  }}
                  onSelectionDragStop={(_event, dragged) =>
                    void persistPositions(dragged)
                  }
                  nodeTypes={nodeTypes}
                  edgeTypes={edgeTypes}
                  nodesDraggable={canEdit}
                  nodesConnectable={canEdit}
                  deleteKeyCode={canEdit ? undefined : null}
                  fitView
                >
                  <Background />
                  <Controls />
                  <Panel position="top-left" className="flex gap-2">
                    {canEdit && (
                      <AddComponent
                        onAdd={addComponent}
                        parentKind={parentKind}
                        pending={createNode.isPending}
                      />
                    )}
                    {/* Slug-readable: visible to any viewer, not gated on
                      edit. Always exports the whole project (ADR-0017 /
                      #15) — the scope-specific export lives on the
                      breadcrumb bar. */}
                    <CopyMarkdownToolbar slug={slug} />
                  </Panel>
                  {selectedNodeId !== null &&
                    (canEdit ? (
                      <Panel
                        key={selectedNodeId}
                        position="top-right"
                        className="top-0! right-0! bottom-0! m-0! flex"
                      >
                        {/* Owner mode: full edit affordances wired to the
                          canvas's mutations. Discriminated `readOnly: false`
                          keeps write callbacks visible at compile time (#16). */}
                        <ComponentDetailPanel
                          readOnly={false}
                          ownerNodeId={selectedNodeId}
                          slug={slug}
                          currentKind={selectedNode?.kind ?? "GENERIC"}
                          parentKind={parentKind}
                          initialDocumentation={
                            selectedNode?.documentation ?? ""
                          }
                          onClose={closeDetailPanel}
                          onChangeKind={commitNodeKind}
                          onConnect={commitConnect}
                          onDeleteConnection={commitDeleteConnection}
                          onCommitDocumentation={commitDocumentation}
                          onPreviewSpec={handlePreviewSpec}
                          specPreviewPending={
                            activePreviewOwnerId === selectedNodeId
                          }
                          specPreviewError={
                            specPreviewError?.ownerNodeId === selectedNodeId
                              ? specPreviewError.message
                              : null
                          }
                        />
                      </Panel>
                    ) : (
                      <Panel
                        key={selectedNodeId}
                        position="top-right"
                        className="top-0! right-0! bottom-0! m-0! flex"
                      >
                        {/* Viewer mode: read-only docs, zero write affordances.
                          Discriminated `readOnly: true` omits mutations at
                          compile time (#16). */}
                        <ComponentDetailPanel
                          readOnly={true}
                          ownerNodeId={selectedNodeId}
                          slug={slug}
                          currentKind={selectedNode?.kind ?? "GENERIC"}
                          parentKind={parentKind}
                          initialDocumentation={
                            selectedNode?.documentation ?? ""
                          }
                          onClose={closeDetailPanel}
                        />
                      </Panel>
                    ))}
                  {!nodes.some((n) => n.type === "component") && (
                    <Panel position="top-center">
                      <p className="mt-2 text-sm text-white/50">
                        Empty canvas. Add a Component to start modeling.
                      </p>
                    </Panel>
                  )}
                </ReactFlow>
              </CanEditContext.Provider>
            </DeleteComponentContext.Provider>
          </DescendComponentContext.Provider>
        </SetEdgeInteractionContext.Provider>
      </EditEdgeContext.Provider>
      {/* Spec attach/merge modal (#64 / ADR-0029). Portaled by Base UI, so it
          sits outside React Flow's coordinate space. Mounted only while a
          preview is staged so its initial state seeds from the current diff. */}
      {specPreview !== null && (
        <SpecConflictModal
          open
          preview={specPreview}
          pending={applySpec.isPending}
          onCancel={closeSpecModal}
          onConfirm={handleApplySpec}
        />
      )}
    </RenameComponentContext.Provider>
  );
}

export default function Canvas({
  scope,
  slug,
  projectId,
  canEdit,
}: {
  scope: string;
  slug: string;
  projectId: string;
  canEdit: boolean;
}) {
  return (
    <ReactFlowProvider>
      <div data-canvas-scope={scope} className="h-full w-full">
        <Suspense
          fallback={<div className="h-full w-full bg-[#1b1c33]" aria-hidden />}
        >
          <CanvasInner
            scope={scope}
            slug={slug}
            projectId={projectId}
            canEdit={canEdit}
          />
        </Suspense>
      </div>
      <Toaster theme="dark" position="bottom-right" richColors />
    </ReactFlowProvider>
  );
}

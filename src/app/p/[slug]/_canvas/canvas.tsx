"use client";

import "@xyflow/react/dist/style.css";

import {
  addEdge,
  Background,
  type Connection,
  ConnectionMode,
  Controls,
  type EdgeMarker,
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

import { canConnect } from "~/lib/connection-rules";
import { type FlowKind, type NodeKind } from "~/lib/schemas";
import {
  type CanvasBoundaryProxy,
  type CanvasData,
  type CanvasEdge,
  type CanvasFlowPalette,
  type CanvasNode,
} from "~/lib/types";
import { api } from "~/trpc/react";

import { AddComponent } from "./add-component";
import { CopyMarkdownToolbar } from "./copy-markdown";
import {
  BoundaryGroupNodeView,
  type BoundaryGroupNode,
} from "./boundary-group-node";
import {
  BoundaryProxyNodeView,
  flowIdFromHandle,
  type BoundaryProxyNode,
} from "./boundary-proxy-node";
import {
  ComponentDetailPanel,
  prefetchDocsEditor,
} from "./component-detail-panel";
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
  RouteFlowContext,
  type ConnectionEdge,
  type ConnectionEdgeFlows,
  type RouteFlowAction,
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
 */

// Module-level: React Flow re-mounts every node/edge (and warns) if `nodeTypes`
// / `edgeTypes` is a fresh object each render. Defining them once is the key
// React Flow perf guard.
const nodeTypes = {
  component: ComponentNodeView,
  "boundary-proxy": BoundaryProxyNodeView,
  "boundary-group": BoundaryGroupNodeView,
};
const edgeTypes = { connection: ConnectionEdgeView };

// The Canvas holds three node kinds: interactive Components (draggable,
// persisted), read-only boundary proxies (derived, never persisted), and the
// boundary-group container that bundles inherited proxies (also derived). All
// live in the one React Flow `nodes` array.
type CanvasRFNode = ComponentNode | BoundaryProxyNode | BoundaryGroupNode;

// "Passive node" is the taxonomy term (CONTEXT.md, ADR-0016) for a derived,
// read-only Canvas node — currently boundary-proxy and the boundary-group
// container — excluded from the detail panel, Descent, and hover-prefetch.
// Param is the discriminated union so a stray non-Canvas node cannot be passed
// and a new union member surfaces here when added.
function isPassiveNode(node: CanvasRFNode): boolean {
  return node.type === "boundary-proxy" || node.type === "boundary-group";
}

// Boundary proxies have no stored position (they are derived, #13). Lay them
// out deterministically in a row above the interior Components so they read as
// "the outside, up top" and fitView frames them with the content. Direct
// (routable) proxies sort ahead of inherited ones (the query already orders
// them that way), so the routable Ports cluster on the left; the boundary-group
// container holding the inherited proxies sits in the column after them.
const BOUNDARY_ROW_Y = -220;
const BOUNDARY_COL_W = 260;

function toBoundaryRFNode(
  proxy: CanvasBoundaryProxy,
  palette: CanvasFlowPalette | undefined,
  index: number,
): BoundaryProxyNode {
  return {
    id: proxy.nodeId,
    type: "boundary-proxy",
    position: { x: index * BOUNDARY_COL_W, y: BOUNDARY_ROW_Y },
    draggable: false,
    selectable: false,
    deletable: false,
    data: {
      title: proxy.title,
      kind: proxy.kind,
      origin: proxy.origin,
      ownerSourceEdgeId: proxy.ownerSourceEdgeId,
      ownerTargetEdgeId: proxy.ownerTargetEdgeId,
      flows: palette?.flows ?? [],
      hasMore: palette?.hasMore ?? false,
    },
  };
}

// Bundle the inherited proxies into one read-only container node (#14). Its id
// is derived from the scope (not from any member), so it stays stable across
// getCanvas refetches — React Flow reuses the node and preserves the user's
// expand toggle even as the member set changes. Boundary proxies never exist at
// the root scope (deriveBoundaryProxies returns none), but the `?? "root"`
// keeps the id total. No palette/edge data: inherited proxies are not routable
// here (ADR-0012), so the container needs only enough to list its members.
function toBoundaryGroupRFNode(
  inherited: CanvasBoundaryProxy[],
  indexAfterDirect: number,
  canvasNodeId: string | null,
): BoundaryGroupNode {
  return {
    id: `boundary-group:${canvasNodeId ?? "root"}`,
    type: "boundary-group",
    position: { x: indexAfterDirect * BOUNDARY_COL_W, y: BOUNDARY_ROW_Y },
    draggable: false,
    selectable: false,
    deletable: false,
    data: {
      members: inherited.map((p) => ({
        nodeId: p.nodeId,
        title: p.title,
        kind: p.kind,
      })),
    },
  };
}

// A Connection's direction is structural — output Port → input Port — so every
// Connection carries one arrowhead at its target (input) end. Set on the edge
// object (never a stored field) so React Flow registers the marker once and the
// edge view forwards the resolved url (CONTEXT.md "Port"; ADR-0009).
const STRUCTURAL_MARKER_END: EdgeMarker = { type: MarkerType.ArrowClosed };

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
      flowCount: n._count.flows,
    },
  };
}

function toRFEdge(e: CanvasEdge): ConnectionEdge {
  return {
    id: e.id,
    type: "connection",
    source: e.sourceId,
    target: e.targetId,
    markerEnd: STRUCTURAL_MARKER_END,
    data: {
      label: e.label,
      optimistic: e.id.startsWith("temp_"),
    },
  };
}

/**
 * Hydrate a base RF edge with its `edgeFlows` aggregation (Slice 2) and the
 * endpoint metadata the "+ flow" popover needs. Kept as a free function (not
 * folded into `toRFEdge`) because the per-edge merge needs canvas-wide
 * `edgeFlows` + the source/target Component titles, and `toRFEdge` is also
 * used during optimistic edge reconciliation where only the edge itself is
 * known.
 */
function withEdgeFlows(
  edge: ConnectionEdge,
  flowsByEdge: Map<string, ConnectionEdgeFlows>,
  titleByNode: Map<string, string>,
  slug: string,
): ConnectionEdge {
  const flows = flowsByEdge.get(edge.id);
  // `edge.source` / `edge.target` are React Flow's foreign-key fields — same
  // values as the underlying `sourceId` / `targetId`.
  const sourceTitle = titleByNode.get(edge.source);
  const targetTitle = titleByNode.get(edge.target);
  return {
    ...edge,
    data: {
      ...edge.data,
      label: edge.data?.label ?? null,
      edgeFlows: flows,
      endpoints:
        sourceTitle !== undefined && targetTitle !== undefined
          ? {
              slug,
              sourceId: edge.source,
              sourceTitle,
              targetId: edge.target,
              targetTitle,
            }
          : undefined,
    },
  };
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
    // A freshly-created Component owns no Flows yet (ADR-0011); the "N flows"
    // pill renders only when the count is non-zero, so a 0 is correct here.
    _count: { flows: 0 },
  };
}

function optimisticCanvasEdge(
  id: string,
  projectId: string,
  canvasNodeId: string | null,
  sourceId: string,
  targetId: string,
): CanvasEdge {
  const now = new Date();
  return {
    id,
    projectId,
    canvasNodeId,
    sourceId,
    targetId,
    label: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    deletionId: null,
  };
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
 * Applies a +1/-1 delta to one Flow-kind bucket of an `edgeFlows` entry's
 * `byKind` map, keeping the optimistic mirror in the same shape the server
 * returns (zero-count kinds omitted, never negative).
 */
function bumpByKind(
  byKind: Partial<Record<FlowKind, number>>,
  kind: FlowKind,
  delta: number,
): Partial<Record<FlowKind, number>> {
  const next = { ...byKind };
  const value = (next[kind] ?? 0) + delta;
  if (value <= 0) {
    delete next[kind];
  } else {
    next[kind] = value;
  }
  return next;
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
  // Components and the canvasNodeId of its Connections.
  const canvasNodeId = scope === "root" ? null : scope;
  // Stable across renders so it stays a single query key and a stable callback dep.
  const canvasInput = useMemo(
    () => ({ slug, canvasNodeId }),
    [slug, canvasNodeId],
  );
  const [
    { interiorNodes, interiorEdges, edgeFlows, boundaryProxies, flowPalettes, breadcrumbs },
  ] = api.architecture.getCanvas.useSuspenseQuery(canvasInput);

  // The kind palette ranks its suggestions by the scope's own Component kind —
  // the parent of any Component added here (CONTEXT.md "Kind affinity"). The
  // current scope is the last breadcrumb; the root scope has none, so `null`
  // keys the root affinity.
  const parentKind = breadcrumbs.at(-1)?.kind ?? null;

  // Seed React Flow's store ONCE from the hydrated query; thereafter the store
  // owns interaction state. The island is keyed by scope (./index), so a Descent
  // (a scope change) remounts and re-seeds rather than inheriting these.
  // Persistence flows through one batched/single mutation per gesture (below),
  // with the query cache kept in lockstep so a remount re-seeds it. Boundary
  // proxies seed alongside the Components: they are read-only and never the
  // subject of a Component mutation (their ids never match a rename/delete/
  // reconcile target), so they ride safely in the same store (#14).
  //
  // Direct proxies render individually (they are the routable work surface, #36);
  // the inherited ones bundle into one boundary-group container so a deep Canvas
  // is not buried under N un-routable stand-ins (#14). The container renders even
  // for a single inherited proxy — one consistent affordance, and a refetch that
  // flips the inherited count between 1 and 2 never reshuffles the surface.
  const directProxies = boundaryProxies.filter((p) => p.origin === "direct");
  const inheritedProxies = boundaryProxies.filter(
    (p) => p.origin === "inherited",
  );
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasRFNode>([
    ...interiorNodes.map(toRFNode),
    ...directProxies.map((p, i) =>
      toBoundaryRFNode(p, flowPalettes[p.nodeId], i),
    ),
    ...(inheritedProxies.length > 0
      ? [
          toBoundaryGroupRFNode(
            inheritedProxies,
            directProxies.length,
            canvasNodeId,
          ),
        ]
      : []),
  ]);
  // Initial edges seed: pure structural shape (no edgeFlows yet). The
  // `edgesWithFlows` useMemo below hydrates the aggregation + endpoint
  // metadata across rerenders.
  const [edges, setEdges, onEdgesChange] = useEdgesState<ConnectionEdge>(
    interiorEdges.map(toRFEdge),
  );

  // Slice 2: merge the canvas-wide edgeFlows aggregation and the endpoint
  // Component titles onto each edge's `data`, in one place so the per-edge
  // pill + "+ flow" trigger never have to fish for canvas-level state. Keyed
  // on `[edges, edgeFlows, interiorNodes]` — the React Flow `edges` state is
  // included so a freshly-drawn optimistic edge picks up its `endpoints`
  // metadata on the next frame (its `edgeFlows` stays undefined until the
  // server response, at which point the cache mirror + invalidate refresh
  // both arms).
  const enrichedEdges = useMemo<ConnectionEdge[]>(() => {
    const flowsByEdge = new Map<string, ConnectionEdgeFlows>(
      (edgeFlows ?? []).map((ef) => [ef.edgeId, ef]),
    );
    const titleByNode = new Map<string, string>(
      interiorNodes.map((n) => [n.id, n.title] as const),
    );
    return edges.map((e) =>
      withEdgeFlows(e, flowsByEdge, titleByNode, slug),
    );
  }, [edges, edgeFlows, interiorNodes, slug]);
  const { screenToFlowPosition } = useReactFlow();
  const createNode = api.architecture.createNode.useMutation();
  // Destructured so the stable `mutateAsync` can be a dep of the context values
  // below without dragging the whole (per-render) mutation object into them.
  const { mutateAsync: renameNode } = api.architecture.updateNode.useMutation();
  const { mutateAsync: changeNodeKind } =
    api.architecture.updateNodeKind.useMutation();
  const { mutateAsync: editDocumentation } =
    api.architecture.updateNodeDocumentation.useMutation();
  const updatePositions = api.architecture.updatePositions.useMutation();
  const connectNodes = api.architecture.connectNodes.useMutation();
  const { mutateAsync: editEdge } = api.architecture.updateEdge.useMutation();
  const { mutateAsync: removeEdge } = api.architecture.deleteEdge.useMutation();
  const { mutateAsync: deleteComponent } =
    api.architecture.deleteNode.useMutation();
  const { mutateAsync: restoreComponent } =
    api.architecture.restoreNode.useMutation();
  const { mutateAsync: routeFlow } =
    api.architecture.routeFlow.useMutation();
  const { mutateAsync: unrouteFlow } =
    api.architecture.unrouteFlow.useMutation();

  // The query cache is the re-seed mirror. EVERY write goes through this merge
  // helper so a partial update can never drop a sibling key (e.g. node edits
  // silently erasing `interiorEdges`) — the regression `getCanvas` growing a
  // second key would otherwise invite. It spreads the prior value, so callers
  // return only the slice they changed.
  const patchCanvas = useCallback(
    (patch: (prev: CanvasData) => Partial<CanvasData>) => {
      utils.architecture.getCanvas.setData(canvasInput, (old) => {
        // The zero-value defaults are load-bearing — a partial update on a cold
        // cache (e.g. `commitRouteFlow` fires before the query has resolved
        // once) would otherwise patch against a base that lacks a key and drop
        // it. Keep EVERY getCanvas key here (boundaryProxies / flowPalettes
        // joined the payload in Slice 3).
        const base: CanvasData = old ?? {
          interiorNodes: [],
          interiorEdges: [],
          edgeFlows: [],
          boundaryProxies: [],
          flowPalettes: {},
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
        // Reconcile temp → real id in both stores, atomically by id. The
        // `createNode` service returns the bare Node row; a fresh Node owns
        // zero Flows, so we hydrate `_count` to keep the CanvasNode shape
        // intact (ADR-0011).
        const realWithCount: CanvasNode = { ...real, _count: { flows: 0 } };
        setNodes((ns) =>
          ns.map((n) => (n.id === tempId ? toRFNode(realWithCount) : n)),
        );
        patchCanvas((c) => ({
          interiorNodes: c.interiorNodes.map((n) =>
            n.id === tempId ? realWithCount : n,
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
  // cosmetic, so no edge/flow state is touched (ADR-0018).
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

      const prior =
        inflightDocSavesRef.current.get(id) ?? Promise.resolve();
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
    // Accepts the union React Flow hands `onNodeDragStop`; boundary proxies and
    // the boundary-group container are `draggable: false` so they never appear
    // here, and any that did would be skipped — they have no `interiorNodes`
    // row to look up.
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

  // Shared optimistic body for a refinement route from a boundary-proxy palette
  // (Slice 3 / ADR-0012). Draws the inner Edge optimistically (store + cache
  // mirror), runs `resolveRoute` (the mutation(s) that create the real route),
  // reconciles the temp id to the real inner Edge (converging silently when the
  // inner Edge already exists — a shared pipe), and rolls back + toasts on any
  // failure. `resolveRoute` is the variation point: a direct route fires one
  // `routeFlow`; the reverse-Connection path (Slice 4 / ADR-0013) creates the
  // reverse outer Edge first, then routes against it — both roll back together
  // here on failure. The routed-count pill refreshes when the user navigates
  // back up (a fresh getCanvas), so no cross-scope cache write is needed.
  const runOptimisticInnerRoute = useCallback(
    async (
      source: string,
      target: string,
      resolveRoute: () => Promise<{
        innerEdgeId: string | null;
        outerEdgeId: string;
      }>,
    ): Promise<void> => {
      const tempId = `temp_${crypto.randomUUID()}`;
      setEdges((es) =>
        addEdge(
          {
            id: tempId,
            type: "connection",
            source,
            target,
            markerEnd: STRUCTURAL_MARKER_END,
            data: { label: null, optimistic: true },
          },
          es,
        ),
      );
      patchCanvas((c) => ({
        interiorEdges: [
          ...c.interiorEdges,
          optimisticCanvasEdge(tempId, projectId, canvasNodeId, source, target),
        ],
      }));

      try {
        const route = await resolveRoute();
        const innerId = route.innerEdgeId;
        // Reconcile the temp inner Edge to the real one. If the inner Edge
        // already exists (a shared pipe other Flows converged on), just drop
        // the temp — re-adding its id would duplicate a node in the store.
        const real =
          innerId === null
            ? null
            : optimisticCanvasEdge(
                innerId,
                projectId,
                canvasNodeId,
                source,
                target,
              );
        setEdges((es) => {
          const withoutTemp = es.filter((e) => e.id !== tempId);
          if (!real || withoutTemp.some((e) => e.id === real.id)) {
            return withoutTemp;
          }
          return [...withoutTemp, toRFEdge(real)];
        });
        patchCanvas((c) => {
          const without = c.interiorEdges.filter((e) => e.id !== tempId);
          if (!real || without.some((e) => e.id === real.id)) {
            return { interiorEdges: without };
          }
          return { interiorEdges: [...without, real] };
        });
        // The Flow is now routed on `route.outerEdgeId` one scope up, so that
        // Connection's "+ flow" popover (its unrouted filter) is stale. Refresh
        // it; the routed-count pill itself refreshes on ascend.
        void utils.architecture.getRoutedFlowIdsForEdge.invalidate({
          outerEdgeId: route.outerEdgeId,
          slug,
        });
      } catch {
        setEdges((es) => es.filter((e) => e.id !== tempId));
        patchCanvas((c) => ({
          interiorEdges: c.interiorEdges.filter((e) => e.id !== tempId),
        }));
        toast.error("Couldn’t route the flow. Please try again.");
      }
    },
    [utils, projectId, canvasNodeId, setEdges, patchCanvas, slug],
  );

  // Route a Flow from a boundary proxy's palette. Picks the outer Connection
  // whose orientation matches the Flow's polarity (Slice 4 / ADR-0013): an
  // INBOUND Flow rides the Edge pointing at its owner (`ownerTargetEdgeId`), an
  // OUTBOUND Flow the Edge pointing away (`ownerSourceEdgeId`). When the
  // matching orientation exists, route directly. When it does NOT — the
  // polarity mismatch — the canvas does NOT dispatch `routeFlow`; it offers a
  // one-click reverse Connection (the structural arrow cannot lie, so the other
  // direction is a second Connection, never a reversed arrow — ADR-0009). On
  // confirm, one batched gesture creates the reverse outer Edge (a strict
  // same-Canvas write at the PARENT scope) then routes against it.
  const routeFromPalette = useCallback(
    async (params: {
      flowId: string;
      proxyNodeId: string;
      source: string;
      target: string;
    }): Promise<void> => {
      const { flowId, proxyNodeId, source, target } = params;
      // Boundary proxies never exist at the root scope (deriveBoundaryProxies
      // returns none), so a proxy drag implies a non-null current scope.
      if (canvasNodeId === null) return;
      // A still-optimistic child endpoint has no server id to bind yet.
      if (source.startsWith("temp_") || target.startsWith("temp_")) {
        toast.error("Finish adding that component before routing a flow to it.");
        return;
      }
      const data = utils.architecture.getCanvas.getData(canvasInput);
      const proxy = data?.boundaryProxies.find((p) => p.nodeId === proxyNodeId);
      const polarity = data?.flowPalettes[proxyNodeId]?.flows.find(
        (f) => f.id === flowId,
      )?.polarity;
      if (!proxy || !polarity) {
        toast.error("That flow can’t be routed here.");
        return;
      }

      const matchingEdgeId =
        polarity === "INBOUND" ? proxy.ownerTargetEdgeId : proxy.ownerSourceEdgeId;
      if (matchingEdgeId) {
        await runOptimisticInnerRoute(source, target, () =>
          routeFlow({
            flowId,
            outerEdgeId: matchingEdgeId,
            sourceNodeId: source,
            targetNodeId: target,
          }),
        );
        return;
      }

      // Polarity mismatch: no Connection oriented for this Flow exists. The
      // reverse outer Edge lives on the PARENT Canvas (one scope up), between
      // this scope's Component and the proxy owner — a strict same-Canvas write
      // for `connectNodes` (both endpoints sit on the parent Canvas because the
      // proxy is direct). The parent scope is the breadcrumb before the current.
      const breadcrumbs = data?.breadcrumbs ?? [];
      const parentScopeId = breadcrumbs[breadcrumbs.length - 2]?.id ?? null;
      const scopeTitle =
        breadcrumbs[breadcrumbs.length - 1]?.title ?? "this component";
      const ownerTitle = proxy.title;
      const reverse =
        polarity === "OUTBOUND"
          ? { sourceId: proxyNodeId, targetId: canvasNodeId, label: `${ownerTitle} → ${scopeTitle}` }
          : { sourceId: canvasNodeId, targetId: proxyNodeId, label: `${scopeTitle} → ${ownerTitle}` };

      toast(`Add the ${reverse.label} Connection?`, {
        description: `This ${
          polarity === "OUTBOUND" ? "outbound" : "inbound"
        } flow can only ride a Connection that carries it that way.`,
        action: {
          label: "Add it",
          onClick: () =>
            void runOptimisticInnerRoute(source, target, async () => {
              const created = await connectNodes.mutateAsync({
                projectId,
                canvasNodeId: parentScopeId,
                sourceId: reverse.sourceId,
                targetId: reverse.targetId,
              });
              // The reverse Connection now exists, so record its id on the
              // proxy's matching orientation. Without this the cache keeps the
              // null that triggered the offer, and the next same-polarity drag
              // re-offers and then collides on the duplicate Connection. The
              // patch lives here (not in runOptimisticInnerRoute's rollback)
              // because the Edge persists even if the routeFlow below fails —
              // ADR-0013's accepted live-but-routeless reverse Connection.
              patchCanvas((c) => ({
                boundaryProxies: c.boundaryProxies.map((p) =>
                  p.nodeId !== proxyNodeId
                    ? p
                    : polarity === "OUTBOUND"
                      ? { ...p, ownerSourceEdgeId: created.id }
                      : { ...p, ownerTargetEdgeId: created.id },
                ),
              }));
              return routeFlow({
                flowId,
                outerEdgeId: created.id,
                sourceNodeId: source,
                targetNodeId: target,
              });
            }),
        },
      });
    },
    [
      canvasNodeId,
      utils,
      canvasInput,
      runOptimisticInnerRoute,
      patchCanvas,
      routeFlow,
      connectNodes,
      projectId,
    ],
  );

  // Draw a Connection. Refuses a still-optimistic (temp_) endpoint (no real id
  // to persist yet), then pre-flights the pure topology rules — no self-link, no
  // duplicate — via `canConnect`, so the user gets instant feedback rather than a
  // doomed round trip (the service stays authoritative). Optimistic edge in store
  // + cache mirror, one connectNodes mutation, reconcile temp → real id, roll
  // back + toast on failure (a CONFLICT/BAD_REQUEST rejection rolls back the same
  // way).
  const handleConnect = useCallback(
    async (connection: Connection) => {
      const { source, target } = connection;
      if (!source || !target) return;

      // Refinement route: one endpoint is a boundary-proxy palette item (its
      // handle id encodes the Flow). Branch off to the cross-scope writer
      // (Slice 3 / ADR-0012) — this is not a plain Component-to-Component draw.
      const flowId =
        flowIdFromHandle(connection.sourceHandle) ??
        flowIdFromHandle(connection.targetHandle);
      if (flowId) {
        const proxyNodeId = flowIdFromHandle(connection.sourceHandle)
          ? source
          : target;
        await routeFromPalette({ flowId, proxyNodeId, source, target });
        return;
      }

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
      setEdges((es) =>
        addEdge(
          {
            id: tempId,
            type: "connection",
            source,
            target,
            markerEnd: STRUCTURAL_MARKER_END,
            data: { label: null, optimistic: true },
          },
          es,
        ),
      );
      patchCanvas((c) => ({
        interiorEdges: [
          ...c.interiorEdges,
          optimisticCanvasEdge(tempId, projectId, canvasNodeId, source, target),
        ],
      }));

      try {
        const real = await connectNodes.mutateAsync({
          projectId,
          canvasNodeId,
          sourceId: source,
          targetId: target,
        });
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
    [
      utils,
      canvasInput,
      canvasNodeId,
      setEdges,
      patchCanvas,
      projectId,
      connectNodes,
      routeFromPalette,
    ],
  );

  // Remove a Connection (React Flow's Delete/Backspace). `onEdgesChange`
  // already dropped it from the store; here we mirror the removal into the
  // cache and soft-delete it server-side. A still-optimistic edge was never
  // persisted, so it just disappears. Failure re-adds the edge to both
  // stores and toasts.
  //
  // Slice 2 cascade: when `deleteEdge` sweeps incident FlowRoutes it returns
  // a `deletionId` and the swept route ids; we drop the per-edge `edgeFlows`
  // entry optimistically alongside the edge. The cascade case has no undo
  // affordance here yet — the delete path uses React Flow's keyboard delete,
  // which has no toast slot; wiring a `restoreEdge` undo is a Slice 5
  // affordance alongside the inspector.
  const handleEdgesDelete = useCallback(
    (deleted: ConnectionEdge[]) => {
      const cached = utils.architecture.getCanvas.getData(canvasInput);
      for (const edge of deleted) {
        if (edge.id.startsWith("temp_")) continue;
        const prev = cached?.interiorEdges.find((e) => e.id === edge.id);
        const prevFlows = cached?.edgeFlows.find(
          (ef) => ef.edgeId === edge.id,
        );
        patchCanvas((c) => ({
          interiorEdges: c.interiorEdges.filter((e) => e.id !== edge.id),
          edgeFlows: c.edgeFlows.filter((ef) => ef.edgeId !== edge.id),
        }));
        void removeEdge({ id: edge.id }).catch(() => {
          setEdges((es) =>
            es.some((e) => e.id === edge.id) ? es : [...es, edge],
          );
          if (prev) {
            patchCanvas((c) => ({
              interiorEdges: [...c.interiorEdges, prev],
              edgeFlows: prevFlows ? [...c.edgeFlows, prevFlows] : c.edgeFlows,
            }));
          }
          toast.error("Couldn’t remove the connection. Please try again.");
        });
      }
    },
    [utils, canvasInput, patchCanvas, setEdges, removeEdge],
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
      setEdges((es) => {
        const present = new Set(es.map((e) => e.id));
        const add = incidentEdges.filter((e) => !present.has(e.id));
        return add.length ? [...es, ...add.map(toRFEdge)] : es;
      });
      patchCanvas((c) => {
        const present = new Set(c.interiorEdges.map((e) => e.id));
        const add = incidentEdges.filter((e) => !present.has(e.id));
        return add.length
          ? { interiorEdges: [...c.interiorEdges, ...add] }
          : {};
      });

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
          setEdges((es) => es.filter((e) => !ids.has(e.id)));
          patchCanvas((c) => ({
            interiorEdges: c.interiorEdges.filter((e) => !ids.has(e.id)),
          }));
          toast.error("Couldn’t undo. Please try again.");
        });
    },
    [setNodes, setEdges, patchCanvas, restoreComponent, utils],
  );

  // Component-detail panel: opens when the owner single-selects a real (non-
  // temp_) Component. Sourced from React Flow's selection events rather than
  // from React Flow's internal selection state so a node added optimistically
  // never auto-opens the panel before its server id arrives (ADR-0011 / Slice
  // 1 detail panel scaffold). Cleared on pane click, scope change, or when
  // the selected node is removed (`removeComponent` below).
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const closeDetailPanel = useCallback(() => setSelectedNodeId(null), []);

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
      const incidentEdges =
        cached?.interiorEdges.filter(
          (e) => e.sourceId === id || e.targetId === id,
        ) ?? [];

      if (selectedNodeId === id) closeDetailPanel();

      setNodes((ns) => ns.filter((n) => n.id !== id));
      setEdges((es) => es.filter((e) => e.source !== id && e.target !== id));
      patchCanvas((c) => ({
        interiorNodes: c.interiorNodes.filter((n) => n.id !== id),
        interiorEdges: c.interiorEdges.filter(
          (e) => e.sourceId !== id && e.targetId !== id,
        ),
      }));

      void deleteComponent({ id })
        .then(({ deletionId }) => {
          void utils.architecture.getCanvas.invalidate();
          toast("Component deleted", {
            action: {
              label: "Undo",
              onClick: () =>
                undoRemoveComponent(deletionId, node, incidentEdges),
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
          setEdges((es) => {
            const present = new Set(es.map((e) => e.id));
            const add = incidentEdges.filter((e) => !present.has(e.id));
            return add.length ? [...es, ...add.map(toRFEdge)] : es;
          });
          patchCanvas((c) => {
            const present = new Set(c.interiorEdges.map((e) => e.id));
            const add = incidentEdges.filter((e) => !present.has(e.id));
            return add.length
              ? { interiorEdges: [...c.interiorEdges, ...add] }
              : {};
          });
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
      selectedNodeId,
      closeDetailPanel,
    ],
  );

  // Edit a Connection's label: optimistic in store + cache mirror, one updateEdge
  // mutation, both rolled back with a toast on failure. Provided to the edges
  // through context (below) so it stays one stable reference. (There is no
  // direction to edit — the arrow is structural, output→input; ADR-0009.)
  const commitEdgeEdit = useCallback(
    (id: string, label: string | null): void => {
      const prev = utils.architecture.getCanvas
        .getData(canvasInput)
        ?.interiorEdges.find((e) => e.id === id);

      setEdges((es) =>
        es.map((e) => (e.id === id ? { ...e, data: { ...e.data, label } } : e)),
      );
      patchCanvas((c) => ({
        interiorEdges: c.interiorEdges.map((e) =>
          e.id === id ? { ...e, label } : e,
        ),
      }));

      void editEdge({ id, label }).catch(() => {
        if (prev) {
          setEdges((es) => es.map((e) => (e.id === id ? toRFEdge(prev) : e)));
          patchCanvas((c) => ({
            interiorEdges: c.interiorEdges.map((e) => (e.id === id ? prev : e)),
          }));
        }
        toast.error("Couldn’t save the connection. Please try again.");
      });
    },
    [utils, canvasInput, setEdges, patchCanvas, editEdge],
  );

  // After the detail panel runs an attach + parse, the server's new flow
  // count needs to land in BOTH the React Flow store (so the pill updates
  // this frame on the same Component) and the cache mirror (so a remount
  // re-seeds correctly). Cache invalidation alone doesn't reach the RF store
  // — the seed is fire-and-forget by design (ADR-0004 island model). One
  // stable callback the panel calls when the server responds.
  const commitFlowCount = useCallback(
    (id: string, flowCount: number) => {
      setNodes((ns) =>
        ns.map((n) =>
          n.id === id && n.type === "component"
            ? { ...n, data: { ...n.data, flowCount } }
            : n,
        ),
      );
      patchCanvas((c) => ({
        interiorNodes: c.interiorNodes.map((n) =>
          n.id === id ? { ...n, _count: { flows: flowCount } } : n,
        ),
      }));
    },
    [setNodes, patchCanvas],
  );

  // Route a Flow onto a Connection (Slice 2). Optimistic on the
  // `edgeFlows` aggregation only — the new FlowRoute row itself is not
  // surfaced anywhere in the canvas, only its count. Bump `routed`,
  // decrement `unrouted`, fire `routeFlow`; on failure undo via an inverse
  // delta (NOT a snapshot restore) so an overlapping in-flight route on the
  // same edge isn't clobbered, then reconcile to server truth.
  const commitRouteFlow = useCallback(
    (flowId: string, outerEdgeId: string, flowKind: FlowKind): void => {
      patchCanvas((c) => ({
        edgeFlows: c.edgeFlows.map((ef) =>
          ef.edgeId === outerEdgeId
            ? {
                ...ef,
                routed: ef.routed + 1,
                unrouted: Math.max(0, ef.unrouted - 1),
                byKind: bumpByKind(ef.byKind, flowKind, 1),
              }
            : ef,
        ),
      }));

      void routeFlow({ flowId, outerEdgeId })
        .then(() => {
          // Refresh the popover's unrouted filter on next open.
          void utils.architecture.getRoutedFlowIdsForEdge.invalidate({
            outerEdgeId,
            slug,
          });
        })
        .catch(() => {
          // Inverse-delta rollback: undo only this op's own +1/-1 against the
          // current counts, so a concurrent route that succeeded mid-flight
          // keeps its increment. Then reconcile to the authoritative counts —
          // but only here, on the error path: a happy-path `getCanvas`
          // refetch would cost a round-trip per route (Philosophy #1).
          patchCanvas((c) => ({
            edgeFlows: c.edgeFlows.map((ef) =>
              ef.edgeId === outerEdgeId
                ? {
                    ...ef,
                    routed: Math.max(0, ef.routed - 1),
                    unrouted: ef.unrouted + 1,
                    byKind: bumpByKind(ef.byKind, flowKind, -1),
                  }
                : ef,
            ),
          }));
          void utils.architecture.getCanvas.invalidate(canvasInput);
          toast.error("Couldn’t route the flow. Please try again.");
        });
    },
    [utils, canvasInput, patchCanvas, routeFlow, slug],
  );

  // Remove a FlowRoute (Slice 2). Mirror of `commitRouteFlow`: dec routed,
  // inc unrouted, rollback on failure. Slice 2 has no UI surface that fires
  // unroute yet (Slice 5's inspector owns the unroute affordance) — but the
  // dispatch path is shipped now so the context contract is complete; a
  // future inspector composes on top with zero service-layer changes.
  const commitUnrouteFlow = useCallback(
    (flowRouteId: string, outerEdgeId: string, flowKind: FlowKind): void => {
      patchCanvas((c) => ({
        edgeFlows: c.edgeFlows.map((ef) =>
          ef.edgeId === outerEdgeId
            ? {
                ...ef,
                routed: Math.max(0, ef.routed - 1),
                unrouted: ef.unrouted + 1,
                byKind: bumpByKind(ef.byKind, flowKind, -1),
              }
            : ef,
        ),
      }));

      void unrouteFlow({ flowRouteId })
        .then(() => {
          void utils.architecture.getRoutedFlowIdsForEdge.invalidate({
            outerEdgeId,
            slug,
          });
        })
        .catch(() => {
          // Inverse-delta rollback + error-path reconcile — see
          // `commitRouteFlow` for the rationale.
          patchCanvas((c) => ({
            edgeFlows: c.edgeFlows.map((ef) =>
              ef.edgeId === outerEdgeId
                ? {
                    ...ef,
                    routed: ef.routed + 1,
                    unrouted: Math.max(0, ef.unrouted - 1),
                    byKind: bumpByKind(ef.byKind, flowKind, 1),
                  }
                : ef,
            ),
          }));
          void utils.architecture.getCanvas.invalidate(canvasInput);
          toast.error("Couldn’t remove the routing. Please try again.");
        });
    },
    [utils, canvasInput, patchCanvas, unrouteFlow, slug],
  );

  // Single dispatch consumed by `RouteFlowContext`. Discriminated by `kind`
  // — keeps the popover / inspector consumers honest about which op they
  // mean and lets the canvas keep the rollback bookkeeping in one place.
  const routeFlowDispatch = useCallback(
    (action: RouteFlowAction) => {
      if (action.kind === "route") {
        commitRouteFlow(action.flowId, action.outerEdgeId, action.flowKind);
      } else {
        commitUnrouteFlow(
          action.flowRouteId,
          action.outerEdgeId,
          action.flowKind,
        );
      }
    },
    [commitRouteFlow, commitUnrouteFlow],
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

  return (
    <RenameComponentContext.Provider value={commitRename}>
      <EditEdgeContext.Provider value={commitEdgeEdit}>
        <RouteFlowContext.Provider value={routeFlowDispatch}>
          <DescendComponentContext.Provider value={descend}>
            <DeleteComponentContext.Provider value={removeComponent}>
              <CanEditContext.Provider value={canEdit}>
                <ReactFlow<CanvasRFNode, ConnectionEdge>
                  nodes={nodes}
                  edges={enrichedEdges}
                  onNodesChange={onNodesChange}
                  onEdgesChange={onEdgesChange}
                  onConnect={(c) => void handleConnect(c)}
                  // Strict connection mode is what makes a Connection run only
                  // output Port → input Port (a drag can go only from a source
                  // handle to a target handle); pin it explicitly so that
                  // output→input invariant can't be silently lost (ADR-0009).
                  connectionMode={ConnectionMode.Strict}
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
                    // A `temp_…` Component has no server id yet; opening the
                    // detail panel would query for a node the server cannot
                    // find. Boundary proxies are read-only stand-ins — they
                    // have no editable detail panel. Single-click selection
                    // only for real Components — double-click still descends.
                    if (node.id.startsWith("temp_")) return;
                    if (isPassiveNode(node)) return;
                    setSelectedNodeId(node.id);
                  }}
                  onPaneClick={() => setSelectedNodeId(null)}
                  onNodeDoubleClick={(_event, node) => {
                    // Boundary proxies and the boundary-group container are
                    // read-only — they have no interior to descend into (descend
                    // into the real Component instead).
                    if (isPassiveNode(node)) return;
                    descend(node.id);
                  }}
                  onNodeMouseEnter={(_event, node) => {
                    // Make Descent feel instant: warm the interior Canvas payload (tRPC
                    // cache, the same key the descended island reads) and the route shell.
                    // Also warm the Plate docs-editor chunk so first selection of a
                    // Component doesn't pay a "Loading editor…" flash (ADR-0015 §6).
                    if (node.id.startsWith("temp_")) return;
                    if (isPassiveNode(node)) return;
                    void utils.architecture.getCanvas.prefetch({
                      slug,
                      canvasNodeId: node.id,
                    });
                    router.prefetch(`/p/${slug}/n/${node.id}`);
                    if (canEdit) prefetchDocsEditor();
                  }}
                  onNodeDragStop={(_event, _node, dragged) =>
                    void persistPositions(dragged)
                  }
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
                  {canEdit && selectedNodeId !== null && (
                    <Panel
                      position="top-right"
                      className="top-0! right-0! bottom-0! m-0! flex"
                    >
                      <ComponentDetailPanel
                        slug={slug}
                        ownerNodeId={selectedNodeId}
                        currentKind={
                          interiorNodes.find((n) => n.id === selectedNodeId)
                            ?.kind ?? "GENERIC"
                        }
                        parentKind={parentKind}
                        initialDocumentation={
                          interiorNodes.find((n) => n.id === selectedNodeId)
                            ?.documentation ?? ""
                        }
                        onClose={closeDetailPanel}
                        onChangeKind={commitNodeKind}
                        onFlowCountChange={commitFlowCount}
                        onCommitDocumentation={commitDocumentation}
                      />
                    </Panel>
                  )}
                  {nodes.length === 0 && (
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
        </RouteFlowContext.Provider>
      </EditEdgeContext.Provider>
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

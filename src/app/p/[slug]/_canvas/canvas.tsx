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
import { Suspense, useCallback, useMemo, useState } from "react";
import { Toaster, toast } from "sonner";

import { canConnect } from "~/lib/connection-rules";
import { type NodeKind } from "~/lib/schemas";
import { type CanvasData, type CanvasEdge, type CanvasNode } from "~/lib/types";
import { api } from "~/trpc/react";

import { AddComponent } from "./add-component";
import { ComponentDetailPanel } from "./component-detail-panel";
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
 */

// Module-level: React Flow re-mounts every node/edge (and warns) if `nodeTypes`
// / `edgeTypes` is a fresh object each render. Defining them once is the key
// React Flow perf guard.
const nodeTypes = { component: ComponentNodeView };
const edgeTypes = { connection: ConnectionEdgeView };

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
  const [{ interiorNodes, interiorEdges }] =
    api.architecture.getCanvas.useSuspenseQuery(canvasInput);

  // Seed React Flow's store ONCE from the hydrated query; thereafter the store
  // owns interaction state. The island is keyed by scope (./index), so a Descent
  // (a scope change) remounts and re-seeds rather than inheriting these.
  // Persistence flows through one batched/single mutation per gesture (below),
  // with the query cache kept in lockstep so a remount re-seeds it.
  const [nodes, setNodes, onNodesChange] = useNodesState<ComponentNode>(
    interiorNodes.map(toRFNode),
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState<ConnectionEdge>(
    interiorEdges.map(toRFEdge),
  );
  const { screenToFlowPosition } = useReactFlow();
  const createNode = api.architecture.createNode.useMutation();
  // Destructured so the stable `mutateAsync` can be a dep of the context values
  // below without dragging the whole (per-render) mutation object into them.
  const { mutateAsync: renameNode } = api.architecture.updateNode.useMutation();
  const updatePositions = api.architecture.updatePositions.useMutation();
  const connectNodes = api.architecture.connectNodes.useMutation();
  const { mutateAsync: editEdge } = api.architecture.updateEdge.useMutation();
  const { mutateAsync: removeEdge } = api.architecture.deleteEdge.useMutation();
  const { mutateAsync: deleteComponent } =
    api.architecture.deleteNode.useMutation();
  const { mutateAsync: restoreComponent } =
    api.architecture.restoreNode.useMutation();

  // The query cache is the re-seed mirror. EVERY write goes through this merge
  // helper so a partial update can never drop a sibling key (e.g. node edits
  // silently erasing `interiorEdges`) — the regression `getCanvas` growing a
  // second key would otherwise invite. It spreads the prior value, so callers
  // return only the slice they changed.
  const patchCanvas = useCallback(
    (patch: (prev: CanvasData) => Partial<CanvasData>) => {
      utils.architecture.getCanvas.setData(canvasInput, (old) => {
        const base: CanvasData = old ?? {
          interiorNodes: [],
          interiorEdges: [],
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
  const commitRename = useCallback(
    (id: string, title: string): void => {
      const prevTitle = utils.architecture.getCanvas
        .getData(canvasInput)
        ?.interiorNodes.find((n) => n.id === id)?.title;

      setNodes((ns) =>
        ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, title } } : n)),
      );
      patchCanvas((c) => ({
        interiorNodes: c.interiorNodes.map((n) =>
          n.id === id ? { ...n, title } : n,
        ),
      }));

      void renameNode({ id, title }).catch(() => {
        if (prevTitle !== undefined) {
          setNodes((ns) =>
            ns.map((n) =>
              n.id === id ? { ...n, data: { ...n.data, title: prevTitle } } : n,
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

  // Persist Component positions on drag-stop. Skip still-optimistic (temp_) and
  // unmoved nodes, then commit exactly ONE batched mutation — multi-select drags
  // (onSelectionDragStop) land here too. The cache mirror is updated to match;
  // failure rolls back store + cache and toasts.
  const persistPositions = useCallback(
    async (moved: ComponentNode[]) => {
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
    ],
  );

  // Remove a Connection (React Flow's Delete/Backspace). `onEdgesChange` already
  // dropped it from the store; here we mirror the removal into the cache and
  // soft-delete it server-side. A still-optimistic edge was never persisted, so
  // it just disappears. Failure re-adds the edge to both stores and toasts.
  const handleEdgesDelete = useCallback(
    (deleted: ConnectionEdge[]) => {
      const cached = utils.architecture.getCanvas.getData(canvasInput);
      for (const edge of deleted) {
        if (edge.id.startsWith("temp_")) continue;
        const prev = cached?.interiorEdges.find((e) => e.id === edge.id);
        patchCanvas((c) => ({
          interiorEdges: c.interiorEdges.filter((e) => e.id !== edge.id),
        }));
        void removeEdge({ id: edge.id }).catch(() => {
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

  // Component-detail panel: opens when the owner single-selects a real (non-
  // temp_) Component. Sourced from React Flow's selection events rather than
  // from React Flow's internal selection state so a node added optimistically
  // never auto-opens the panel before its server id arrives (ADR-0011 / Slice
  // 1 detail panel scaffold). Cleared on pane click or scope change.
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const closeDetailPanel = useCallback(() => setSelectedNodeId(null), []);

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
          n.id === id ? { ...n, data: { ...n.data, flowCount } } : n,
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
        <DescendComponentContext.Provider value={descend}>
          <DeleteComponentContext.Provider value={removeComponent}>
            <CanEditContext.Provider value={canEdit}>
              <ReactFlow<ComponentNode, ConnectionEdge>
                nodes={nodes}
                edges={edges}
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
                  if (source.startsWith("temp_") || target.startsWith("temp_")) {
                    return false;
                  }
                  return canConnect({ source, target }, []).ok;
                }}
                onEdgesDelete={handleEdgesDelete}
                onNodeClick={(_event, node) => {
                  // A `temp_…` Component has no server id yet; opening the
                  // detail panel would query for a node the server cannot
                  // find. Single-click selection only — double-click still
                  // descends.
                  if (node.id.startsWith("temp_")) return;
                  setSelectedNodeId(node.id);
                }}
                onPaneClick={() => setSelectedNodeId(null)}
                onNodeDoubleClick={(_event, node) => descend(node.id)}
                onNodeMouseEnter={(_event, node) => {
                  // Make Descent feel instant: warm the interior Canvas payload (tRPC
                  // cache, the same key the descended island reads) and the route shell.
                  if (node.id.startsWith("temp_")) return;
                  void utils.architecture.getCanvas.prefetch({
                    slug,
                    canvasNodeId: node.id,
                  });
                  router.prefetch(`/p/${slug}/n/${node.id}`);
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
                {canEdit && (
                  <Panel position="top-left">
                    <AddComponent
                      onAdd={addComponent}
                      pending={createNode.isPending}
                    />
                  </Panel>
                )}
                {canEdit && selectedNodeId !== null && (
                  <Panel
                    position="top-right"
                    className="!top-0 !right-0 !bottom-0 !m-0 flex"
                  >
                    <ComponentDetailPanel
                      slug={slug}
                      ownerNodeId={selectedNodeId}
                      onClose={closeDetailPanel}
                      onFlowCountChange={commitFlowCount}
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

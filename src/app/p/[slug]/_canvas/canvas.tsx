"use client";

import "@xyflow/react/dist/style.css";

import {
  addEdge,
  Background,
  type Connection,
  Controls,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import { Suspense, useCallback, useMemo } from "react";
import { Toaster, toast } from "sonner";

import { type EdgeDirection, type NodeKind } from "~/lib/schemas";
import { type CanvasEdge, type CanvasNode } from "~/lib/types";
import { api } from "~/trpc/react";

import { AddComponent } from "./add-component";
import {
  ComponentNodeView,
  RenameComponentContext,
  type ComponentNode,
} from "./component-node";
import {
  ConnectionEdgeView,
  EditEdgeContext,
  markersForDirection,
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

type CanvasData = { interiorNodes: CanvasNode[]; interiorEdges: CanvasEdge[] };

function toRFNode(n: CanvasNode): ComponentNode {
  return {
    id: n.id,
    type: "component",
    position: { x: n.posX, y: n.posY },
    data: {
      title: n.title,
      kind: n.kind,
      optimistic: n.id.startsWith("temp_"),
    },
  };
}

function toRFEdge(e: CanvasEdge): ConnectionEdge {
  return {
    id: e.id,
    type: "connection",
    source: e.sourceId,
    target: e.targetId,
    data: {
      label: e.label,
      direction: e.direction,
      optimistic: e.id.startsWith("temp_"),
    },
    ...markersForDirection(e.direction),
  };
}

function optimisticCanvasNode(
  id: string,
  projectId: string,
  kind: NodeKind,
  position: { x: number; y: number },
): CanvasNode {
  const now = new Date();
  return {
    id,
    projectId,
    parentId: null,
    title: "Untitled",
    kind,
    posX: position.x,
    posY: position.y,
    documentation: "",
    metadata: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

function optimisticCanvasEdge(
  id: string,
  projectId: string,
  sourceId: string,
  targetId: string,
): CanvasEdge {
  const now = new Date();
  return {
    id,
    projectId,
    canvasNodeId: null,
    sourceId,
    targetId,
    label: null,
    direction: "FORWARD",
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

function CanvasInner({ slug, projectId }: { slug: string; projectId: string }) {
  const utils = api.useUtils();
  // Stable across renders so it stays a single query key and a stable callback dep.
  const canvasInput = useMemo(() => ({ slug, canvasNodeId: null }), [slug]);
  const [{ interiorNodes, interiorEdges }] =
    api.architecture.getCanvas.useSuspenseQuery(canvasInput);

  // Seed React Flow's store ONCE from the hydrated query; thereafter the store
  // owns interaction state. The island is keyed by scope (./index), so a scope
  // change (Descent, a later slice) remounts and re-seeds rather than inheriting
  // these. Persistence flows through one batched/single mutation per gesture
  // (below), with the query cache kept in lockstep so a remount re-seeds it.
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

  // The query cache is the re-seed mirror. EVERY write goes through this merge
  // helper so a partial update can never drop a sibling key (e.g. node edits
  // silently erasing `interiorEdges`) — the regression `getCanvas` growing a
  // second key would otherwise invite. It spreads the prior value, so callers
  // return only the slice they changed.
  const patchCanvas = useCallback(
    (patch: (prev: CanvasData) => Partial<CanvasData>) => {
      utils.architecture.getCanvas.setData(canvasInput, (old) => {
        const base: CanvasData = old ?? { interiorNodes: [], interiorEdges: [] };
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
          data: { title: "Untitled", kind, optimistic: true },
        },
      ]);
      patchCanvas((c) => ({
        interiorNodes: [
          ...c.interiorNodes,
          optimisticCanvasNode(tempId, projectId, kind, position),
        ],
      }));

      try {
        const real = await createNode.mutateAsync({
          projectId,
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
    [screenToFlowPosition, projectId, setNodes, patchCanvas, createNode],
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
        changed.push({ id: n.id, prev, posX: n.position.x, posY: n.position.y });
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
            return x ? { ...n, position: { x: x.prev.posX, y: x.prev.posY } } : n;
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

  // Draw a Connection. Refuses self-links and still-optimistic (temp_) endpoints
  // (the latter have no real id to persist yet), and short-circuits an obvious
  // duplicate so the user gets instant feedback rather than a doomed round trip
  // (the server is still authoritative). Optimistic edge in store + cache mirror,
  // one connectNodes mutation, reconcile temp → real id, roll back + toast on
  // failure (a CONFLICT/BAD_REQUEST rejection rolls back the same way).
  const handleConnect = useCallback(
    async (connection: Connection) => {
      const { source, target } = connection;
      if (!source || !target || source === target) return;
      if (source.startsWith("temp_") || target.startsWith("temp_")) {
        toast.error("Finish adding that component before connecting it.");
        return;
      }
      const existing = utils.architecture.getCanvas.getData(canvasInput);
      if (
        existing?.interiorEdges.some(
          (e) => e.sourceId === source && e.targetId === target,
        )
      ) {
        toast.error("That connection already exists.");
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
            data: { label: null, direction: "FORWARD", optimistic: true },
            ...markersForDirection("FORWARD"),
          },
          es,
        ),
      );
      patchCanvas((c) => ({
        interiorEdges: [
          ...c.interiorEdges,
          optimisticCanvasEdge(tempId, projectId, source, target),
        ],
      }));

      try {
        const real = await connectNodes.mutateAsync({
          projectId,
          canvasNodeId: null,
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
    [utils, canvasInput, setEdges, patchCanvas, projectId, connectNodes],
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

  // Edit a Connection's label/direction: optimistic in store (markers re-derived
  // from the new direction) + cache mirror, one updateEdge mutation, both rolled
  // back with a toast on failure. Provided to the edges through context (below)
  // so it stays one stable reference.
  const commitEdgeEdit = useCallback(
    (
      id: string,
      patch: { label?: string | null; direction?: EdgeDirection },
    ): void => {
      const prev = utils.architecture.getCanvas
        .getData(canvasInput)
        ?.interiorEdges.find((e) => e.id === id);

      setEdges((es) =>
        es.map((e) => {
          if (e.id !== id) return e;
          const nextDirection = patch.direction ?? e.data?.direction ?? "FORWARD";
          const nextLabel =
            patch.label !== undefined ? patch.label : (e.data?.label ?? null);
          return {
            ...e,
            data: { ...e.data, label: nextLabel, direction: nextDirection },
            ...markersForDirection(nextDirection),
          };
        }),
      );
      patchCanvas((c) => ({
        interiorEdges: c.interiorEdges.map((e) =>
          e.id === id
            ? {
                ...e,
                label: patch.label !== undefined ? patch.label : e.label,
                direction: patch.direction ?? e.direction,
              }
            : e,
        ),
      }));

      void editEdge({ id, ...patch }).catch(() => {
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

  return (
    <RenameComponentContext.Provider value={commitRename}>
      <EditEdgeContext.Provider value={commitEdgeEdit}>
        <ReactFlow<ComponentNode, ConnectionEdge>
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={(c) => void handleConnect(c)}
          onEdgesDelete={handleEdgesDelete}
          onNodeDragStop={(_event, _node, dragged) =>
            void persistPositions(dragged)
          }
          onSelectionDragStop={(_event, dragged) =>
            void persistPositions(dragged)
          }
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView
        >
          <Background />
          <Controls />
          <Panel position="top-left">
            <AddComponent onAdd={addComponent} pending={createNode.isPending} />
          </Panel>
          {nodes.length === 0 && (
            <Panel position="top-center">
              <p className="mt-2 text-sm text-white/50">
                Empty canvas. Add a Component to start modeling.
              </p>
            </Panel>
          )}
        </ReactFlow>
      </EditEdgeContext.Provider>
    </RenameComponentContext.Provider>
  );
}

export default function Canvas({
  scope,
  slug,
  projectId,
}: {
  scope: string;
  slug: string;
  projectId: string;
}) {
  return (
    <ReactFlowProvider>
      <div data-canvas-scope={scope} className="h-full w-full">
        <Suspense
          fallback={<div className="h-full w-full bg-[#1b1c33]" aria-hidden />}
        >
          <CanvasInner slug={slug} projectId={projectId} />
        </Suspense>
      </div>
      <Toaster theme="dark" position="bottom-right" richColors />
    </ReactFlowProvider>
  );
}

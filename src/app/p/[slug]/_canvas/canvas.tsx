"use client";

import "@xyflow/react/dist/style.css";

import {
  Background,
  Controls,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import { Suspense, useCallback, useMemo } from "react";
import { Toaster, toast } from "sonner";

import { type NodeKind } from "~/lib/schemas";
import { type CanvasNode } from "~/lib/types";
import { api } from "~/trpc/react";

import { AddComponent } from "./add-component";
import { ComponentNodeView, type ComponentNode } from "./component-node";

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
 * New Components render optimistically with a `temp_…` id reconciled to the real
 * id on success; failures roll back and toast.
 */

// Module-level: React Flow re-mounts every node (and warns) if `nodeTypes` is a
// fresh object each render. Defining it once is the key React Flow perf guard.
const nodeTypes = { component: ComponentNodeView };

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

function CanvasInner({ slug, projectId }: { slug: string; projectId: string }) {
  const utils = api.useUtils();
  // Stable across renders so it stays a single query key and a stable callback dep.
  const canvasInput = useMemo(
    () => ({ slug, canvasNodeId: null }),
    [slug],
  );
  const [{ interiorNodes }] =
    api.architecture.getCanvas.useSuspenseQuery(canvasInput);

  // Seed React Flow's store ONCE from the hydrated query; thereafter the store
  // owns interaction state. The island is keyed by scope (./index), so a scope
  // change (Descent, a later slice) remounts and re-seeds rather than inheriting
  // these nodes. Drag is intentionally NOT persisted in this slice (issue #6).
  const [nodes, setNodes, onNodesChange] = useNodesState<ComponentNode>(
    interiorNodes.map(toRFNode),
  );
  const { screenToFlowPosition } = useReactFlow();
  const createNode = api.architecture.createNode.useMutation();

  const addComponent = useCallback(
    async (kind: NodeKind) => {
      // A client-minted temporary id, reconciled to the server id on success.
      // The `temp_` prefix is the recognizable convention #7 will use to detect
      // a still-optimistic endpoint before persisting a Connection to it.
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
      utils.architecture.getCanvas.setData(canvasInput, (old) => ({
        interiorNodes: [
          ...(old?.interiorNodes ?? []),
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
        utils.architecture.getCanvas.setData(canvasInput, (old) => ({
          interiorNodes: (old?.interiorNodes ?? []).map((n) =>
            n.id === tempId ? real : n,
          ),
        }));
      } catch {
        // Roll back both stores and tell the user (PRD: "rolls back with a toast").
        setNodes((ns) => ns.filter((n) => n.id !== tempId));
        utils.architecture.getCanvas.setData(canvasInput, (old) => ({
          interiorNodes: (old?.interiorNodes ?? []).filter(
            (n) => n.id !== tempId,
          ),
        }));
        toast.error("Couldn’t add the component. Please try again.");
      }
    },
    [screenToFlowPosition, projectId, setNodes, utils, createNode, canvasInput],
  );

  return (
    <ReactFlow
      nodes={nodes}
      onNodesChange={onNodesChange}
      nodeTypes={nodeTypes}
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

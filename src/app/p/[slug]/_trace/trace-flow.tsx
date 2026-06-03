"use client";

import "@xyflow/react/dist/style.css";

import {
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import Link from "next/link";
import { AlertTriangle, ArrowUpRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ComponentDetailPanel } from "~/app/p/[slug]/_canvas/component-detail-panel";
import type { TraceView, TraceViewNode } from "~/lib/types";

import { layoutTrace } from "./trace-layout";
import { TraceConnectionEdgeView } from "./trace-edge";
import { TraceComponentNodeView } from "./trace-node";

// Module-level so React Flow doesn't re-mount every node/edge each render (the
// key perf guard, mirrors the canvas island).
const nodeTypes = { "trace-component": TraceComponentNodeView };
const edgeTypes = { "trace-connection": TraceConnectionEdgeView };

/**
 * The read-only cross-layer **Trace view** render (#58, ADR-0034): every on-path
 * Component and Connection of the Trace subgraph, expanded across all layers at
 * once as dagre-laid-out nested React Flow boxes. Read-only for EVERYONE (even
 * the owner) — no drag, no connect, no delete, no edit handlers wired; clicking a
 * leaf Component opens the existing read-only detail panel with a "Go to canvas"
 * jump to that Component's real layer.
 *
 * A separate React tree from the canvas island, so it owns its own
 * `ReactFlowProvider`. Domain types come from `~/lib` via top-level `import type`
 * (ADR-0004); dagre is imported only inside `trace-layout` so it stays in this
 * lazy chunk.
 */
export function TraceFlow({ slug, data }: { slug: string; data: TraceView }) {
  return (
    <ReactFlowProvider>
      <TraceFlowInner slug={slug} data={data} />
    </ReactFlowProvider>
  );
}

function TraceFlowInner({ slug, data }: { slug: string; data: TraceView }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { fitView } = useReactFlow();

  const byId = useMemo(() => {
    const map = new Map<string, TraceViewNode>();
    for (const node of data.nodes) map.set(node.id, node);
    return map;
  }, [data.nodes]);

  const { rfNodes, rfEdges, bounds } = useMemo(
    () => layoutTrace(data.nodes, data.edges),
    [data.nodes, data.edges],
  );

  const onNodeClick = useCallback(
    (_event: React.MouseEvent, node: { id: string }) => {
      // Only leaf Components open the panel; a container box is structural.
      if (byId.get(node.id)) setSelectedId(node.id);
    },
    [byId],
  );

  // The flow mounts inside an `ssr:false` island whose host box settles AFTER
  // mount, so React Flow's eager `fitView` can land against a 0-size viewport and
  // never re-fit. A `ResizeObserver` re-runs `fitView` whenever the host resizes
  // (fitting never changes the host size, so this can't loop), and the `bounds`
  // dependency re-fits when a new derivation produces a different subgraph.
  const { width: boundsW, height: boundsH } = bounds;
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host || boundsW === 0 || boundsH === 0) return;
    const fit = () => void fitView({ padding: 0.12 });
    const observer = new ResizeObserver(() => fit());
    observer.observe(host);
    fit();
    return () => observer.disconnect();
  }, [fitView, boundsW, boundsH]);

  const selected = selectedId ? byId.get(selectedId) : undefined;
  const parentKind =
    selected?.parentId != null
      ? (byId.get(selected.parentId)?.kind ?? null)
      : null;

  return (
    <div ref={hostRef} className="relative h-full w-full">
      {data.truncated && data.warning && (
        <div className="absolute top-2 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded border border-amber-400/30 bg-amber-400/10 px-3 py-1.5 text-xs text-amber-200">
          <AlertTriangle size={13} aria-hidden />
          {data.warning}
        </div>
      )}

      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        deleteKeyCode={null}
        onNodeClick={onNodeClick}
        minZoom={0.05}
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>

      {selected && (
        <div className="pointer-events-none absolute top-0 right-0 bottom-0 flex">
          <div className="pointer-events-auto flex flex-col">
            <ComponentDetailPanel
              readOnly
              ownerNodeId={selected.id}
              slug={slug}
              currentKind={selected.kind}
              parentKind={parentKind}
              initialDocumentation={selected.documentation}
              onClose={() => setSelectedId(null)}
            />
            <Link
              href={
                selected.parentId
                  ? `/p/${slug}/n/${selected.parentId}`
                  : `/p/${slug}`
              }
              className="mx-4 mb-4 flex items-center justify-center gap-1.5 rounded bg-[hsl(280,100%,70%)]/20 px-3 py-2 text-xs font-medium text-[hsl(280,100%,85%)] transition hover:bg-[hsl(280,100%,70%)]/30"
            >
              <ArrowUpRight size={13} aria-hidden />
              Go to canvas
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

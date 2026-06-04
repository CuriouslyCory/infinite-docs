import * as dagre from "@dagrejs/dagre";
import type { GraphLabel, NodeLabel, EdgeLabel } from "@dagrejs/dagre";
import { MarkerType } from "@xyflow/react";

import { arrowEnds } from "~/lib/connection-direction";
import type { TraceViewEdge, TraceViewNode } from "~/lib/types";

/**
 * Client-only dagre layout for the cross-layer **Trace view** (#58, ADR-0034).
 *
 * dagre — not elkjs: the nesting is a strict `parentId` tree we already own, so
 * we lay out each scope's siblings with dagre and size each parent container to
 * its children's bounding box ourselves (no compound-graph auto-nesting needed).
 * dagre is synchronous and far leaner than elk's worker bundle — both matter for
 * a lazily-loaded island (perf philosophy #1). dagre is imported ONLY here, never
 * in `~/lib`/`~/server`, so it stays inside the trace island's lazy chunk
 * (ADR-0004).
 */

export type TraceFlowNodeData = {
  title: string;
  kind: TraceViewNode["kind"];
  /** A container box (has on-path children) vs a leaf Component. Containers are
   *  laid out around their children; leaves carry the click-to-open detail. */
  isContainer: boolean;
  isTracePoint: boolean;
};

export type TraceFlowNode = {
  id: string;
  type: "trace-component";
  position: { x: number; y: number };
  data: TraceFlowNodeData;
  draggable: false;
  selectable: boolean;
  width: number;
  height: number;
  zIndex: number;
  style?: Record<string, string | number>;
};

export type TraceFlowEdge = {
  id: string;
  type: "trace-connection";
  source: string;
  target: string;
  markerStart?: { type: MarkerType };
  markerEnd?: { type: MarkerType };
  data: { label?: string; interaction: TraceViewEdge["interaction"] };
};

const ARROW = { type: MarkerType.ArrowClosed } as const;

const LEAF_W = 180;
const LEAF_H = 44;
const CONTAINER_PAD = 28;
const CONTAINER_HEADER = 26;
const RANK_SEP = 60;
const NODE_SEP = 36;

interface SizedBox {
  w: number;
  h: number;
}

/**
 * Lays out the Trace subgraph as nested React Flow parent/child boxes. Children
 * are grouped by `parentId`; each scope's siblings are run through one dagre
 * pass (left-to-right), then every container is sized to its laid-out children's
 * bounding box and its children are offset to parent-relative coordinates. The
 * recursion proceeds bottom-up so a container's size is known before it is
 * placed among its own siblings.
 */
export interface TraceLayout {
  rfNodes: TraceFlowNode[];
  rfEdges: TraceFlowEdge[];
  /** The overall content bounding box (top-level coords). The render fits THIS
   *  explicitly via `fitBounds`, sidestepping React Flow's nested-node measure
   *  race that leaves `fitView` zoomed onto a stale sub-region. */
  bounds: { x: number; y: number; width: number; height: number };
}

export function layoutTrace(
  nodes: TraceViewNode[],
  edges: TraceViewEdge[],
): TraceLayout {
  if (nodes.length === 0) {
    return {
      rfNodes: [],
      rfEdges: [],
      bounds: { x: 0, y: 0, width: 0, height: 0 },
    };
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  // Only treat a `parentId` as a real container link when the parent is itself
  // in the subgraph; otherwise the node is a root of this view.
  const childrenOf = new Map<string | null, TraceViewNode[]>();
  for (const node of nodes) {
    const parent =
      node.parentId !== null && byId.has(node.parentId) ? node.parentId : null;
    (childrenOf.get(parent) ?? childrenOf.set(parent, []).get(parent)!).push(
      node,
    );
  }
  const hasChildren = (id: string) => (childrenOf.get(id)?.length ?? 0) > 0;

  // Edges grouped by the common parent scope of their endpoints, so each scope's
  // dagre pass sees the intra-scope connections that should drive its ordering.
  const scopeParent = (id: string): string | null => {
    const p = byId.get(id)?.parentId;
    return p !== undefined && p !== null && byId.has(p) ? p : null;
  };
  const edgesInScope = new Map<string | null, TraceViewEdge[]>();
  for (const edge of edges) {
    const sp = scopeParent(edge.sourceId);
    const tp = scopeParent(edge.targetId);
    const scope = sp === tp ? sp : null;
    (edgesInScope.get(scope) ?? edgesInScope.set(scope, []).get(scope)!).push(
      edge,
    );
  }

  const sizeOf = new Map<string, SizedBox>();
  const childRelPos = new Map<string, { x: number; y: number }>();
  const scopeRootPos = new Map<
    string | null,
    Map<string, { x: number; y: number }>
  >();

  /** Lay out one scope's direct children; returns the scope's bounding size. */
  const layoutScope = (scopeId: string | null): SizedBox => {
    const children = childrenOf.get(scopeId) ?? [];
    if (children.length === 0) return { w: 0, h: 0 };

    const g: dagre.graphlib.Graph<GraphLabel, NodeLabel, EdgeLabel> =
      new dagre.graphlib.Graph();
    g.setGraph({ rankdir: "LR", ranksep: RANK_SEP, nodesep: NODE_SEP });
    g.setDefaultEdgeLabel(() => ({}));

    for (const child of children) {
      let box: SizedBox = { w: LEAF_W, h: LEAF_H };
      if (hasChildren(child.id)) {
        const inner = layoutScope(child.id);
        box = {
          w: inner.w + CONTAINER_PAD * 2,
          h: inner.h + CONTAINER_PAD + CONTAINER_HEADER,
        };
      }
      sizeOf.set(child.id, box);
      g.setNode(child.id, { width: box.w, height: box.h });
    }
    const childSet = new Set(children.map((c) => c.id));
    for (const edge of edgesInScope.get(scopeId) ?? []) {
      if (childSet.has(edge.sourceId) && childSet.has(edge.targetId)) {
        g.setEdge(edge.sourceId, edge.targetId);
      }
    }

    dagre.layout(g);

    let maxX = 0;
    let maxY = 0;
    const positions = new Map<string, { x: number; y: number }>();
    for (const child of children) {
      const box = sizeOf.get(child.id)!;
      const point = g.node(child.id);
      // dagre centers nodes; convert to top-left, then to parent-relative coords
      // (offset by the container's pad + header below).
      const x = (point.x ?? 0) - box.w / 2;
      const y = (point.y ?? 0) - box.h / 2;
      positions.set(child.id, { x, y });
      maxX = Math.max(maxX, x + box.w);
      maxY = Math.max(maxY, y + box.h);
    }
    // Normalize to a zero origin and store parent-relative positions.
    let minX = Infinity;
    let minY = Infinity;
    for (const { x, y } of positions.values()) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
    }
    if (scopeId === null) {
      const rootPos = new Map<string, { x: number; y: number }>();
      for (const [id, p] of positions) {
        rootPos.set(id, { x: p.x - minX, y: p.y - minY });
      }
      scopeRootPos.set(null, rootPos);
    } else {
      for (const [id, p] of positions) {
        childRelPos.set(id, {
          x: p.x - minX + CONTAINER_PAD,
          y: p.y - minY + CONTAINER_HEADER,
        });
      }
    }
    return { w: maxX - minX, h: maxY - minY };
  };

  const rootSize = layoutScope(null);

  // Resolve every node to ABSOLUTE world coordinates by accumulating the
  // scope-relative offsets up the `parentId` chain. We deliberately do NOT use
  // React Flow's parent-relative nodes (`parentId` + `extent`): with measured
  // container sizes RF re-derives child positions from its own (post-paint)
  // measurements, which fights our exact dagre layout and breaks `fitView`.
  // Absolute coords + an explicit depth `zIndex` (so containers paint behind
  // their children) give a deterministic, fit-able layout.
  const parentOf = (id: string): string | null => {
    const p = byId.get(id)?.parentId;
    return p !== undefined && p !== null && byId.has(p) ? p : null;
  };
  const depthOf = (id: string): number => {
    let d = 0;
    let cur = parentOf(id);
    while (cur !== null && d < 256) {
      d++;
      cur = parentOf(cur);
    }
    return d;
  };
  const absPos = new Map<string, { x: number; y: number }>();
  const resolveAbs = (id: string): { x: number; y: number } => {
    const cached = absPos.get(id);
    if (cached) return cached;
    const parent = parentOf(id);
    const local =
      parent === null
        ? (scopeRootPos.get(null)?.get(id) ?? { x: 0, y: 0 })
        : (childRelPos.get(id) ?? { x: 0, y: 0 });
    const base = parent === null ? { x: 0, y: 0 } : resolveAbs(parent);
    const pos = { x: base.x + local.x, y: base.y + local.y };
    absPos.set(id, pos);
    return pos;
  };

  const rfNodes: TraceFlowNode[] = [];
  for (const node of nodes) {
    const box = sizeOf.get(node.id) ?? { w: LEAF_W, h: LEAF_H };
    rfNodes.push({
      id: node.id,
      type: "trace-component",
      position: resolveAbs(node.id),
      data: {
        title: node.title,
        kind: node.kind,
        isContainer: hasChildren(node.id),
        isTracePoint: node.isTracePoint,
      },
      draggable: false,
      selectable: !hasChildren(node.id),
      width: box.w,
      height: box.h,
      zIndex: depthOf(node.id),
      style: { width: box.w, height: box.h },
    });
  }

  const present = new Set(nodes.map((n) => n.id));
  const rfEdges: TraceFlowEdge[] = edges
    .filter((e) => present.has(e.sourceId) && present.has(e.targetId))
    .map((e) => {
      const ends = arrowEnds(e.interaction);
      return {
        id: e.id,
        type: "trace-connection" as const,
        source: e.sourceId,
        target: e.targetId,
        ...(ends.atSource ? { markerStart: ARROW } : {}),
        ...(ends.atTarget ? { markerEnd: ARROW } : {}),
        data: {
          ...(e.label ? { label: e.label } : {}),
          interaction: e.interaction,
        },
      };
    });

  return {
    rfNodes,
    rfEdges,
    bounds: { x: 0, y: 0, width: rootSize.w, height: rootSize.h },
  };
}

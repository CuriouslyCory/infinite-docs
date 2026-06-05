"use client";

import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";

import type { Interaction } from "~/lib/schemas";

export type TraceConnectionEdgeData = {
  label?: string;
  interaction: Interaction;
};

export type TraceConnectionEdge = Edge<
  TraceConnectionEdgeData,
  "trace-connection"
>;

/**
 * The read-only Connection edge for the cross-layer **Trace view** (#58). A thin,
 * self-contained edge — it does NOT reuse the canvas `ConnectionEdgeView`, whose
 * label/interaction editing rides canvas-only contexts the Trace view must not
 * expose. Arrowheads are computed from the interaction via `arrowEnds` in the
 * layout (ADR-0027) and forwarded straight through `BaseEdge` as resolved marker
 * urls; the label renders as plain text (untrusted user content, CONTEXT.md).
 * Domain types come from `~/lib` (ADR-0004).
 */
export function TraceConnectionEdgeView({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerStart,
  markerEnd,
  data,
}: EdgeProps<TraceConnectionEdge>) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  return (
    <>
      <BaseEdge
        path={edgePath}
        markerStart={markerStart}
        markerEnd={markerEnd}
      />
      {data?.label && (
        <EdgeLabelRenderer>
          <div
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
            className="pointer-events-none absolute rounded bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground"
          >
            {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

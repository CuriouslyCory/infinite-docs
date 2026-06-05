"use client";

import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { Route } from "lucide-react";

import { KIND_ICON } from "~/lib/node-kinds";

import type { TraceFlowNodeData } from "./trace-layout";

export type TraceComponentNode = Node<TraceFlowNodeData, "trace-component">;

/**
 * The read-only Component node for the cross-layer **Trace view** (#58). A
 * deliberately thin, self-contained presentational node — it does NOT reuse the
 * canvas `ComponentNodeView`, which carries rename/delete/descent/trace-toggle
 * affordances and canvas-only contexts the Trace view must not expose
 * (read-only for everyone, even the owner, ADR-0034).
 *
 * A container (a Component with on-path children) renders as a labelled box that
 * the nested children sit inside; a leaf renders as a compact card. `title` is
 * untrusted user content rendered as plain text (prompt-injection standing note,
 * CONTEXT.md). Domain types come from `~/lib` (ADR-0004).
 */
export function TraceComponentNodeView({
  data,
}: NodeProps<TraceComponentNode>) {
  const Icon = KIND_ICON[data.kind];

  if (data.isContainer) {
    return (
      <div
        className={`h-full w-full rounded-lg border bg-foreground/[0.03] ${
          data.isTracePoint ? "border-primary" : "border-border"
        }`}
      >
        <div className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-muted-foreground">
          <Icon size={12} aria-hidden className="text-primary" />
          <span className="max-w-[14rem] truncate">{data.title}</span>
          {data.isTracePoint && (
            <Route
              size={11}
              aria-hidden
              className="ml-auto text-primary"
            />
          )}
        </div>
        <Handle
          type="target"
          position={Position.Left}
          className="h-2! w-2! border-foreground/40! bg-foreground/60!"
        />
        <Handle
          type="source"
          position={Position.Right}
          className="h-2! w-2! border-foreground/40! bg-foreground/60!"
        />
      </div>
    );
  }

  return (
    <div
      className={`relative flex h-full w-full items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm text-foreground shadow-lg ${
        data.isTracePoint ? "border-primary" : "border-border"
      }`}
    >
      {data.isTracePoint && (
        <span
          aria-label="Trace point"
          title="Trace point"
          className="absolute -top-2 -right-2 flex h-5 w-5 items-center justify-center rounded-full border border-border bg-primary text-foreground shadow"
        >
          <Route size={11} aria-hidden />
        </span>
      )}
      <Handle
        type="target"
        position={Position.Left}
        className="h-2! w-2! border-foreground/40! bg-foreground/60!"
      />
      <Icon
        size={16}
        aria-hidden
        className="shrink-0 text-primary"
      />
      <span className="max-w-[12rem] truncate">{data.title}</span>
      <Handle
        type="source"
        position={Position.Right}
        className="h-2! w-2! border-foreground/40! bg-foreground/60!"
      />
    </div>
  );
}

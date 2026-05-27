"use client";

import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";
import { createContext, useContext, useRef, useState } from "react";

export type ConnectionEdgeData = {
  /** Untrusted user content — rendered as plain text, never markup. */
  label: string | null;
  /** True while a freshly-drawn Connection awaits its server id (a `temp_…` id). */
  optimistic?: boolean;
};

export type ConnectionEdge = Edge<ConnectionEdgeData, "connection">;

/**
 * The Canvas island supplies the Connection label-commit through this context
 * rather than baking a callback into each edge's `data`, so the edge stays a
 * pure presentational component and React Flow never re-renders every edge when
 * the island re-renders mid-interaction (the same discipline as
 * `RenameComponentContext` for Components). The default is inert.
 */
export const EditEdgeContext = createContext<
  (id: string, label: string | null) => void
>(() => undefined);

/**
 * The Connection edge type for the Canvas — renders the Edge path with a single
 * structural arrowhead at the target (input Port) plus an editable label at the
 * midpoint. Registered under the `edgeTypes` key `connection`. The arrowhead is
 * supplied as the `markerEnd` on the edge object (a Connection's direction is
 * structural — output Port → input Port; CONTEXT.md "Port"; ADR-0009), and
 * React Flow resolves it to the marker url forwarded here.
 *
 * Client-only: domain types come from `~/lib` (never `~/server` or the generated
 * Prisma client), so the server graph stays out of the browser bundle (ADR-0004).
 * `label` is untrusted user content rendered as plain text — never as markup or
 * instructions (prompt-injection standing note, CONTEXT.md).
 */
export function ConnectionEdgeView({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  data,
  selected,
}: EdgeProps<ConnectionEdge>) {
  // React Flow types an edge's `data` as optional; every edge we create carries
  // it, so normalize once to a concrete value rather than guarding each read.
  const d: ConnectionEdgeData = data ?? { label: null };
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const onEdit = useContext(EditEdgeContext);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(d.label ?? "");
  // Enter commits, then blurs the unmounting input — which would fire a second
  // commit; this latch makes commit/cancel idempotent for one edit session.
  const settled = useRef(false);

  // A `temp_…` Connection has no real id to address yet, so it cannot be edited.
  const canEdit = !d.optimistic;
  const hasLabel = d.label !== null && d.label.length > 0;

  function beginEditing() {
    if (!canEdit) return;
    settled.current = false;
    setDraft(d.label ?? "");
    setEditing(true);
  }

  function commit() {
    if (settled.current) return;
    settled.current = true;
    setEditing(false);
    const next = draft.trim();
    const nextLabel = next.length > 0 ? next : null;
    if (nextLabel !== (d.label ?? null)) {
      onEdit(id, nextLabel);
    }
  }

  function cancel() {
    settled.current = true;
    setEditing(false);
  }

  return (
    <>
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} />
      {(hasLabel || editing || selected) && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: "all",
            }}
            className="nodrag nopan flex items-center gap-1"
          >
            {editing ? (
              <input
                className="nodrag w-[10rem] rounded bg-white/10 px-1 py-0.5 text-xs text-white outline-none"
                aria-label="Label connection"
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onFocus={(e) => e.currentTarget.select()}
                onBlur={commit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commit();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    cancel();
                  }
                }}
              />
            ) : hasLabel ? (
              <span
                className="max-w-[12rem] truncate rounded bg-[#1f2138] px-1.5 py-0.5 text-xs text-white shadow"
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  beginEditing();
                }}
                title={canEdit ? "Double-click to edit label" : undefined}
              >
                {d.label}
              </span>
            ) : (
              selected &&
              canEdit && (
                <button
                  type="button"
                  className="rounded bg-white/10 px-1.5 py-0.5 text-xs text-white/70 transition hover:text-white"
                  onClick={(e) => {
                    e.stopPropagation();
                    beginEditing();
                  }}
                >
                  + label
                </button>
              )
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

"use client";

import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  MarkerType,
  type Edge,
  type EdgeMarker,
  type EdgeProps,
} from "@xyflow/react";
import { createContext, useContext, useRef, useState } from "react";

import { type EdgeDirection } from "~/lib/schemas";

export type ConnectionEdgeData = {
  /** Untrusted user content — rendered as plain text, never markup. */
  label: string | null;
  direction: EdgeDirection;
  /** True while a freshly-drawn Connection awaits its server id (a `temp_…` id). */
  optimistic?: boolean;
};

export type ConnectionEdge = Edge<ConnectionEdgeData, "connection">;

/**
 * The Canvas island supplies the Connection edit-commit through this context
 * rather than baking a callback into each edge's `data`, so the edge stays a
 * pure presentational component and React Flow never re-renders every edge when
 * the island re-renders mid-interaction (the same discipline as
 * `RenameComponentContext` for Components). The default is inert.
 */
export const EditEdgeContext = createContext<
  (id: string, patch: { label?: string | null; direction?: EdgeDirection }) => void
>(() => undefined);

/**
 * Translates a Connection's cosmetic `direction` into React Flow edge markers
 * (CONTEXT.md "Edge direction"): FORWARD draws an arrowhead at the target,
 * BIDIRECTIONAL at both ends, NONE draws a plain line. Used both when seeding an
 * edge from server data and when a direction edit is applied optimistically, so
 * the two never drift.
 */
export function markersForDirection(direction: EdgeDirection): {
  markerStart?: EdgeMarker;
  markerEnd?: EdgeMarker;
} {
  const arrow: EdgeMarker = { type: MarkerType.ArrowClosed };
  switch (direction) {
    case "FORWARD":
      return { markerEnd: arrow };
    case "BIDIRECTIONAL":
      return { markerStart: arrow, markerEnd: arrow };
    case "NONE":
      return {};
  }
}

const DIRECTION_GLYPH: Record<EdgeDirection, string> = {
  NONE: "—",
  FORWARD: "→",
  BIDIRECTIONAL: "↔",
};

const DIRECTION_LABEL: Record<EdgeDirection, string> = {
  NONE: "Undirected",
  FORWARD: "Directed",
  BIDIRECTIONAL: "Bidirectional",
};

/**
 * The Connection edge type for the Canvas — renders the Edge path (with
 * direction-derived arrowheads supplied on the edge object) plus an editable
 * label at the midpoint. Registered under the `edgeTypes` key `connection`.
 *
 * Client-only: the direction type comes from `~/lib` (never `~/server` or the
 * generated Prisma client), so the server graph stays out of the browser bundle
 * (ADR-0004). `label` is untrusted user content rendered as plain text — never
 * as markup or instructions (prompt-injection standing note, CONTEXT.md).
 */
export function ConnectionEdgeView({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerStart,
  markerEnd,
  data,
  selected,
}: EdgeProps<ConnectionEdge>) {
  // React Flow types an edge's `data` as optional; every edge we create carries
  // it, so normalize once to a concrete value rather than guarding each read.
  const d: ConnectionEdgeData = data ?? { label: null, direction: "FORWARD" };
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
      onEdit(id, { label: nextLabel });
    }
  }

  function cancel() {
    settled.current = true;
    setEditing(false);
  }

  function cycleDirection() {
    if (!canEdit) return;
    const order: EdgeDirection[] = ["FORWARD", "BIDIRECTIONAL", "NONE"];
    const next = order[(order.indexOf(d.direction) + 1) % order.length]!;
    onEdit(id, { direction: next });
  }

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerStart={markerStart}
        markerEnd={markerEnd}
      />
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
            ) : (
              <>
                {hasLabel ? (
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
                {selected && canEdit && (
                  <button
                    type="button"
                    className="rounded bg-white/10 px-1.5 py-0.5 text-xs text-white/70 transition hover:text-white"
                    onClick={(e) => {
                      e.stopPropagation();
                      cycleDirection();
                    }}
                    title={`${DIRECTION_LABEL[d.direction]} — click to change`}
                  >
                    {DIRECTION_GLYPH[d.direction]}
                  </button>
                )}
              </>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

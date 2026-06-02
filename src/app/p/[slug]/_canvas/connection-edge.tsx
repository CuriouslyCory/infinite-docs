"use client";

import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";
import { createContext, useContext, useRef, useState } from "react";

import {
  INTERACTION_HINT,
  INTERACTION_LABEL,
  INTERACTION_ORDER,
} from "~/lib/interactions";
import { type Interaction } from "~/lib/schemas";

import { CanEditContext } from "./component-node";

export type ConnectionEdgeData = {
  /** Untrusted user content — rendered as plain text, never markup. */
  label: string | null;
  /** The Connection's interaction — drives the derived arrowheads (ADR-0027). */
  interaction: Interaction;
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
 * The Canvas island supplies the interaction upgrade through this context — the
 * same discipline `EditEdgeContext` uses for the label, kept as its own context
 * (one concern per context, mirroring the rename/delete/descent split). The
 * default is inert. The picker upgrades the interaction of an EXISTING Connection;
 * draw order is never touched, so the arrow points the way it was drawn (ADR-0027).
 */
export const SetEdgeInteractionContext = createContext<
  (id: string, interaction: Interaction) => void
>(() => undefined);

/**
 * The Connection edge type for the Canvas — renders the Edge path (with the
 * interaction-derived arrowheads) plus, at the midpoint, the editable label and —
 * when selected and editable — the interaction picker. Registered under the
 * `edgeTypes` key `connection`. The arrowheads (`markerStart` / `markerEnd`) are
 * computed in the island's `toRFEdge` from the canonical `arrowEnds` helper
 * (ADR-0027) and forwarded straight through `BaseEdge`; this component never
 * derives a marker itself.
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
  markerStart,
  markerEnd,
  data,
  selected,
}: EdgeProps<ConnectionEdge>) {
  // React Flow types an edge's `data` as optional; every edge we create carries
  // it, so normalize once to a concrete value rather than guarding each read.
  const d: ConnectionEdgeData = data ?? {
    label: null,
    interaction: "ASSOCIATION",
  };
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const onEdit = useContext(EditEdgeContext);
  const onSetInteraction = useContext(SetEdgeInteractionContext);
  const canEditCanvas = useContext(CanEditContext);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(d.label ?? "");
  // Enter commits, then blurs the unmounting input — which would fire a second
  // commit; this latch makes commit/cancel idempotent for one edit session.
  const settled = useRef(false);

  // A `temp_…` Connection has no real id to address yet, so it cannot be edited;
  // non-owners (canEditCanvas = false) get no edit affordances either, mirroring
  // the rename/delete gating in component-node.tsx. The label still renders for
  // viewers — only editing is gated.
  const canEdit = !d.optimistic && canEditCanvas;
  const isSelected = selected ?? false;
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
      <BaseEdge
        id={id}
        path={edgePath}
        markerStart={markerStart}
        markerEnd={markerEnd}
      />
      {(hasLabel || editing || isSelected) && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: "all",
            }}
            className="nodrag nopan flex flex-col items-center gap-1"
          >
            <div className="flex items-center gap-1">
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
                isSelected &&
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
            {/* Interaction picker — an inline segmented control offered only on a
                selected, editable Connection (viewers see arrowheads but no
                picker). Selecting a value upgrades the Connection's interaction
                in place; draw order is preserved, so a directional value points
                the arrow the way it was drawn (ADR-0027). Labelled "Interaction",
                never "type". */}
            {isSelected && canEdit && (
              <div
                role="group"
                aria-label="Interaction"
                className="flex items-center gap-0.5 rounded bg-[#1f2138] p-0.5 shadow"
              >
                {INTERACTION_ORDER.map((value) => {
                  const active = d.interaction === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={active}
                      title={INTERACTION_HINT[value]}
                      className={`rounded px-1.5 py-0.5 text-xs transition ${
                        active
                          ? "bg-white/20 text-white"
                          : "text-white/60 hover:text-white"
                      }`}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!active) onSetInteraction(id, value);
                      }}
                    >
                      {INTERACTION_LABEL[value]}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

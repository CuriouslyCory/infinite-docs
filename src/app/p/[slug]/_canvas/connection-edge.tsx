"use client";

import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";
import { createContext, useContext, useRef, useState } from "react";

import { CanEditContext } from "./component-node";
import { RouteFlowPopover } from "./route-flow-popover";

/**
 * Per-Edge Flow aggregation surfaced through `edge.data` for the
 * "N / M routed" pill and the "+ flow" affordance. Mirrors the server's
 * `EdgeFlowsEntry` (node.service.ts); kept as a structural type so the
 * Connection edge stays client-only (no server imports — ADR-0004).
 */
export type ConnectionEdgeFlows = {
  edgeId: string;
  total: number;
  routed: number;
  unrouted: number;
  orphan: number;
  byKind: Partial<Record<string, number>>;
};

/**
 * Per-endpoint metadata the "+ flow" popover needs — the source/target Node
 * ids (to fetch each endpoint's Flow palette) and the slug (to read via the
 * capability — ADR-0002). Surfaced through `edge.data` so the edge view stays
 * pure presentational and React Flow does not re-render every edge when the
 * island re-renders.
 */
export type ConnectionEdgeEndpoints = {
  slug: string;
  sourceId: string;
  sourceTitle: string;
  targetId: string;
  targetTitle: string;
};

export type ConnectionEdgeData = {
  /** Untrusted user content — rendered as plain text, never markup. */
  label: string | null;
  /** True while a freshly-drawn Connection awaits its server id (a `temp_…` id). */
  optimistic?: boolean;
  /**
   * Aggregated Flow counts for this Edge (Slice 2). Undefined on cold-cache
   * frames before `getCanvas` has resolved once — the pill and affordance
   * render only when this is populated and the relevant count > 0.
   */
  edgeFlows?: ConnectionEdgeFlows;
  /** Endpoint metadata for the "+ flow" popover (Slice 2). */
  endpoints?: ConnectionEdgeEndpoints;
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
 * Polymorphic "route / unroute" dispatch the Canvas island supplies. One
 * context, two ops — the consumer is one surface ("+ flow" affordance and
 * the routed-list inspector), with the same authz gate (`CanEditContext`).
 * Mirrors `EditEdgeContext`'s single-callback shape rather than splitting
 * into RouteFlow / UnrouteFlow contexts (Slice 2 architectural decision —
 * see the plan file).
 */
export type RouteFlowAction =
  | { kind: "route"; flowId: string; outerEdgeId: string }
  | { kind: "unroute"; flowRouteId: string; outerEdgeId: string };

export const RouteFlowContext = createContext<(action: RouteFlowAction) => void>(
  () => undefined,
);

/**
 * The Connection edge type for the Canvas — renders the Edge path with a single
 * structural arrowhead at the target (input Port) plus an editable label at the
 * midpoint. Registered under the `edgeTypes` key `connection`. The arrowhead is
 * supplied as the `markerEnd` on the edge object (a Connection's direction is
 * structural — output Port → input Port; CONTEXT.md "Port"; ADR-0009), and
 * React Flow resolves it to the marker url forwarded here.
 *
 * Slice 2 adds two midpoint adornments alongside the label:
 *   - The **"N / M routed"** pill when `edgeFlows.routed > 0`, signaling
 *     how many of the available endpoint Flows ride this Connection.
 *   - The **"+ flow"** button when selected & owner & `unrouted > 0`,
 *     opening a popover of unrouted Flows from either endpoint.
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
  const canEditCanvas = useContext(CanEditContext);
  const [editing, setEditing] = useState(false);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [draft, setDraft] = useState(d.label ?? "");
  // Enter commits, then blurs the unmounting input — which would fire a second
  // commit; this latch makes commit/cancel idempotent for one edit session.
  const settled = useRef(false);

  // A `temp_…` Connection has no real id to address yet, so it cannot be edited;
  // non-owners (canEditCanvas = false) get no edit affordances either, mirroring
  // the rename/delete gating in component-node.tsx. The label still renders for
  // viewers — only editing is gated.
  const canEdit = !d.optimistic && canEditCanvas;
  const hasLabel = d.label !== null && d.label.length > 0;

  // Slice 2 pill / "+ flow" gating. The pill is read-only and shows for
  // viewers too; the "+ flow" button is owner-only.
  const flows = d.edgeFlows;
  const hasRouted = (flows?.routed ?? 0) > 0;
  const hasUnrouted = (flows?.unrouted ?? 0) > 0;
  const showFlowButton = canEdit && hasUnrouted && d.endpoints !== undefined;

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
      {(hasLabel || editing || (selected ?? false) || hasRouted) && (
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
              {hasRouted && flows && (
                <span
                  aria-label={`${flows.routed} of ${flows.total} flows routed`}
                  title={`${flows.routed} of ${flows.total} flows routed`}
                  className="shrink-0 rounded-full bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300"
                >
                  {flows.routed} / {flows.total} routed
                </span>
              )}
              {showFlowButton && !editing && (
                <button
                  type="button"
                  aria-label="Route a flow on this connection"
                  className="rounded bg-white/10 px-1.5 py-0.5 text-xs text-white/70 transition hover:text-white"
                  onClick={(e) => {
                    e.stopPropagation();
                    setPopoverOpen((open) => !open);
                  }}
                >
                  + flow
                </button>
              )}
            </div>
            {popoverOpen && d.endpoints && (
              <RouteFlowPopover
                outerEdgeId={id}
                endpoints={d.endpoints}
                onClose={() => setPopoverOpen(false)}
              />
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

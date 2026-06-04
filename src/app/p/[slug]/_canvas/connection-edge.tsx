"use client";

import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  useStore,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";
import { createContext, useContext, useRef, useState } from "react";

import { Popover, PopoverPanel, PopoverTrigger } from "~/components/ui/popover";
import { Tooltip, TooltipPanel, TooltipTrigger } from "~/components/ui/tooltip";
import {
  INTERACTION_GLYPH,
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
  const [hovered, setHovered] = useState(false);
  const [draft, setDraft] = useState(d.label ?? "");
  // A boolean "is any edge selected" — not the selected id — so this flips
  // false↔true once per selection change and every edge re-renders on the
  // transition, not per pixel (performance-above-all; ADR-0039). It powers the
  // sibling-recede: when some OTHER edge is active, this one's label dims.
  const anyEdgeSelected = useStore((s) => s.edges.some((e) => e.selected));
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

  const Glyph = INTERACTION_GLYPH[d.interaction];
  const isDirectional = Glyph !== null;
  // The focused edge — hovered or selected — reads loud; everything else stays
  // quiet. Hover overrides recede so pointing at a dimmed sibling lifts it back.
  const active = hovered || isSelected;
  const recede = anyEdgeSelected && !isSelected && !hovered;
  // Labels render as flat siblings in ONE shared EdgeLabelRenderer portal, so
  // React Flow's edge zIndex / elevateEdgesOnSelect (they raise the SVG group,
  // not the label) can't lift the active one — plain CSS z-index on this div is
  // the only lever (ADR-0039).
  const zIndex = isSelected ? 40 : hovered ? 30 : 1;
  // Empty + plain ASSOCIATION stays bare at rest (nothing to show); a directional
  // edge still shows its glyph, and any selected/editing edge shows its chip.
  const showLabelLayer = hasLabel || editing || isSelected || isDirectional;
  const pickerOpen = isSelected && canEdit;

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

  // The visible midpoint element that anchors the picker popover: the label chip
  // (full-text-on-active), the "+ label" affordance on a selected empty edge, or
  // a faint glyph dot for an unlabelled directional edge at rest. `Glyph` (not the
  // `isDirectional` alias) gates the render so TS narrows the nullable icon.
  const labelChip = hasLabel ? (
    <span
      onDoubleClick={(e) => {
        e.stopPropagation();
        beginEditing();
      }}
      title={canEdit ? "Double-click to edit label" : undefined}
      className={`flex items-center gap-1 rounded-md border bg-[#1f2138]/85 px-2 py-0.5 text-xs leading-tight font-medium shadow-sm backdrop-blur-sm ${
        active
          ? "border-[hsl(280,100%,70%)]/60 bg-[#1f2138]/95 text-white shadow-lg"
          : "border-white/10 text-white/90"
      } ${isDirectional ? "border-l-2 border-l-[hsl(280,100%,70%)]/40" : ""}`}
    >
      {Glyph && (
        <Glyph
          size={11}
          aria-hidden
          className="shrink-0 text-[hsl(280,100%,80%)]/70"
        />
      )}
      <span
        className={
          active
            ? "max-w-[20rem] break-words whitespace-normal"
            : "max-w-[12rem] truncate"
        }
      >
        {d.label}
      </span>
    </span>
  ) : canEdit && isSelected ? (
    <button
      type="button"
      className="flex items-center gap-1 rounded-md border border-[hsl(280,100%,70%)]/60 bg-[#1f2138]/95 px-2 py-0.5 text-xs font-medium text-white shadow-lg backdrop-blur-sm transition hover:bg-[#1f2138]"
      onClick={(e) => {
        e.stopPropagation();
        beginEditing();
      }}
    >
      {Glyph && (
        <Glyph
          size={11}
          aria-hidden
          className="shrink-0 text-[hsl(280,100%,80%)]/70"
        />
      )}
      + label
    </button>
  ) : Glyph ? (
    <span
      title={INTERACTION_HINT[d.interaction]}
      className={`flex size-4 items-center justify-center rounded-full border border-white/10 bg-[#1f2138]/70 text-[hsl(280,100%,80%)] shadow-sm backdrop-blur-sm transition ${
        active ? "opacity-100" : "opacity-60"
      }`}
    >
      <Glyph size={11} aria-hidden />
    </span>
  ) : null;

  // Interaction picker — a segmented control offered only on a selected, editable
  // Connection (viewers see arrowheads but no picker). It now floats in a popover
  // anchored off the bezier midpoint rather than piling onto it (ADR-0039).
  // Selecting a value upgrades the Connection's interaction in place; draw order
  // is preserved, so a directional value points the arrow the way it was drawn
  // (ADR-0027). Labelled "Interaction", never "type". Each option's hint surfaces
  // through the shared Tooltip rather than a slow, unstyled native `title`.
  const picker = (
    <div
      role="group"
      aria-label="Interaction"
      className="flex items-center gap-0.5"
    >
      {INTERACTION_ORDER.map((value) => {
        const isCurrent = d.interaction === value;
        return (
          <Tooltip key={value}>
            <TooltipTrigger
              delay={300}
              render={
                <button
                  type="button"
                  aria-pressed={isCurrent}
                  className={`rounded-md px-2 py-1 text-xs leading-none font-medium transition-colors ${
                    isCurrent
                      ? "bg-[hsl(280,100%,70%)]/90 font-semibold text-black"
                      : "text-white/55 hover:bg-white/10 hover:text-white"
                  }`}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!isCurrent) onSetInteraction(id, value);
                  }}
                >
                  {INTERACTION_LABEL[value]}
                </button>
              }
            />
            <TooltipPanel>{INTERACTION_HINT[value]}</TooltipPanel>
          </Tooltip>
        );
      })}
    </div>
  );

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerStart={markerStart}
        markerEnd={markerEnd}
      />
      {showLabelLayer && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: "all",
              zIndex,
            }}
            className={`nodrag nopan flex flex-col items-center transition duration-150 ${
              recede ? "opacity-40 blur-[1px]" : "opacity-100"
            }`}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
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
            ) : pickerOpen ? (
              <Popover open onOpenChange={() => undefined}>
                <PopoverTrigger render={labelChip ?? <span />} />
                <PopoverPanel
                  side="bottom"
                  align="center"
                  sideOffset={10}
                  className="flex items-center gap-0.5 rounded-lg border border-white/15 bg-[#1f2138]/95 p-1 shadow-2xl backdrop-blur-md"
                >
                  {picker}
                </PopoverPanel>
              </Popover>
            ) : (
              labelChip
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

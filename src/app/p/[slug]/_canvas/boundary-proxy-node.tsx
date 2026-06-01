"use client";

import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useContext, useState } from "react";

import { FLOW_INTERACTION_DISPLAY } from "~/lib/flow-interaction-display";
import { type NodeKind } from "~/lib/schemas";
import { type CanvasFlowPaletteItem } from "~/lib/types";

import { KIND_ICON } from "~/lib/node-kinds";

import { CanEditContext } from "./component-node";

/**
 * The handle id prefix that marks a React Flow Handle as a Flow palette item on
 * a boundary proxy. A drag to/from such a handle is a refinement route, not a
 * plain Connection — the Canvas island branches on this prefix in `onConnect`
 * and dispatches `routeFlow` with the encoded `flowId` (Slice 3 / ADR-0012).
 */
export const FLOW_HANDLE_PREFIX = "flow:";

export function flowHandleId(flowId: string): string {
  return `${FLOW_HANDLE_PREFIX}${flowId}`;
}

export function flowIdFromHandle(handleId: string | null | undefined): string | null {
  return handleId?.startsWith(FLOW_HANDLE_PREFIX)
    ? handleId.slice(FLOW_HANDLE_PREFIX.length)
    : null;
}

export type BoundaryProxyNodeData = {
  title: string;
  kind: NodeKind;
  // "direct": an external the current scope connects to on its own parent
  // Canvas — routable here. "inherited": projected down from an ancestor —
  // context-only, collapsed by default to keep deep Canvases uncluttered (#14).
  origin: "direct" | "inherited";
  // The single incident outer Connection a palette drag refines (ADR-0023). A
  // Connection is undirected, so any Flow rides it regardless of interaction;
  // null for inherited or unconnected proxies.
  outerEdgeId: string | null;
  flows: CanvasFlowPaletteItem[];
  hasMore: boolean;
};

export type BoundaryProxyNode = Node<BoundaryProxyNodeData, "boundary-proxy">;

/**
 * The boundary-proxy node type for the Canvas (#14): a read-only, visually
 * distinct stand-in for an external Component this scope connects to, projected
 * inward so dependency context is not lost on Descent (CONTEXT.md "Boundary
 * proxy"). It cannot be renamed, descended, or deleted — it is derived, never a
 * persisted Component.
 *
 * For a DIRECT proxy an owner can refine its Flows: each palette item carries a
 * React Flow Handle whose id encodes the Flow (`flowHandleId`), so dragging
 * between a child Component's Port and a palette item synthesises a refinement
 * route through the island's `onConnect` (Slice 3 / ADR-0012). The route is
 * direction-agnostic — any Flow rides the single incident Connection regardless
 * of its interaction, and the rendered arrowheads are derived from the routed
 * Flows (ADR-0023). The handle's `type`/`position` are cosmetic-only (they stop
 * mattering once the canvas runs in Loose mode).
 *
 * Client-only: domain types come from `~/lib` (never `~/server`), so the server
 * graph stays out of the browser bundle (ADR-0004). `title`/`key` are untrusted
 * user content rendered as plain text (prompt-injection standing note).
 */
export function BoundaryProxyNodeView({ data }: NodeProps<BoundaryProxyNode>) {
  const Icon = KIND_ICON[data.kind];
  const canEdit = useContext(CanEditContext);
  // A direct proxy with an incident outer Connection is routable. The
  // Connection is undirected, so any Flow can ride it (ADR-0023).
  const routable = data.origin === "direct" && data.outerEdgeId !== null;
  // Inherited proxies start collapsed (context, not a work surface); direct
  // proxies with a palette start open so the refinement gesture is discoverable.
  // The default is DERIVED from `data` so a proxy that first renders with no
  // flows (cold cache / pre-seed) opens once its palette arrives — React Flow
  // reuses the node by id across getCanvas refetches, so a one-shot `useState`
  // initializer would latch the empty-state default. A user's explicit toggle
  // (`userToggled`) wins thereafter.
  const [userToggled, setUserToggled] = useState<boolean | undefined>(undefined);
  const expanded =
    userToggled ?? (data.origin === "direct" && data.flows.length > 0);

  return (
    <div
      className="flex min-w-[12rem] flex-col gap-1 rounded-lg border border-dashed border-sky-400/40 bg-[#10131f] px-3 py-2 text-sm text-white/90 shadow-lg"
      title="External system (read-only boundary proxy)"
    >
      <div className="flex items-center gap-2">
        <Icon
          size={16}
          aria-hidden
          className="shrink-0 text-sky-300/80"
        />
        <span className="max-w-[12rem] truncate font-medium">{data.title}</span>
        <span
          className="shrink-0 rounded-full bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-sky-300/90"
          title={
            data.origin === "direct"
              ? "Connected to this Canvas's Component"
              : "Inherited from an ancestor Canvas"
          }
        >
          {data.origin === "direct" ? "external" : "inherited"}
        </span>
        {data.flows.length > 0 && (
          <button
            type="button"
            aria-label={expanded ? "Collapse flow palette" : "Expand flow palette"}
            aria-expanded={expanded}
            className="nodrag ml-auto shrink-0 text-white/40 transition hover:text-white"
            onClick={(e) => {
              e.stopPropagation();
              setUserToggled(!expanded);
            }}
          >
            {expanded ? (
              <ChevronDown size={14} aria-hidden />
            ) : (
              <ChevronRight size={14} aria-hidden />
            )}
          </button>
        )}
      </div>

      {expanded && data.flows.length > 0 && (
        <ul className="flex flex-col gap-1 pt-1">
          {data.flows.map((flow) => {
            // "Points at owner" (owner consumes) drags a child's output INTO
            // the proxy (a target handle); PUSH (owner emits) drags onto a
            // child's input (a source handle). DUPLEX points both ways — under
            // the still-strict refinement handle it takes the consume side.
            // (The handle type stops mattering once Slice 4 switches the canvas
            // to Loose mode; ADR-0023.)
            const ownerConsumes = flow.interaction !== "PUSH";
            const display = FLOW_INTERACTION_DISPLAY[flow.interaction];
            return (
              <li
                key={flow.id}
                className="relative flex items-center gap-2 rounded bg-white/5 px-2 py-1"
              >
                <span
                  className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase ${display.tone}`}
                  title={`${display.label} ${flow.kind}`}
                >
                  {display.short}
                </span>
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-xs">{flow.title}</span>
                  <span className="truncate text-[10px] text-white/40">
                    {flow.key}
                  </span>
                </div>
                {/* Refinement Port. Rendered only when the owner can route here
                    (a direct proxy). An INBOUND Flow is consumed by the owner,
                    so the child's output drags INTO it (target); an OUTBOUND
                    Flow is emitted by the owner, so it drags onto a child's
                    input (source). The id encodes the Flow for `onConnect`. */}
                {routable && canEdit && (
                  <Handle
                    type={ownerConsumes ? "target" : "source"}
                    position={ownerConsumes ? Position.Right : Position.Left}
                    id={flowHandleId(flow.id)}
                    title={
                      ownerConsumes
                        ? "Drag a Component's output here to route this flow"
                        : "Drag onto a Component's input to route this flow"
                    }
                    style={{
                      position: "relative",
                      top: "auto",
                      left: "auto",
                      right: "auto",
                      transform: "none",
                    }}
                    className="ml-auto h-2.5! w-2.5! border-sky-300/60! bg-sky-400/80!"
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}

      {expanded && data.hasMore && (
        <p className="px-2 text-[10px] text-white/30">
          More flows available…
        </p>
      )}
    </div>
  );
}

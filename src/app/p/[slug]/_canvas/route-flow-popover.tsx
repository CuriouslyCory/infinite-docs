"use client";

import { Suspense, useContext, useEffect } from "react";

import { api } from "~/trpc/react";

import {
  RouteFlowContext,
  type ConnectionEdgeEndpoints,
} from "./connection-edge";

/**
 * Inline popover that lists the unrouted Flows from either endpoint of a
 * selected Connection. Triggered by the "+ flow" button on
 * `ConnectionEdgeView` (Slice 2). Clicking a Flow fires `routeFlow`
 * optimistically through `RouteFlowContext`.
 *
 * Read access is via the capability slug (ADR-0002): the popover works in
 * shared-view mode too — though the "+ flow" trigger itself is owner-only,
 * so the popover never actually opens for non-owners. The Suspense boundary
 * is here rather than at the trigger so a slow palette fetch doesn't lock
 * the canvas mouse interaction.
 *
 * Untrusted: `flow.title` is user-pasted content stored verbatim
 * (prompt-injection standing note, CONTEXT.md); rendered as plain text only.
 */
export function RouteFlowPopover({
  outerEdgeId,
  endpoints,
  onClose,
}: {
  outerEdgeId: string;
  endpoints: ConnectionEdgeEndpoints;
  onClose: () => void;
}) {
  // Escape closes the popover from anywhere — matches the
  // `ComponentDetailPanel` keystroke convention.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-label="Route a flow"
      className="pointer-events-auto mt-1 w-72 rounded-md border border-white/15 bg-[#1f2138] p-2 text-sm text-white shadow-2xl"
      onClick={(e) => e.stopPropagation()}
    >
      <Suspense
        fallback={<p className="px-2 py-1 text-xs text-white/40">Loading…</p>}
      >
        <UnroutedFlowList
          outerEdgeId={outerEdgeId}
          endpoints={endpoints}
          onClose={onClose}
        />
      </Suspense>
    </div>
  );
}

function UnroutedFlowList({
  outerEdgeId,
  endpoints,
  onClose,
}: {
  outerEdgeId: string;
  endpoints: ConnectionEdgeEndpoints;
  onClose: () => void;
}) {
  const dispatch = useContext(RouteFlowContext);

  // Three parallel queries — both endpoint Flow lists and the already-routed
  // flowIds for this edge. `useSuspenseQuery` ties their loading state
  // together so the Suspense fallback covers the whole popover, no
  // skeleton-soup. The lists overlap if a Flow's owner is structurally both
  // endpoints (today impossible — self-Connections rejected per ADR-0005 —
  // but the dedupe by id below keeps the render honest if relaxed later).
  const [sourceFlows] = api.architecture.getFlowsForNode.useSuspenseQuery({
    ownerNodeId: endpoints.sourceId,
    slug: endpoints.slug,
  });
  const [targetFlows] = api.architecture.getFlowsForNode.useSuspenseQuery({
    ownerNodeId: endpoints.targetId,
    slug: endpoints.slug,
  });
  const [routedFlowIds] =
    api.architecture.getRoutedFlowIdsForEdge.useSuspenseQuery({
      outerEdgeId,
      slug: endpoints.slug,
    });

  const routedSet = new Set(routedFlowIds);
  const sourceUnrouted = sourceFlows.filter((f) => !routedSet.has(f.id));
  const targetUnrouted = targetFlows.filter((f) => !routedSet.has(f.id));

  if (sourceUnrouted.length === 0 && targetUnrouted.length === 0) {
    return (
      <p className="px-2 py-1 text-xs text-white/40">
        No unrouted flows on either endpoint.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {sourceUnrouted.length > 0 && (
        <FlowGroup
          title={endpoints.sourceTitle}
          flows={sourceUnrouted}
          onPick={(flowId) => {
            dispatch({ kind: "route", flowId, outerEdgeId });
            onClose();
          }}
        />
      )}
      {targetUnrouted.length > 0 && (
        <FlowGroup
          title={endpoints.targetTitle}
          flows={targetUnrouted}
          onPick={(flowId) => {
            dispatch({ kind: "route", flowId, outerEdgeId });
            onClose();
          }}
        />
      )}
    </div>
  );
}

function FlowGroup({
  title,
  flows,
  onPick,
}: {
  title: string;
  flows: {
    id: string;
    key: string;
    title: string;
    polarity: "INBOUND" | "OUTBOUND";
    kind: string;
  }[];
  onPick: (flowId: string) => void;
}) {
  return (
    <section className="flex flex-col gap-1">
      <h4 className="px-1 text-[10px] font-semibold uppercase tracking-wide text-white/50">
        {title}
      </h4>
      <ul className="flex flex-col gap-1">
        {flows.map((flow) => (
          <li key={flow.id}>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded bg-white/5 px-2 py-1 text-left transition hover:bg-white/10"
              onClick={() => onPick(flow.id)}
            >
              <span
                className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase ${
                  flow.polarity === "INBOUND"
                    ? "bg-emerald-500/20 text-emerald-300"
                    : "bg-sky-500/20 text-sky-300"
                }`}
                title={`${flow.polarity} ${flow.kind}`}
              >
                {flow.polarity === "INBOUND" ? "IN" : "OUT"}
              </span>
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-sm">{flow.title}</span>
                <span className="truncate text-[10px] text-white/40">
                  {flow.key}
                </span>
              </div>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

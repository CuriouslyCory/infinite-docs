"use client";

import { type Node, type NodeProps } from "@xyflow/react";
import { Boxes, ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";

import { KIND_ICON, KIND_LABEL } from "~/lib/node-kinds";
import { type NodeKind } from "~/lib/schemas";

export type BoundaryGroupMember = {
  nodeId: string;
  title: string;
  kind: NodeKind;
};

export type BoundaryGroupNodeData = {
  members: BoundaryGroupMember[];
};

export type BoundaryGroupNode = Node<BoundaryGroupNodeData, "boundary-group">;

/**
 * The boundary-group node type for the Canvas (#14 follow-up): the single
 * read-only stand-in a Canvas renders in place of its inherited boundary
 * proxies, so a deep Canvas with many ancestors is not buried under N
 * un-routable stand-ins (CONTEXT.md "Boundary group"). Like a boundary proxy it
 * is derived (the `origin === "inherited"` rows of `deriveBoundaryProxies`),
 * never a persisted Component — so not draggable, selectable, deletable, or
 * descendable. Deliberately paletteless: refinement only binds an outer Edge
 * incident to the current scope, so inherited proxies are context-only — route
 * at the scope where the direct Connection lives (ADR-0012). Distinct from React
 * Flow's own `"group"` node type, a parent-of-children layout primitive; this is
 * a render-layer regrouping, not a positional parent.
 *
 * Client-only: domain types come from `~/lib` (never `~/server`), so the server
 * graph stays out of the browser bundle (ADR-0004). Member `title` is untrusted
 * user content rendered as plain text (prompt-injection standing note).
 */
export function BoundaryGroupNodeView({ data }: NodeProps<BoundaryGroupNode>) {
  const count = data.members.length;
  // React Flow reuses this node by id across getCanvas refetches (the id is
  // derived from the scope, not the member set), so a one-shot `useState`
  // initializer would latch the collapsed default even as members change. Derive
  // the default; a user's explicit toggle wins thereafter. Same anti-latch shape
  // the per-proxy node uses for its palette. Inherited externals are context,
  // not a work surface, so the default is collapsed.
  const [userToggled, setUserToggled] = useState<boolean | undefined>(undefined);
  const expanded = userToggled ?? false;

  return (
    <div
      className="flex min-w-[12rem] flex-col gap-1 rounded-lg border border-dashed border-sky-400/40 bg-[#10131f] px-3 py-2 text-sm text-white/90 shadow-lg"
      title="Inherited externals (read-only, routed at ancestor Canvases)"
    >
      <div className="flex items-center gap-2">
        <Boxes size={16} aria-hidden className="shrink-0 text-sky-300/80" />
        <span className="font-medium">
          {count} inherited {count === 1 ? "external" : "externals"}
        </span>
        <button
          type="button"
          aria-label={
            expanded ? "Collapse inherited externals" : "Expand inherited externals"
          }
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
      </div>

      {expanded && (
        <ul className="flex flex-col gap-1 pt-1">
          {data.members.map((member) => {
            const Icon = KIND_ICON[member.kind];
            return (
              <li
                key={member.nodeId}
                className="flex items-center gap-2 rounded bg-white/5 px-2 py-1"
                title="Inherited from an ancestor Canvas"
              >
                <Icon
                  size={14}
                  aria-hidden
                  className="shrink-0 text-sky-300/80"
                />
                <span className="min-w-0 truncate text-xs">{member.title}</span>
                <span className="ml-auto shrink-0 text-[10px] text-white/40">
                  {KIND_LABEL[member.kind]}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

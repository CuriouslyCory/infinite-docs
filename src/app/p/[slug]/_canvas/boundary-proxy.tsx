"use client";

import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { CornerDownRight } from "lucide-react";
import { useContext } from "react";

import { KIND_ICON } from "~/lib/node-kinds";
import { type NodeKind } from "~/lib/schemas";

import { DescendComponentContext } from "./component-node";

export type BoundaryProxyNodeData = {
  /** The off-scope Component this proxy stands in for (its title). Untrusted. */
  title: string;
  kind: NodeKind;
  /** The real off-scope endpoint's Node id — the navigation target. */
  realEndpointId: string;
  /**
   * True when the real endpoint is an ANCESTOR of the current scope (it appears
   * on the breadcrumb trail) — the lineal/ingress case, where the proxy bears an
   * ancestor's own name on that ancestor's interior Canvas. Labelled distinctly
   * so it reads as an inbound boundary, not "the host inside itself" (ADR-0031).
   */
  lineal: boolean;
  /**
   * The FOREIGN Project's title when this proxy stands in for a CROSS-PROJECT
   * endpoint (#122) — the real Component lives inside an embedded Project. Present
   * only for a cross-project proxy; the marker reads "From [Foreign Project]". The
   * foreign Project.id is never on the wire (ADR-0041) — only its title. Untrusted.
   */
  foreignProjectTitle?: string;
};

export type BoundaryProxyNode = Node<BoundaryProxyNodeData, "boundary-proxy">;

/**
 * The boundary-proxy node type for the Canvas — the read-only **passive** stand-in
 * for the off-scope endpoint of a cross-scope Connection (CONTEXT.md "Boundary
 * proxy"; ADR-0031). `getCanvas` derives ONE proxy ROW per crossing Edge, keyed by
 * the synthetic `proxy_<edgeId>` id; on the Canvas, rows sharing a `realEndpointId`
 * are coalesced at render into a single node (#90), the row-per-edge data shape
 * unchanged. Registered under the `nodeTypes` key `boundary-proxy`.
 *
 * Passive (ADR-0016): it carries no `Node` row, is never selectable/connectable/
 * deletable, and is excluded from every interactive pointer handler by the island's
 * `isPassiveNode` guard. The ONE exception is DRAG (#91 / ADR-0036): an editor may
 * drag it to persist its per-scope placement (keyed by `realEndpointId`), so it
 * inherits the island's `nodesDraggable={canEdit}` rather than pinning
 * `draggable:false` — drag-stop is the only interactive handler it participates in.
 * Its ONE click affordance is "go to the real endpoint" — which navigates to that
 * off-scope Component's own scope (its interior Canvas) via the shared Descent
 * callback. We say "Go to", never "Descend"/"Open": the real endpoint may be an
 * ancestor (lineal/ingress), so the navigation can be lateral or upward, not a true
 * Descent.
 *
 * Client-only: domain types come from `~/lib` (never `~/server` or the generated
 * Prisma client), so the server graph stays out of the browser bundle (ADR-0004).
 * `title` is untrusted user content rendered as plain text, never markup or
 * instructions (prompt-injection standing note, CONTEXT.md).
 */
export function BoundaryProxyNodeView({ data }: NodeProps<BoundaryProxyNode>) {
  const Icon = KIND_ICON[data.kind];
  const onDescend = useContext(DescendComponentContext);

  // The lineal/ingress case bears an ancestor's name on that ancestor's own
  // interior Canvas; lead with the relationship ("Inbound from …") so it never
  // reads as the host containing itself (ADR-0031). A plain cross-scope proxy
  // (the far end lives in another subtree) just shows the off-scope title.
  const goToLabel = `Go to ${data.title}`;
  const ariaLabel = data.lineal
    ? `Inbound connection from ${data.title} (${data.kind}) — boundary proxy, read-only`
    : `Boundary proxy for ${data.title} (${data.kind}), an off-scope Component — read-only`;

  return (
    <div
      aria-label={ariaLabel}
      title={
        data.lineal
          ? `Inbound from ${data.title} (off-scope). Go to the real Component.`
          : `Stands in for ${data.title}, which lives outside this canvas. Go to the real Component.`
      }
      className="group flex items-center gap-2 rounded-lg border border-dashed border-white/25 bg-[#1a1b2e] px-3 py-2 text-sm text-white/70 shadow-inner"
    >
      {/* Both Ports render so the incident Connection attaches on either side;
          a proxy is non-connectable (seeded `connectable: false`), so they are
          purely the edge's anchor, never a drag source (CONTEXT.md "Port"). */}
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={false}
        aria-label="Connection point (left)"
        className="h-2! w-2! border-white/30! bg-white/40!"
      />
      {data.lineal && (
        <CornerDownRight
          size={13}
          aria-hidden
          className="shrink-0 text-[hsl(280,100%,80%)]/70"
        />
      )}
      <Icon size={16} aria-hidden className="shrink-0 text-white/50" />
      <span className="flex max-w-[14rem] flex-col leading-tight">
        {data.lineal && (
          <span className="text-[10px] tracking-wide text-white/40 uppercase">
            Inbound from
          </span>
        )}
        {/* Cross-project marker (#122): the real Component lives in another
            Project, so lead with "From [Foreign Project]" so the proxy reads as a
            cross-project boundary, not a local off-scope one. Untrusted title. */}
        {data.foreignProjectTitle && !data.lineal && (
          <span className="truncate text-[10px] tracking-wide text-[hsl(280,100%,80%)]/70 uppercase">
            From {data.foreignProjectTitle}
          </span>
        )}
        <span className="truncate">{data.title}</span>
      </span>
      {/* Go-to-real affordance: navigates to the off-scope Component's own scope
          (its interior Canvas) through the shared Descent callback. Ungated —
          viewers navigate too. `nodrag` keeps a click from starting a drag. */}
      <button
        type="button"
        aria-label={goToLabel}
        title={goToLabel}
        className="nodrag shrink-0 text-white/40 opacity-0 transition group-hover:opacity-100 hover:text-white focus-visible:opacity-100"
        onClick={(e) => {
          e.stopPropagation();
          onDescend(data.realEndpointId);
        }}
      >
        <CornerDownRight size={14} aria-hidden />
      </button>
      <Handle
        type="source"
        position={Position.Right}
        isConnectable={false}
        aria-label="Connection point (right)"
        className="h-2! w-2! border-white/30! bg-white/40!"
      />
    </div>
  );
}

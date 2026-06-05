"use client";

import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { CornerDownRight } from "lucide-react";
import { useContext } from "react";

import { KIND_ICON } from "~/lib/node-kinds";
import { type NodeKind } from "~/lib/schemas";

import {
  CrossDescendComponentContext,
  DescendComponentContext,
} from "./component-node";

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
  /**
   * Cross-boundary "Go to" routing for a CROSS-PROJECT proxy (#123). The host
   * portal Node id the crossing routes THROUGH — pushed onto `?via=` so the URL
   * stays the host's (the foreign slug is never exposed; non-disclosure firewall).
   * Present only alongside `foreignProjectTitle`.
   */
  referenceNodeId?: string;
  /**
   * The foreign endpoint's own parent scope — the foreign Canvas the "Go to" lands
   * on (#123). `null` = the foreign project root. An opaque foreign Node id, same
   * disclosure class as `realEndpointId`; never a project id/slug. Present only for
   * a cross-project proxy.
   */
  foreignParentScopeId?: string | null;
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
  const onCrossDescend = useContext(CrossDescendComponentContext);
  // A cross-project proxy (foreign endpoint behind a portal) carries the routing
  // ids #122/#123 emit; "Go to" must cross the boundary (push the portal onto
  // `?via=`, land on the foreign scope) rather than the local same-project descent
  // — which would 404 (the foreign node isn't in the host project).
  const isCrossProject = data.referenceNodeId !== undefined;

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
      className="group flex items-center gap-2 rounded-lg border border-dashed border-border bg-muted px-3 py-2 text-sm text-muted-foreground shadow-inner"
    >
      {/* Both Ports render so the incident Connection attaches on either side;
          a proxy is non-connectable (seeded `connectable: false`), so they are
          purely the edge's anchor, never a drag source (CONTEXT.md "Port"). */}
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={false}
        aria-label="Connection point (left)"
        className="h-2! w-2! border-foreground/30! bg-foreground/40!"
      />
      {data.lineal && (
        <CornerDownRight
          size={13}
          aria-hidden
          className="shrink-0 text-primary/70"
        />
      )}
      <Icon size={16} aria-hidden className="shrink-0 text-muted-foreground" />
      <span className="flex max-w-[14rem] flex-col leading-tight">
        {data.lineal && (
          <span className="text-[10px] tracking-wide text-muted-foreground/70 uppercase">
            Inbound from
          </span>
        )}
        {/* Cross-project marker (#122): the real Component lives in another
            Project, so lead with "From [Foreign Project]" so the proxy reads as a
            cross-project boundary, not a local off-scope one. Untrusted title. */}
        {data.foreignProjectTitle && !data.lineal && (
          <span className="truncate text-[10px] tracking-wide text-primary/70 uppercase">
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
        className="nodrag shrink-0 text-muted-foreground/70 opacity-0 transition group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100"
        onClick={(e) => {
          e.stopPropagation();
          if (isCrossProject && data.referenceNodeId !== undefined) {
            onCrossDescend({
              referenceNodeId: data.referenceNodeId,
              foreignParentScopeId: data.foreignParentScopeId ?? null,
            });
            return;
          }
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
        className="h-2! w-2! border-foreground/30! bg-foreground/40!"
      />
    </div>
  );
}

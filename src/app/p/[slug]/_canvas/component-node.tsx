"use client";

import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import {
  ChevronRight,
  ExternalLink,
  Lock,
  Pencil,
  Route,
  Trash2,
} from "lucide-react";
import { createContext, useContext, useRef, useState } from "react";

import { useWorkingTrace } from "~/app/p/[slug]/_trace/use-working-trace";
import { KIND_ICON } from "~/lib/node-kinds";
import { type NodeKind } from "~/lib/schemas";

export type ComponentNodeData = {
  title: string;
  kind: NodeKind;
  /** True while a freshly-added Component awaits its server id (a `temp_…` id). */
  optimistic?: boolean;
  /**
   * Project Portal (#119): a non-identifying boolean discriminator set by
   * `getCanvas`. The embedded Project's real id is NEVER on the wire — exposing it
   * to a host owner with no grant would breach the non-disclosure firewall — so the
   * client only learns THAT a Component is a portal, not WHICH project it targets.
   * Descending crosses a project boundary, keyed off the portal NODE id.
   */
  isPortal?: boolean;
  /**
   * The DESCENDING ACTOR's access to the embedded Project, set by `getCanvas` per
   * portal: "open" (≥ view) or "locked" (no access — the No-access pill). Undefined
   * for a non-portal Component.
   */
  embedAccess?: "open" | "locked";
};

export type ComponentNode = Node<ComponentNodeData, "component">;

/**
 * The Canvas island supplies the inline-rename commit through this context
 * rather than baking a callback into each node's `data`, so the node stays a
 * pure presentational component and React Flow never re-renders every node when
 * the island re-renders mid-drag. The default is inert — a node rendered outside
 * the island's provider simply cannot be renamed.
 */
export const RenameComponentContext = createContext<
  (id: string, title: string) => void
>(() => undefined);

/**
 * The Canvas island supplies the Descent action (open a Component's interior
 * Canvas) through this context, for the same reason rename uses one: the node
 * stays pure and React Flow doesn't re-render every node when the island
 * re-renders. Both the node's "Open" button and React Flow's double-click
 * handler call it, so the route/prefetch logic lives in exactly one place. The default
 * is inert — a node rendered outside the island's provider cannot descend.
 */
export const DescendComponentContext = createContext<(id: string) => void>(
  () => undefined,
);

/**
 * The Canvas island supplies the delete action (a cascading soft-delete of a
 * Component) through this context, like rename/descent — keeping the node a pure
 * presentational component so React Flow doesn't re-render every node when the
 * island re-renders. The default is inert: a node rendered outside the island's
 * provider cannot be deleted.
 */
export const DeleteComponentContext = createContext<(id: string) => void>(
  () => undefined,
);

/**
 * The Canvas island supplies the owner-only edit permission through this context.
 * When false (non-owner), rename and delete affordances are hidden even if the
 * node is not optimistic. Descent (navigation) remains ungated — viewers can
 * open a Component's interior Canvas. Default is false (read-only).
 */
export const CanEditContext = createContext<boolean>(false);

/**
 * The Component node type for the Canvas — the React Flow node that renders a
 * Component (kind icon + title + source/target handles, with inline rename).
 * Registered under the `nodeTypes` key `component`: React Flow's `type` is the
 * registry key, while the domain category is the Node's `kind` (CONTEXT.md keeps
 * these separate — never call kind "type").
 *
 * Client-only: domain types come from `~/lib` (never `~/server` or the generated
 * Prisma client), so the server graph stays out of the browser bundle (ADR-0004).
 * `title` is untrusted user content rendered as plain text — never as markup or
 * instructions (prompt-injection standing note, CONTEXT.md).
 */
export function ComponentNodeView({ id, data }: NodeProps<ComponentNode>) {
  const Icon = KIND_ICON[data.kind];
  const onRename = useContext(RenameComponentContext);
  const onDescend = useContext(DescendComponentContext);
  const onDelete = useContext(DeleteComponentContext);
  const canEdit = useContext(CanEditContext);
  // Per-node read of the working trace (mirrors the CanEditContext pattern): the
  // set changes only on an explicit, rare user toggle — never mid-drag — so the
  // re-render it triggers is acceptable and the set is NOT threaded through each
  // node's `data` (which would defeat React Flow's per-node memo, #57).
  const isTraced = useWorkingTrace().isTracePoint(id);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(data.title);
  // Enter commits, then blurs the unmounting input — which would fire a second
  // commit; this latch makes commit/cancel idempotent for one edit session.
  const settled = useRef(false);

  // Project Portal (#119): `isPortal` is the per-actor boolean discriminator
  // getCanvas sets (the foreign Project.id is redacted from the wire — non-disclosure
  // firewall). A locked portal (the descending actor cannot read the target) renders
  // a distinct No-access pill and cannot be descended; an open one descends across
  // the project boundary (the island's descend handler keys off the portal NODE id).
  const isPortal = data.isPortal === true;
  const isLockedPortal = isPortal && data.embedAccess === "locked";

  // Renaming is disabled while optimistic: a `temp_…` Component has no real id to
  // address yet, and the create-reconcile would overwrite a local title anyway.
  // Also disabled for non-owners (canEdit = false).
  const canRename = !data.optimistic && canEdit;
  // Descent is likewise disabled while optimistic: a `temp_…` Component has no
  // real id, so there is no interior Canvas to open yet. Ungated for owners;
  // viewers can descend to explore the graph. A LOCKED Project Portal (#119) is
  // also undescendable — the descending actor cannot read the embedded Project, so
  // there is no interior to open (re-checked server-side at the crossing re-gate).
  const canDescend = !data.optimistic && !isLockedPortal;
  // Delete is likewise disabled while optimistic: a `temp_…` Component has no
  // real id yet, so there is nothing to soft-delete server-side. Also disabled
  // for non-owners (canEdit = false).
  const canDelete = !data.optimistic && canEdit;

  function beginEditing() {
    if (!canRename) return;
    settled.current = false;
    setDraft(data.title);
    setEditing(true);
  }

  function commit() {
    if (settled.current) return;
    settled.current = true;
    setEditing(false);
    const next = draft.trim();
    // Empty or unchanged → revert (the schema requires a non-empty title).
    if (next.length > 0 && next !== data.title) {
      onRename(id, next);
    }
  }

  function cancel() {
    settled.current = true;
    setEditing(false);
  }

  return (
    <div
      title={data.optimistic ? undefined : "Double-click to open"}
      className={`group relative flex items-center gap-2 rounded-lg border px-3 py-2 text-sm text-white shadow-lg ${
        isPortal ? "bg-[#1a2433]" : "bg-[#1f2138]"
      } ${
        isTraced
          ? "border-[hsl(280,100%,70%)]"
          : isPortal
            ? "border-dashed border-sky-400/60"
            : "border-white/15"
      } ${data.optimistic ? "opacity-60" : "opacity-100"}`}
    >
      {/* Trace-point indicator (#57): a distinct corner badge, kept visually
          separate from the kind icon and the optimistic opacity state. Purely a
          mark — kind stays cosmetic (ADR-0018/0019). */}
      {isTraced && (
        <span
          aria-label="Trace point"
          title="Trace point"
          className="absolute -top-2 -right-2 flex h-5 w-5 items-center justify-center rounded-full border border-white/20 bg-[hsl(280,100%,70%)] text-white shadow"
        >
          <Route size={11} aria-hidden />
        </span>
      )}
      {/* A neutral connection point — Components are not directional, so a Port
          carries no input/output meaning; a Connection's arrowheads are derived
          from its `(interaction, source, target)` (ADR-0027). Two handles (left +
          right) keep drag-to-connect discoverable; under `ConnectionMode.Loose`
          either can start or end a Connection. "Port" is the user word; "handle"
          stays React Flow's code word (CONTEXT.md "Port"). */}
      <Handle
        type="target"
        position={Position.Left}
        aria-label="Connection point (left)"
        title="Drag to connect (left)"
        className="h-2! w-2! border-white/40! bg-white/60!"
      />
      <Icon
        size={16}
        aria-hidden
        className="shrink-0 text-[hsl(280,100%,80%)]"
      />
      {editing ? (
        // `nodrag` keeps React Flow from starting a node drag while typing.
        <input
          className="nodrag w-[12rem] rounded bg-white/10 px-1 py-0.5 text-sm text-white outline-none"
          aria-label="Rename component"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onDoubleClick={(e) => e.stopPropagation()}
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
        <span className="max-w-[12rem] truncate">{data.title}</span>
      )}
      {/* Project Portal access pill (#119): a per-actor mark distinguishing an
          open portal (descendable into the foreign project) from a locked one (no
          read access — the descending actor cannot cross). Purely a mark; the real
          gate is the server-side crossing re-gate. */}
      {isPortal &&
        (isLockedPortal ? (
          <span
            aria-label="No access to embedded project"
            title="No access"
            className="flex shrink-0 items-center gap-1 rounded-full border border-white/15 bg-white/5 px-1.5 py-0.5 text-[10px] font-medium text-white/50"
          >
            <Lock size={9} aria-hidden />
            No access
          </span>
        ) : (
          <span
            aria-label="Embedded project"
            title="Embedded project"
            className="flex shrink-0 items-center gap-1 rounded-full border border-sky-400/30 bg-sky-400/10 px-1.5 py-0.5 text-[10px] font-medium text-sky-200"
          >
            <ExternalLink size={9} aria-hidden />
            Project
          </span>
        ))}
      {/* Descent affordance: a keyboard-reachable equivalent of double-click,
          revealed on hover or keyboard focus. Tab lands here and Enter/Space
          activates it; mouse users still double-click. `nodrag` stops a drag from
          starting on the button, and stopping the dblclick keeps a fast
          double-tap from also descending. Hidden while optimistic — a temp_
          Component has no interior yet. */}
      {!editing && canDescend && (
        <button
          type="button"
          aria-label={`Open ${data.title}`}
          title="Open"
          className="nodrag shrink-0 text-white/40 opacity-0 transition group-hover:opacity-100 hover:text-white focus-visible:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            onDescend(id);
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <ChevronRight size={14} aria-hidden />
        </button>
      )}
      {/* Rename affordance: revealed on hover (or keyboard focus). Double-click
          is reserved for Descent, so renaming gets its own explicit control.
          `nodrag` stops React Flow from starting a node drag on the button, and
          stopping the dblclick keeps a fast double-tap on the pencil from
          descending. Hidden while optimistic — a temp_ Component has no id yet. */}
      {!editing && canRename && (
        <button
          type="button"
          aria-label={`Rename ${data.title}`}
          title="Rename"
          className="nodrag shrink-0 text-white/40 opacity-0 transition group-hover:opacity-100 hover:text-white focus-visible:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            beginEditing();
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <Pencil size={14} aria-hidden />
        </button>
      )}
      {/* Delete affordance: a cascading soft-delete (the Component, its subtree,
          and incident/interior Connections), undoable via the toast the island
          raises. Revealed on hover or keyboard focus; `nodrag` stops a drag and
          stopping the dblclick keeps a fast double-tap from also descending.
          Hidden while optimistic — a temp_ Component has no id yet. Keyboard
          Delete is reserved for Connections (Components are `deletable: false`),
          so removal goes through this explicit, undoable control. */}
      {!editing && canDelete && (
        <button
          type="button"
          aria-label={`Delete ${data.title}`}
          title="Delete"
          className="nodrag shrink-0 text-white/40 opacity-0 transition group-hover:opacity-100 hover:text-red-400 focus-visible:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(id);
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <Trash2 size={14} aria-hidden />
        </button>
      )}
      {/* The second neutral connection point (right). Non-directional like the
          left one — see the note above (ADR-0027). */}
      <Handle
        type="source"
        position={Position.Right}
        aria-label="Connection point (right)"
        title="Drag to connect (right)"
        className="h-2! w-2! border-white/40! bg-white/60!"
      />
    </div>
  );
}

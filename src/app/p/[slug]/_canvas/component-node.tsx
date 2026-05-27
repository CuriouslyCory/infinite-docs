"use client";

import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import {
  Box,
  Cog,
  Database,
  Globe,
  Layers,
  Pencil,
  Server,
  type LucideIcon,
} from "lucide-react";
import { createContext, useContext, useRef, useState } from "react";

import { type NodeKind } from "~/lib/schemas";

export type ComponentNodeData = {
  title: string;
  kind: NodeKind;
  /** True while a freshly-added Component awaits its server id (a `temp_…` id). */
  optimistic?: boolean;
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

// Kind → icon. Kind is cosmetic (CONTEXT.md "Component kind"); this is the only
// place the six kinds acquire a glyph. A finite `Record` keyed by `NodeKind` is
// not widened by `noUncheckedIndexedAccess`, so indexing it needs no guard.
const KIND_ICON: Record<NodeKind, LucideIcon> = {
  GENERIC: Box,
  SERVICE: Cog,
  DATABASE: Database,
  EXTERNAL_API: Globe,
  HOST: Server,
  QUEUE: Layers,
};

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
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(data.title);
  // Enter commits, then blurs the unmounting input — which would fire a second
  // commit; this latch makes commit/cancel idempotent for one edit session.
  const settled = useRef(false);

  // Renaming is disabled while optimistic: a `temp_…` Component has no real id to
  // address yet, and the create-reconcile would overwrite a local title anyway.
  const canRename = !data.optimistic;

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
      className={`group flex items-center gap-2 rounded-lg border border-white/15 bg-[#1f2138] px-3 py-2 text-sm text-white shadow-lg ${
        data.optimistic ? "opacity-60" : "opacity-100"
      }`}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!h-2 !w-2 !border-white/40 !bg-white/60"
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
      <Handle
        type="source"
        position={Position.Right}
        className="!h-2 !w-2 !border-white/40 !bg-white/60"
      />
    </div>
  );
}

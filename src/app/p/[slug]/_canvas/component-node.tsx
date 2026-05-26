"use client";

import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import {
  Box,
  Cog,
  Database,
  Globe,
  Layers,
  Server,
  type LucideIcon,
} from "lucide-react";

import { type NodeKind } from "~/lib/schemas";

export type ComponentNodeData = {
  title: string;
  kind: NodeKind;
  /** True while a freshly-added Component awaits its server id (a `temp_…` id). */
  optimistic?: boolean;
};

export type ComponentNode = Node<ComponentNodeData, "component">;

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
 * Component (kind icon + title + source/target handles). Registered under the
 * `nodeTypes` key `component`: React Flow's `type` is the registry key, while the
 * domain category is the Node's `kind` (CONTEXT.md keeps these separate — never
 * call kind "type").
 *
 * Client-only: domain types come from `~/lib` (never `~/server` or the generated
 * Prisma client), so the server graph stays out of the browser bundle (ADR-0004).
 * `title` is untrusted user content rendered as plain text — never as markup or
 * instructions (prompt-injection standing note, CONTEXT.md).
 */
export function ComponentNodeView({ data }: NodeProps<ComponentNode>) {
  const Icon = KIND_ICON[data.kind];
  return (
    <div
      className={`flex items-center gap-2 rounded-lg border border-white/15 bg-[#1f2138] px-3 py-2 text-sm text-white shadow-lg ${
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
      <span className="max-w-[12rem] truncate">{data.title}</span>
      <Handle
        type="source"
        position={Position.Right}
        className="!h-2 !w-2 !border-white/40 !bg-white/60"
      />
    </div>
  );
}

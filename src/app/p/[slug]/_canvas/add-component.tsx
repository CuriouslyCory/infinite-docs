"use client";

import { Plus } from "lucide-react";

import { type NodeKind } from "~/lib/schemas";

import { KindPickerPopover } from "./kind-palette";

/**
 * The "Add Component" control: a button that opens the **kind palette** (a
 * shadcn/cmdk Command popover; ADR-0020). Selecting a kind delegates the create
 * to the Canvas island via `onAdd`, so all tRPC/optimistic logic stays in one
 * place — the picker stays dumb. `parentKind` is the current Canvas scope's
 * Component kind (`null` at the Project root), which keys the palette's **kind
 * affinity** ranking (CONTEXT.md "Kind affinity").
 */
export function AddComponent({
  onAdd,
  parentKind,
  pending,
}: {
  onAdd: (kind: NodeKind) => void;
  parentKind: NodeKind | null;
  pending: boolean;
}) {
  return (
    <KindPickerPopover
      parentKind={parentKind}
      onSelect={onAdd}
      trigger={
        <button
          type="button"
          aria-haspopup="listbox"
          disabled={pending}
          className="flex items-center gap-1.5 rounded-lg bg-[hsl(280,100%,70%)] px-3 py-1.5 text-sm font-semibold text-black backdrop-blur transition hover:bg-[hsl(280,100%,80%)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus size={14} aria-hidden />
          {pending ? "Adding…" : "Add Component"}
        </button>
      }
    />
  );
}

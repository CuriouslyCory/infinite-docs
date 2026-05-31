"use client";

import { Check } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "~/components/ui/command";
import {
  KIND_ICON,
  KIND_LABEL,
  suggestedKinds,
} from "~/lib/node-kinds";
import { type NodeKind } from "~/lib/schemas";

/**
 * The **kind palette** (CONTEXT.md "Kind palette"; ADR-0020): the searchable,
 * keyboard-navigable Command surface for picking a Component **kind**. Used both
 * when adding a Component (`AddComponent`) and when changing one's kind from the
 * Component-detail panel — the single kind-selection surface in the canvas.
 *
 * `parentKind` keys the **kind affinity** ranking (`null` => the Project root):
 * affined kinds render under a "Suggested" group above a separator, every other
 * kind under "All kinds" below, so search always reaches the full set while the
 * common picks sit on top (CONTEXT.md "Kind affinity"). Affinity is ranking, not
 * constraint — every kind is selectable. `currentKind` (when re-kinding) marks
 * the active row with a check. Pure: it owns no mutation, only `onSelect`.
 */
export function KindPalette({
  parentKind,
  currentKind,
  onSelect,
}: {
  parentKind: NodeKind | null;
  currentKind?: NodeKind;
  onSelect: (kind: NodeKind) => void;
}) {
  const { suggested, rest } = suggestedKinds(parentKind);
  const suggestedHeading =
    parentKind === null
      ? "Suggested for the project root"
      : `Suggested for inside ${KIND_LABEL[parentKind]}`;

  return (
    <Command
      // cmdk filters on each item's `value` (the label); a label substring match
      // surfaces a kind from either group, so search overrides affinity ordering.
      label="Component kind"
      className="w-72 border border-white/15 shadow-2xl"
    >
      <CommandInput placeholder="Search kinds…" autoFocus />
      <CommandList>
        <CommandEmpty>No matching kind.</CommandEmpty>
        {suggested.length > 0 && (
          <>
            <CommandGroup heading={suggestedHeading}>
              {suggested.map((kind) => (
                <KindItem
                  key={kind}
                  kind={kind}
                  active={kind === currentKind}
                  onSelect={onSelect}
                />
              ))}
            </CommandGroup>
            <CommandSeparator />
          </>
        )}
        <CommandGroup heading="All kinds">
          {rest.map((kind) => (
            <KindItem
              key={kind}
              kind={kind}
              active={kind === currentKind}
              onSelect={onSelect}
            />
          ))}
        </CommandGroup>
      </CommandList>
    </Command>
  );
}

function KindItem({
  kind,
  active,
  onSelect,
}: {
  kind: NodeKind;
  active: boolean;
  onSelect: (kind: NodeKind) => void;
}) {
  const Icon = KIND_ICON[kind];
  return (
    <CommandItem value={KIND_LABEL[kind]} onSelect={() => onSelect(kind)}>
      <Icon size={14} aria-hidden className="shrink-0 text-[hsl(280,100%,80%)]" />
      <span className="truncate">{KIND_LABEL[kind]}</span>
      {active && (
        <Check size={14} aria-hidden className="ml-auto shrink-0 text-white/60" />
      )}
    </CommandItem>
  );
}

/**
 * The reusable popover that hosts the **kind palette** behind a caller-supplied
 * trigger — shared by the "Add Component" control and the Component-detail
 * panel's change-kind row so the open/close, outside-click, and Escape handling
 * live in one place (there is no shared Popover primitive in the repo). cmdk owns
 * in-list arrow/Enter navigation; this wrapper owns only the surrounding
 * open/dismiss. Selecting a kind closes the popover and forwards to `onSelect`.
 */
export function KindPickerPopover({
  parentKind,
  currentKind,
  onSelect,
  trigger,
  panelClassName = "absolute top-full left-0 z-10 mt-2",
}: {
  parentKind: NodeKind | null;
  currentKind?: NodeKind;
  onSelect: (kind: NodeKind) => void;
  trigger: (args: { open: boolean; toggle: () => void }) => ReactNode;
  panelClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    }
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      {trigger({ open, toggle: () => setOpen((v) => !v) })}
      {open && (
        <div
          className={panelClassName}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setOpen(false);
            }
          }}
        >
          <KindPalette
            parentKind={parentKind}
            currentKind={currentKind}
            onSelect={(kind) => {
              setOpen(false);
              onSelect(kind);
            }}
          />
        </div>
      )}
    </div>
  );
}

"use client";

import { Check } from "lucide-react";
import { useState, type ReactElement } from "react";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "~/components/ui/command";
import { Popover, PopoverPanel, PopoverTrigger } from "~/components/ui/popover";
import { KIND_ICON, KIND_LABEL, suggestedKinds } from "~/lib/node-kinds";
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
      className="w-72 border border-border shadow-2xl"
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
      <Icon
        size={14}
        aria-hidden
        className="shrink-0 text-primary"
      />
      <span className="truncate">{KIND_LABEL[kind]}</span>
      {active && (
        <Check
          size={14}
          aria-hidden
          className="ml-auto shrink-0 text-muted-foreground"
        />
      )}
    </CommandItem>
  );
}

/**
 * The reusable popover that hosts the **kind palette** behind a caller-supplied
 * trigger — shared by the "Add Component" control and the Component-detail
 * panel's change-kind row. cmdk owns in-list arrow/Enter navigation; this
 * wrapper owns only the surrounding open/dismiss. Selecting a kind closes the
 * popover and forwards to `onSelect`.
 */
export function KindPickerPopover({
  parentKind,
  currentKind,
  onSelect,
  trigger,
  align = "start",
}: {
  parentKind: NodeKind | null;
  currentKind?: NodeKind;
  onSelect: (kind: NodeKind) => void;
  trigger: ReactElement<Record<string, unknown>>;
  align?: "start" | "center" | "end";
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={trigger} />
      <PopoverPanel align={align} aria-label="Component kind">
        <KindPalette
          parentKind={parentKind}
          currentKind={currentKind}
          onSelect={(kind) => {
            setOpen(false);
            onSelect(kind);
          }}
        />
      </PopoverPanel>
    </Popover>
  );
}

"use client";

import { Boxes, Plus } from "lucide-react";
import { useState } from "react";

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
import { suggestedKinds } from "~/lib/node-kinds";
import { type NodeKind } from "~/lib/schemas";
import { api } from "~/trpc/react";

import { KindItem } from "./kind-palette";

/**
 * The **Add palette** (#129): one searchable Command popover that merges the two
 * former canvas-island controls — the **kind palette** ("Add Component") and the
 * "Embed a project" dropdown — under a single search box. The first groups pick a
 * Component **kind** (Suggested + All kinds, keyed by `parentKind`'s **kind
 * affinity**); the trailing "Embed a project" group lists the other Projects the
 * actor can reach, each committing a Project Portal. cmdk owns search/navigation
 * across all groups; selecting a kind forwards `onAddKind`, selecting a project
 * `onEmbed`. Pure presentation — every mutation/optimistic write stays in the
 * Canvas island.
 *
 * Mirrors `ConnectToPopover`: this host owns the `open` state and the lazy
 * project-list fetch (`enabled: open`); nothing fetches until the palette opens
 * (performance philosophy #1).
 */
export function AddPalette({
  parentKind,
  excludeProjectId,
  onAddKind,
  onEmbed,
  addPending,
  embedPending,
}: {
  parentKind: NodeKind | null;
  excludeProjectId: string;
  onAddKind: (kind: NodeKind) => void;
  onEmbed: (target: { id: string; title: string }) => void;
  addPending: boolean;
  embedPending: boolean;
}) {
  const [open, setOpen] = useState(false);

  // Lazy: only fetch the embeddable-project list once the palette is opened.
  const {
    data: projects,
    isLoading,
    isError,
  } = api.architecture.listReferenceableProjects.useQuery(
    { excludeProjectId },
    { enabled: open },
  );

  const { suggested, rest } = suggestedKinds(parentKind);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-haspopup="listbox"
            disabled={addPending || embedPending}
            className="bg-primary text-primary-foreground hover:bg-primary/90 data-[popup-open]:bg-primary/80 flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 data-[popup-open]:shadow-inner"
          >
            <Plus size={14} aria-hidden />
            {embedPending
              ? "Embedding…"
              : addPending
                ? "Adding…"
                : "Add Component"}
          </button>
        }
      />
      <PopoverPanel align="start" aria-label="Add to canvas">
        <Command
          // cmdk filters every group on each item's `value`; a project's `value`
          // carries its id so a project titled "Service" can't collide with the
          // SERVICE kind row.
          label="Add to canvas"
          className="border-border w-72 rounded-xl border shadow-xl"
        >
          <CommandInput placeholder="Search kinds or projects…" autoFocus />
          <CommandList>
            <CommandEmpty>No match.</CommandEmpty>
            {suggested.length > 0 && (
              <>
                <CommandGroup
                  heading={
                    parentKind === null
                      ? "Suggested for the project root"
                      : `Suggested kinds`
                  }
                >
                  {suggested.map((kind) => (
                    <KindItem
                      key={kind}
                      kind={kind}
                      active={false}
                      onSelect={(k) => {
                        setOpen(false);
                        onAddKind(k);
                      }}
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
                  active={false}
                  onSelect={(k) => {
                    setOpen(false);
                    onAddKind(k);
                  }}
                />
              ))}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup heading="Embed a project">
              {isLoading ? (
                // Plain element (not a CommandItem) so cmdk neither filters nor
                // selects it.
                <p className="text-muted-foreground px-2 py-1.5 text-sm">
                  Loading…
                </p>
              ) : isError ? (
                <p className="text-muted-foreground px-2 py-1.5 text-sm">
                  Couldn’t load projects.
                </p>
              ) : !projects || projects.length === 0 ? (
                <p className="text-muted-foreground px-2 py-1.5 text-sm">
                  No other projects to embed.
                </p>
              ) : (
                projects.map((p) => (
                  <CommandItem
                    key={p.id}
                    // Include the project id so the value is unique and never
                    // collides with a kind label of the same name.
                    value={`${p.title} ${p.id}`}
                    keywords={[p.title]}
                    onSelect={() => {
                      setOpen(false);
                      onEmbed({ id: p.id, title: p.title });
                    }}
                  >
                    <Boxes
                      size={14}
                      aria-hidden
                      className="text-primary shrink-0"
                    />
                    {/* `title` is untrusted user content — rendered as plain text. */}
                    <span className="truncate">{p.title}</span>
                  </CommandItem>
                ))
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverPanel>
    </Popover>
  );
}

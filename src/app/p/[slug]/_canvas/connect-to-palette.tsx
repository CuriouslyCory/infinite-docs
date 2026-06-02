"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "~/components/ui/command";
import { KIND_ICON, KIND_LABEL } from "~/lib/node-kinds";
import { type ProjectComponent } from "~/lib/types";
import { api } from "~/trpc/react";

/** The chosen far endpoint a connect gesture commits — the fields the optimistic
 *  far-end boundary proxy needs to render before the server confirms (#66). */
export type ConnectTarget = {
  id: string;
  title: string;
  kind: ProjectComponent["kind"];
};

/**
 * The **"Connect to…"** search surface (#66): a project-wide, searchable,
 * keyboard-navigable Command list for wiring the selected Component to ANY other
 * Component at any scope. Modeled on the **kind palette** (the established cmdk
 * pattern) — search by title or kind, Enter to pick.
 *
 * Each row shows the Component's kind icon, title, and a muted ancestor-path
 * label (built client-side from the flat `parentId` map the project-wide read
 * returns) so same-named Components at different depths disambiguate. cmdk owns
 * filtering/navigation: each item's `keywords` carry the title, kind label, and
 * ancestor titles, so typing a parent's name surfaces its descendants too. Pure:
 * it owns no mutation, only `onSelect`.
 */
export function ConnectToPalette({
  components,
  excludeIds,
  onSelect,
}: {
  components: readonly ProjectComponent[];
  excludeIds: ReadonlySet<string>;
  onSelect: (target: ConnectTarget) => void;
}) {
  const byId = useMemo(
    () => new Map(components.map((c) => [c.id, c])),
    [components],
  );
  const candidates = useMemo(
    () => components.filter((c) => !excludeIds.has(c.id)),
    [components, excludeIds],
  );

  return (
    <Command
      // cmdk identifies each item by `value` (the stable Node id, never typed) and
      // scores the query against `keywords`, so identity and search stay separate
      // and titles can repeat across scopes without colliding.
      label="Connect to a Component"
      className="w-80 border border-white/15 shadow-2xl"
    >
      <CommandInput placeholder="Search components…" autoFocus />
      <CommandList>
        <CommandEmpty>No matching component.</CommandEmpty>
        <CommandGroup heading="Components">
          {candidates.map((component) => (
            <ConnectItem
              key={component.id}
              component={component}
              path={ancestorPath(component, byId)}
              onSelect={onSelect}
            />
          ))}
        </CommandGroup>
      </CommandList>
    </Command>
  );
}

function ConnectItem({
  component,
  path,
  onSelect,
}: {
  component: ProjectComponent;
  path: string[];
  onSelect: (target: ConnectTarget) => void;
}) {
  const Icon = KIND_ICON[component.kind];
  const kindLabel = KIND_LABEL[component.kind];
  return (
    <CommandItem
      value={component.id}
      keywords={[component.title, kindLabel, ...path]}
      onSelect={() =>
        onSelect({
          id: component.id,
          title: component.title,
          kind: component.kind,
        })
      }
    >
      <Icon
        size={14}
        aria-hidden
        className="shrink-0 text-[hsl(280,100%,80%)]"
      />
      <span className="truncate">{component.title}</span>
      <span className="ml-auto shrink-0 truncate pl-2 text-xs text-white/40">
        {path.length > 0 ? path.join(" / ") : "Project root"}
      </span>
    </CommandItem>
  );
}

/**
 * The titles of a Component's ancestors, root-most first (excluding the Component
 * itself), walked from the flat `parentId` map. A live Node's ancestors are
 * always live, so the chain is intact in the project-wide read with no server
 * walk. Bounded by the map size so a corrupt cycle can never spin (cycles are
 * already impossible — `moveNode` rejects them, ADR-0024).
 */
function ancestorPath(
  component: ProjectComponent,
  byId: ReadonlyMap<string, ProjectComponent>,
): string[] {
  const titles: string[] = [];
  let parentId = component.parentId;
  let guard = 0;
  while (parentId !== null && guard < byId.size) {
    const parent = byId.get(parentId);
    if (!parent) break;
    titles.push(parent.title);
    parentId = parent.parentId;
    guard += 1;
  }
  return titles.reverse();
}

/**
 * The popover that hosts the **"Connect to…"** palette behind a caller-supplied
 * trigger — mirrors `KindPickerPopover` (open/close, outside-click, Escape all in
 * one place; the repo has no shared Popover primitive). The project-wide read is
 * lazy: it fires only while the popover is open (`enabled: open`), so opening the
 * detail panel never pays for a whole-project fetch unless the user reaches for
 * connect (performance philosophy #1). Selecting a target closes and forwards to
 * `onSelect`.
 */
export function ConnectToPopover({
  slug,
  excludeIds,
  onSelect,
  trigger,
  panelClassName = "absolute top-full left-0 z-10 mt-2",
}: {
  slug: string;
  excludeIds: ReadonlySet<string>;
  onSelect: (target: ConnectTarget) => void;
  trigger: (args: { open: boolean; toggle: () => void }) => ReactNode;
  panelClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const { data: components, isLoading } =
    api.architecture.listProjectComponents.useQuery(
      { slug },
      { enabled: open },
    );

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
          {isLoading || !components ? (
            <div className="w-80 rounded-lg border border-white/15 bg-[#1f2138] p-4 text-sm text-white/40 shadow-2xl">
              Loading components…
            </div>
          ) : (
            <ConnectToPalette
              components={components}
              excludeIds={excludeIds}
              onSelect={(target) => {
                setOpen(false);
                onSelect(target);
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

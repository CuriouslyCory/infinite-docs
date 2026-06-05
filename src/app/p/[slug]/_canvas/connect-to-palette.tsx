"use client";

import { useMemo, useState, type ReactElement } from "react";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "~/components/ui/command";
import { Popover, PopoverPanel, PopoverTrigger } from "~/components/ui/popover";
import { KIND_ICON, KIND_LABEL } from "~/lib/node-kinds";
import { type ProjectComponent } from "~/lib/types";
import { api } from "~/trpc/react";

/** The chosen far endpoint a connect gesture commits — the fields the optimistic
 *  far-end boundary proxy needs to render before the server confirms (#66).
 *
 *  `foreign` is present ONLY for a CROSS-PROJECT target (#122): it carries the
 *  portal `referenceNodeId` the client routes the connect through (the client
 *  never holds the foreign Project.id — #119), plus the foreign Project's title
 *  for the optimistic proxy's "From […]" marker. Absent for a same-project pick. */
export type ConnectTarget = {
  id: string;
  title: string;
  kind: ProjectComponent["kind"];
  foreign?: { referenceNodeId: string; foreignProjectTitle: string };
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
/** An on-scope Project Portal a cross-project connect can route through (#122) —
 *  its Node id (the `referenceNodeId`) and title for the "From [portal title]"
 *  group heading. The host island passes only ENTERABLE/readOnly portals; a
 *  `locked` portal carries no readable foreign content to offer. */
export type ConnectPortal = { referenceNodeId: string; title: string };

export function ConnectToPalette({
  slug,
  components,
  portals,
  excludeIds,
  onSelect,
}: {
  slug: string;
  components: readonly ProjectComponent[];
  portals: readonly ConnectPortal[];
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
      className="w-80 border border-border shadow-2xl"
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
        {/* One group per on-scope portal: the foreign Components reachable through
            it (#122). Lazily fetched — the query inside fires only while the
            popover is open. cmdk filters these rows by the same `keywords`. */}
        {portals.map((portal) => (
          <ForeignPortalGroup
            key={portal.referenceNodeId}
            slug={slug}
            portal={portal}
            onSelect={onSelect}
          />
        ))}
      </CommandList>
    </Command>
  );
}

/**
 * The "From [portal title]" group of foreign Components reachable through one
 * on-scope Project Portal (#122). The foreign list is fetched lazily via the
 * portal `referenceNodeId` (the client never holds the foreign Project.id — #119);
 * the server derives the embedded Project and re-gates the actor ≥ view. Each row
 * carries `foreign: { referenceNodeId, foreignProjectTitle }` so `commitConnect`
 * routes the cross-project write and the optimistic proxy is marked.
 */
function ForeignPortalGroup({
  slug,
  portal,
  onSelect,
}: {
  slug: string;
  portal: ConnectPortal;
  onSelect: (target: ConnectTarget) => void;
}) {
  const { data: foreignComponents } =
    api.architecture.listForeignComponentsViaPortal.useQuery({
      slug,
      referenceNodeId: portal.referenceNodeId,
    });

  if (!foreignComponents || foreignComponents.length === 0) return null;

  const byId = new Map(foreignComponents.map((c) => [c.id, c]));
  return (
    <CommandGroup heading={`From ${portal.title}`}>
      {foreignComponents.map((component) => (
        <ConnectItem
          key={`${portal.referenceNodeId}:${component.id}`}
          component={component}
          path={ancestorPath(component, byId)}
          onSelect={onSelect}
          foreign={{
            referenceNodeId: portal.referenceNodeId,
            foreignProjectTitle: portal.title,
          }}
        />
      ))}
    </CommandGroup>
  );
}

function ConnectItem({
  component,
  path,
  onSelect,
  foreign,
}: {
  component: ProjectComponent;
  path: string[];
  onSelect: (target: ConnectTarget) => void;
  foreign?: { referenceNodeId: string; foreignProjectTitle: string };
}) {
  const Icon = KIND_ICON[component.kind];
  const kindLabel = KIND_LABEL[component.kind];
  // A foreign Component id can collide with a host one across groups, so prefix
  // the cmdk `value` with the portal id to keep each item uniquely addressable.
  const value = foreign
    ? `${foreign.referenceNodeId}:${component.id}`
    : component.id;
  return (
    <CommandItem
      value={value}
      keywords={[component.title, kindLabel, ...path]}
      onSelect={() =>
        onSelect({
          id: component.id,
          title: component.title,
          kind: component.kind,
          ...(foreign ? { foreign } : {}),
        })
      }
    >
      <Icon
        size={14}
        aria-hidden
        className="shrink-0 text-primary"
      />
      <span className="truncate">{component.title}</span>
      <span className="ml-auto shrink-0 truncate pl-2 text-xs text-muted-foreground/70">
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
 * trigger. The project-wide read is lazy: it fires only while the popover is
 * open (`enabled: open`), so opening the detail panel never pays for a
 * whole-project fetch unless the user reaches for connect (performance
 * philosophy #1). Selecting a target closes and forwards to `onSelect`.
 */
export function ConnectToPopover({
  slug,
  portals = [],
  excludeIds,
  onSelect,
  trigger,
  align = "end",
}: {
  slug: string;
  /** On-scope Project Portals the cross-project connect can route through (#122).
   *  Empty (the default) at scopes with no readable portal — the palette then
   *  offers only same-project Components, exactly as before. */
  portals?: readonly ConnectPortal[];
  excludeIds: ReadonlySet<string>;
  onSelect: (target: ConnectTarget) => void;
  trigger: ReactElement<Record<string, unknown>>;
  align?: "start" | "center" | "end";
}) {
  const [open, setOpen] = useState(false);

  const {
    data: components,
    isLoading,
    isError,
  } = api.architecture.listProjectComponents.useQuery(
    { slug },
    { enabled: open },
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={trigger} />
      <PopoverPanel align={align} aria-label="Connect to a Component">
        {isError ? (
          // Distinct from the loading box so a failed fetch doesn't masquerade
          // as a permanent loading spinner (TanStack v5 leaves `data`
          // undefined and `isLoading=false` after retries exhaust). Closing
          // and reopening the popover re-fires the lazy query.
          <div className="w-80 rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground/70 shadow-2xl">
            Couldn’t load components. Close and reopen to retry.
          </div>
        ) : isLoading || !components ? (
          <div className="w-80 rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground/70 shadow-2xl">
            Loading components…
          </div>
        ) : (
          <ConnectToPalette
            slug={slug}
            components={components}
            portals={portals}
            excludeIds={excludeIds}
            onSelect={(target) => {
              setOpen(false);
              onSelect(target);
            }}
          />
        )}
      </PopoverPanel>
    </Popover>
  );
}

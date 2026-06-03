"use client";

import { Route, Trash2, X } from "lucide-react";
import { useMemo } from "react";

import { useWorkingTrace } from "~/app/p/[slug]/_trace/use-working-trace";
import { KIND_ICON, KIND_LABEL } from "~/lib/node-kinds";
import type { ProjectComponent } from "~/lib/types";
import { api } from "~/trpc/react";

/**
 * The **Trace view** island (#57): renders the **working trace** as a
 * working-set manager / empty state. The cross-layer on-path graph is #58 and
 * is deliberately absent here.
 *
 * Reads the per-Project trace-point id set from the working-trace store and
 * resolves each id to a `{ title, kind }` via the slug-readable
 * `listProjectComponents` (prefetched by the server shell, so no waterfall).
 * Storing only ids keeps the set small and never stale on rename/re-kind; an id
 * whose Component was soft-deleted resolves to nothing and renders as a muted
 * "Removed component" row with a remove control (#59 formalizes pruning).
 *
 * Client-only and server-free: domain types come from `~/lib` via top-level
 * `import type` (ADR-0004), never `~/server`.
 */
export function TraceView({ slug }: { slug: string }) {
  const { tracePoints, count, remove, clear } = useWorkingTrace();
  const { data: components } = api.architecture.listProjectComponents.useQuery({
    slug,
  });

  const byId = useMemo(() => {
    const map = new Map<string, ProjectComponent>();
    for (const component of components ?? []) map.set(component.id, component);
    return map;
  }, [components]);

  const points = useMemo(() => [...tracePoints], [tracePoints]);

  if (count === 0) {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-3 px-6 py-20 text-center">
        <Route size={28} aria-hidden className="text-white/40" />
        <h2 className="text-lg font-semibold text-white">Trace</h2>
        <p className="text-sm text-white/60">
          Add 2 or more trace points to see the graph. Open a Component and check
          “Trace this Component” to mark it.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4 px-6 py-10">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">Trace points</h2>
        <button
          type="button"
          onClick={clear}
          className="flex items-center gap-1.5 rounded bg-white/10 px-2 py-1 text-xs font-medium text-white/80 transition hover:bg-white/15 hover:text-white"
        >
          <Trash2 size={12} aria-hidden />
          Clear all
        </button>
      </div>

      {count < 2 && (
        <p className="rounded border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/60">
          Add 2 or more trace points to see the graph.
        </p>
      )}

      <ul className="flex flex-col gap-1.5">
        {points.map((id) => (
          <TracePointRow
            key={id}
            component={byId.get(id)}
            onRemove={() => remove(id)}
          />
        ))}
      </ul>
    </div>
  );
}

function TracePointRow({
  component,
  onRemove,
}: {
  component: ProjectComponent | undefined;
  onRemove: () => void;
}) {
  const Icon = component ? KIND_ICON[component.kind] : Route;
  return (
    <li className="flex items-center gap-2 rounded bg-white/5 px-3 py-2">
      <Icon
        size={14}
        aria-hidden
        className="shrink-0 text-[hsl(280,100%,80%)]"
      />
      {component ? (
        <span className="min-w-0 flex-1 truncate text-sm text-white">
          {component.title}
          <span className="ml-2 text-xs text-white/40">
            {KIND_LABEL[component.kind]}
          </span>
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate text-sm text-white/40 italic">
          Removed component
        </span>
      )}
      <button
        type="button"
        aria-label="Remove trace point"
        title="Remove trace point"
        onClick={onRemove}
        className="shrink-0 text-white/40 transition hover:text-white"
      >
        <X size={14} aria-hidden />
      </button>
    </li>
  );
}

"use client";

import { Check, Pencil, Route, Save, Trash2, Upload, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Toaster, toast } from "sonner";

import { useWorkingTrace } from "~/app/p/[slug]/_trace/use-working-trace";
import { KIND_ICON, KIND_LABEL } from "~/lib/node-kinds";
import type { ProjectComponent, SavedTrace } from "~/lib/types";
import { api } from "~/trpc/react";

import { TraceFlow } from "~/app/p/[slug]/_trace/trace-flow";

/**
 * The **Trace view** island (#57 / #58 / #59): below two **trace points** it
 * renders the **working trace** as a working-set manager / empty state; at two or
 * more it renders the cross-layer **Trace subgraph** read-only (#58 / ADR-0034).
 * It always mounts the **Saved Traces** panel (#59 / ADR-0035) so saving, listing,
 * and loading a named Trace is reachable whether or not ≥2 points are set.
 *
 * Reads the per-Project trace-point id set from the working-trace store. The
 * cross-layer render fires `getTraceView({ slug, nodeIds })` once mounted. A
 * `seedTraceId` (the saved route) loads that Trace into the working set ONCE on
 * mount (ref-guarded) — the share URL deliberately replaces the local working set.
 *
 * Client-only and server-free: domain types come from `~/lib` via top-level
 * `import type` (ADR-0004), never `~/server`.
 */
export function TraceView({
  slug,
  canEdit,
  seedTraceId,
}: {
  slug: string;
  canEdit: boolean;
  seedTraceId?: string;
}) {
  const { tracePoints, count, remove, clear, replace } = useWorkingTrace();
  const { data: components } = api.architecture.listProjectComponents.useQuery({
    slug,
  });

  const byId = useMemo(() => {
    const map = new Map<string, ProjectComponent>();
    for (const component of components ?? []) map.set(component.id, component);
    return map;
  }, [components]);

  const points = useMemo(() => [...tracePoints], [tracePoints]);

  // Saved route: seed the working set from the prefetched Trace ONCE. The ref
  // guard keeps re-renders (and StrictMode's double-invoke) from re-seeding and
  // clobbering points the user edits after landing.
  const seededRef = useRef(false);
  const { data: seedTrace } = api.architecture.getTrace.useQuery(
    { slug, traceId: seedTraceId ?? "" },
    { enabled: Boolean(seedTraceId) },
  );
  useEffect(() => {
    if (!seedTraceId || seededRef.current || !seedTrace) return;
    seededRef.current = true;
    loadTraceIntoWorkingSet(seedTrace, replace);
  }, [seedTraceId, seedTrace, replace]);

  return (
    <div className="flex h-full w-full flex-col">
      <SavedTracesPanel
        slug={slug}
        canEdit={canEdit}
        activeTraceId={seedTraceId}
        workingPoints={points}
        onLoad={(trace) => loadTraceIntoWorkingSet(trace, replace)}
      />
      <div className="min-h-0 flex-1">
        {count >= 2 ? (
          <TraceCrossLayer slug={slug} nodeIds={points} />
        ) : (
          <WorkingSetManager
            count={count}
            points={points}
            byId={byId}
            remove={remove}
            clear={clear}
          />
        )}
      </div>
      <Toaster theme="dark" position="bottom-right" richColors />
    </div>
  );
}

/**
 * Loads a saved Trace into the working set, replacing it. If the prior set had
 * points not in the saved set (unsaved points discarded), an undo toast restores
 * the prior set — re-`replace(previous)` is the whole undo (#59 / ADR-0035).
 */
function loadTraceIntoWorkingSet(
  trace: SavedTrace,
  replace: (ids: string[]) => { previous: string[] },
): void {
  const { previous } = replace(trace.nodeIds);
  const savedSet = new Set(trace.nodeIds);
  const discarded = previous.filter((id) => !savedSet.has(id));
  if (discarded.length > 0) {
    toast(`Loaded “${trace.name}”`, {
      action: { label: "Undo", onClick: () => replace(previous) },
    });
  }
}

/**
 * The Saved Traces panel (#59): lists the Project's saved Traces (every reader)
 * with Load, and — for the owner only (`canEdit`) — a Save form and per-row
 * Rename/Delete. The Save affordance is OMITTED for viewers, not disabled
 * (ADR-0002); the real owner-only gate is `assertCanWrite` in the write services.
 */
function SavedTracesPanel({
  slug,
  canEdit,
  activeTraceId,
  workingPoints,
  onLoad,
}: {
  slug: string;
  canEdit: boolean;
  activeTraceId?: string;
  workingPoints: string[];
  onLoad: (trace: SavedTrace) => void;
}) {
  const utils = api.useUtils();
  const { data: traces } = api.architecture.listTraces.useQuery({ slug });
  const [name, setName] = useState("");

  const createTrace = api.architecture.createTrace.useMutation({
    onMutate: async ({ name, nodeIds }) => {
      await utils.architecture.listTraces.cancel({ slug });
      const previous = utils.architecture.listTraces.getData({ slug });
      const now = new Date();
      const optimistic: SavedTrace = {
        id: `optimistic-${now.getTime()}`,
        name,
        nodeIds,
        createdAt: now,
        updatedAt: now,
      };
      utils.architecture.listTraces.setData({ slug }, (old) => [
        optimistic,
        ...(old ?? []),
      ]);
      return { previous, optimisticId: optimistic.id };
    },
    onError: (error, _vars, context) => {
      if (context?.previous) {
        utils.architecture.listTraces.setData({ slug }, context.previous);
      }
      toast.error(
        error.data?.code === "CONFLICT"
          ? error.message
          : "Couldn’t save this Trace.",
      );
    },
    onSuccess: (saved, _vars, context) => {
      utils.architecture.listTraces.setData({ slug }, (old) =>
        (old ?? []).map((t) => (t.id === context?.optimisticId ? saved : t)),
      );
      toast.success("Trace saved");
    },
    onSettled: () => {
      void utils.architecture.listTraces.invalidate({ slug });
    },
  });

  const handleSave = () => {
    const trimmed = name.trim();
    if (trimmed.length === 0 || workingPoints.length < 2) return;
    createTrace.mutate({ slug, name: trimmed, nodeIds: workingPoints });
    setName("");
  };

  const canSave = canEdit && workingPoints.length >= 2;
  const hasTraces = (traces?.length ?? 0) > 0;

  if (!canSave && !hasTraces) return null;

  return (
    <div className="border-b border-border bg-foreground/[0.03] px-6 py-4">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-3">
        <h2 className="text-sm font-semibold text-muted-foreground">Saved Traces</h2>

        {canSave && (
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSave();
              }}
              placeholder="Name this Trace…"
              maxLength={120}
              className="min-w-0 flex-1 rounded border border-border bg-muted px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-primary focus:outline-none"
            />
            <button
              type="button"
              onClick={handleSave}
              disabled={name.trim().length === 0 || createTrace.isPending}
              className="flex shrink-0 items-center gap-1.5 rounded bg-primary px-3 py-1.5 text-sm font-medium text-foreground transition hover:bg-primary disabled:opacity-40"
            >
              <Save size={14} aria-hidden />
              Save
            </button>
          </div>
        )}

        {hasTraces ? (
          <ul className="flex flex-col gap-1.5">
            {traces!.map((trace) => (
              <SavedTraceRow
                key={trace.id}
                slug={slug}
                trace={trace}
                canEdit={canEdit}
                isActive={trace.id === activeTraceId}
                onLoad={() => onLoad(trace)}
              />
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground/70">
            No saved Traces yet. Mark 2 or more trace points and save one.
          </p>
        )}
      </div>
    </div>
  );
}

function SavedTraceRow({
  slug,
  trace,
  canEdit,
  isActive,
  onLoad,
}: {
  slug: string;
  trace: SavedTrace;
  canEdit: boolean;
  isActive: boolean;
  onLoad: () => void;
}) {
  const router = useRouter();
  const utils = api.useUtils();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(trace.name);

  const renameTrace = api.architecture.renameTrace.useMutation({
    onMutate: async ({ name }) => {
      await utils.architecture.listTraces.cancel({ slug });
      const previous = utils.architecture.listTraces.getData({ slug });
      utils.architecture.listTraces.setData({ slug }, (old) =>
        (old ?? []).map((t) => (t.id === trace.id ? { ...t, name } : t)),
      );
      return { previous };
    },
    onError: (error, _vars, context) => {
      if (context?.previous) {
        utils.architecture.listTraces.setData({ slug }, context.previous);
      }
      toast.error(
        error.data?.code === "CONFLICT"
          ? error.message
          : "Couldn’t rename this Trace.",
      );
    },
    onSettled: () => {
      void utils.architecture.listTraces.invalidate({ slug });
    },
  });

  const deleteTrace = api.architecture.deleteTrace.useMutation({
    onMutate: async () => {
      await utils.architecture.listTraces.cancel({ slug });
      const previous = utils.architecture.listTraces.getData({ slug });
      utils.architecture.listTraces.setData({ slug }, (old) =>
        (old ?? []).filter((t) => t.id !== trace.id),
      );
      return { previous };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) {
        utils.architecture.listTraces.setData({ slug }, context.previous);
      }
      toast.error("Couldn’t delete this Trace.");
    },
    onSuccess: () => {
      toast("Trace deleted");
      // Deleting the saved Trace that seeds the current /trace/[traceId] URL
      // would leave the route pointing at a soft-deleted resource (refresh →
      // 404); fall back to the base /trace route. Deleting any other Trace from
      // the base route stays put.
      if (isActive) router.push(`/p/${slug}/trace`);
    },
    onSettled: () => {
      void utils.architecture.listTraces.invalidate({ slug });
    },
  });

  const commitRename = () => {
    const trimmed = draft.trim();
    setEditing(false);
    if (trimmed.length === 0 || trimmed === trace.name) {
      setDraft(trace.name);
      return;
    }
    renameTrace.mutate({ slug, traceId: trace.id, name: trimmed });
  };

  return (
    <li className="flex items-center gap-2 rounded bg-muted px-3 py-2">
      <Route
        size={14}
        aria-hidden
        className="shrink-0 text-primary"
      />
      {editing ? (
        <input
          autoFocus
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") {
              setDraft(trace.name);
              setEditing(false);
            }
          }}
          maxLength={120}
          className="min-w-0 flex-1 rounded border border-border bg-muted px-2 py-0.5 text-sm text-foreground focus:border-primary focus:outline-none"
        />
      ) : (
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">
          {trace.name}
          <span className="ml-2 text-xs text-muted-foreground/70">
            {trace.nodeIds.length} points
          </span>
        </span>
      )}

      <button
        type="button"
        aria-label="Load Trace"
        title="Load Trace"
        onClick={onLoad}
        className="flex shrink-0 items-center gap-1 rounded bg-muted px-2 py-1 text-xs font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
      >
        <Upload size={12} aria-hidden />
        Load
      </button>

      {canEdit &&
        (editing ? (
          <button
            type="button"
            aria-label="Save name"
            title="Save name"
            onMouseDown={(e) => e.preventDefault()}
            onClick={commitRename}
            className="shrink-0 text-muted-foreground/70 transition hover:text-foreground"
          >
            <Check size={14} aria-hidden />
          </button>
        ) : (
          <>
            <button
              type="button"
              aria-label="Rename Trace"
              title="Rename Trace"
              onClick={() => {
                setDraft(trace.name);
                setEditing(true);
              }}
              className="shrink-0 text-muted-foreground/70 transition hover:text-foreground"
            >
              <Pencil size={14} aria-hidden />
            </button>
            <button
              type="button"
              aria-label="Delete Trace"
              title="Delete Trace"
              onClick={() => deleteTrace.mutate({ slug, traceId: trace.id })}
              className="shrink-0 text-muted-foreground/70 transition hover:text-destructive"
            >
              <Trash2 size={14} aria-hidden />
            </button>
          </>
        ))}
    </li>
  );
}

function WorkingSetManager({
  count,
  points,
  byId,
  remove,
  clear,
}: {
  count: number;
  points: string[];
  byId: Map<string, ProjectComponent>;
  remove: (id: string) => void;
  clear: () => void;
}) {
  if (count === 0) {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-3 px-6 py-20 text-center">
        <Route size={28} aria-hidden className="text-muted-foreground/70" />
        <h2 className="text-lg font-semibold text-foreground">Trace</h2>
        <p className="text-sm text-muted-foreground">
          Add 2 or more trace points to see the graph. Open a Component and
          check “Trace this Component” to mark it.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4 px-6 py-10">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-foreground">Trace points</h2>
        <button
          type="button"
          onClick={clear}
          className="flex items-center gap-1.5 rounded bg-muted px-2 py-1 text-xs font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
        >
          <Trash2 size={12} aria-hidden />
          Clear all
        </button>
      </div>

      {count < 2 && (
        <p className="rounded border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
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

/**
 * The cross-layer render (#58): fires `getTraceView` for the working-trace point
 * set and hands the derived Trace subgraph to the read-only `TraceFlow`. Below
 * two SERVER-VALID points (stale/foreign/soft-deleted ids drop out), it shows
 * the same insufficient-points empty state so a Trace built only from removed
 * Components doesn't render a blank canvas.
 */
function TraceCrossLayer({
  slug,
  nodeIds,
}: {
  slug: string;
  nodeIds: string[];
}) {
  const { data, isLoading, isError } = api.architecture.getTraceView.useQuery({
    slug,
    nodeIds,
  });

  if (isLoading) {
    return (
      <div className="px-6 py-20 text-center text-sm text-muted-foreground/70">
        Deriving trace…
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="px-6 py-20 text-center text-sm text-muted-foreground/70">
        Couldn’t derive this trace right now.
      </div>
    );
  }

  if (data.tracePointIds.length < 2 || data.nodes.length === 0) {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-3 px-6 py-20 text-center">
        <Route size={28} aria-hidden className="text-muted-foreground/70" />
        <h2 className="text-lg font-semibold text-foreground">Trace</h2>
        <p className="text-sm text-muted-foreground">
          Add 2 or more trace points on live Components to see the graph.
        </p>
      </div>
    );
  }

  return (
    <div className="h-full w-full">
      <TraceFlow slug={slug} data={data} />
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
    <li className="flex items-center gap-2 rounded bg-muted px-3 py-2">
      <Icon
        size={14}
        aria-hidden
        className="shrink-0 text-primary"
      />
      {component ? (
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">
          {component.title}
          <span className="ml-2 text-xs text-muted-foreground/70">
            {KIND_LABEL[component.kind]}
          </span>
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground/70 italic">
          Removed component
        </span>
      )}
      <button
        type="button"
        aria-label="Remove trace point"
        title="Remove trace point"
        onClick={onRemove}
        className="shrink-0 text-muted-foreground/70 transition hover:text-foreground"
      >
        <X size={14} aria-hidden />
      </button>
    </li>
  );
}

"use client";

import { X } from "lucide-react";
import dynamic from "next/dynamic";
import { Suspense, useEffect, useState } from "react";
import { toast } from "sonner";

import { flowSpecKind, type FlowSpecKind } from "~/lib/schemas";
import { api } from "~/trpc/react";

// Lazy-loaded so the Plate bundle code-splits into its own chunk and only
// downloads on first Component selection — it never weighs down the canvas
// island's initial load (performance philosophy #1). The panel already lives
// inside the SSR-disabled canvas island (ADR-0004), so no `ssr: false` needed.
const ComponentDocsEditor = dynamic(
  () =>
    import("./component-docs-editor").then((m) => m.ComponentDocsEditor),
  {
    loading: () => <p className="text-xs text-white/40">Loading editor…</p>,
  },
);

/**
 * Slide-in detail surface for a selected Component, opened when the owner
 * single-selects a Component on the Canvas (Slice 1 of the flow-routed plan;
 * ADR-0011). Two sections in this slice:
 *
 * 1. **Attach spec** — paste an OpenAPI document, server-side bounded parse,
 *    materialize Flow rows.
 * 2. **Flow palette (read-only)** — the active Flows the Component owns.
 * 3. **Documentation** — the Plate markdown editor (issues #11 / #12): a
 *    rendered view that toggles to an editable surface with debounced
 *    optimistic autosave.
 *
 * A future slice will add the "+ route" affordance on a selected Connection
 * (#35). The panel deliberately does NOT block the canvas (a sidebar, not a
 * modal) so the user can keep zooming / panning while it is open — performance
 * philosophy #1.
 *
 * Visibility is gated on the owner's `canEdit` permission AND on having a
 * non-temp selection. Dismissed by deselect, Escape, or the close button.
 */
export function ComponentDetailPanel({
  slug,
  ownerNodeId,
  initialDocumentation,
  onClose,
  onFlowCountChange,
  onCommitDocumentation,
}: {
  slug: string;
  ownerNodeId: string;
  /** The selected Component's current markdown docs, seeding the editor. */
  initialDocumentation: string;
  onClose: () => void;
  /**
   * Called when the server returns a new flow count for the selected
   * Component, so the canvas can update the React Flow store and the
   * "N flows" pill on the same frame. The query-cache invalidation alone
   * does NOT reach the RF store (the seed is fire-and-forget by design).
   */
  onFlowCountChange: (ownerNodeId: string, flowCount: number) => void;
  /** Debounced optimistic docs autosave; the mutation lives on the canvas. */
  onCommitDocumentation: (ownerNodeId: string, documentation: string) => void;
}) {
  // Escape closes the panel from anywhere — the canvas keeps focus after the
  // single-select that opens the panel, so a handler on the panel root would
  // never fire from the user's most likely starting point.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="pointer-events-auto flex h-full w-80 flex-col gap-4 overflow-y-auto rounded-l-lg border-l border-white/15 bg-[#1f2138] p-4 text-sm text-white shadow-2xl">
      <header className="flex items-center justify-between border-b border-white/10 pb-2">
        <h2 className="font-semibold">Component detail</h2>
        <button
          type="button"
          aria-label="Close component detail"
          title="Close"
          className="text-white/40 transition hover:text-white"
          onClick={onClose}
        >
          <X size={16} aria-hidden />
        </button>
      </header>

      <AttachSpecSection
        ownerNodeId={ownerNodeId}
        slug={slug}
        onFlowCountChange={onFlowCountChange}
      />

      <section className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-white/60">
          Flow palette
        </h3>
        <Suspense fallback={<p className="text-xs text-white/40">Loading…</p>}>
          <FlowPalette ownerNodeId={ownerNodeId} slug={slug} />
        </Suspense>
      </section>

      <ComponentDocsEditor
        key={ownerNodeId}
        ownerNodeId={ownerNodeId}
        initialDocumentation={initialDocumentation}
        onCommit={onCommitDocumentation}
      />
    </div>
  );
}

function AttachSpecSection({
  ownerNodeId,
  slug,
  onFlowCountChange,
}: {
  ownerNodeId: string;
  slug: string;
  onFlowCountChange: (ownerNodeId: string, flowCount: number) => void;
}) {
  const utils = api.useUtils();
  const [kind, setKind] = useState<FlowSpecKind>("OPENAPI");
  const [source, setSource] = useState("");
  const attach = api.architecture.attachFlowSpec.useMutation();

  async function onParse() {
    const trimmed = source.trim();
    if (trimmed.length === 0) {
      toast.error("Paste a spec first.");
      return;
    }
    try {
      const result = await attach.mutateAsync({
        ownerNodeId,
        kind,
        source: trimmed,
      });
      // Update the React Flow store + cache mirror so the "N flows" pill
      // reflects the new count on the same frame. Then invalidate the
      // palette so the list re-fetches. Parse failures still persist the
      // FlowSpec (with `parseError`) and surface as a non-blocking toast.
      onFlowCountChange(ownerNodeId, result.flowCount);
      await utils.architecture.getFlowsForNode.invalidate({
        ownerNodeId,
        slug,
      });
      if (result.parseError !== null) {
        toast.warning(`Spec saved with parse error: ${result.parseError}`);
      } else {
        toast.success(
          `Parsed ${result.flowCount} flow${result.flowCount === 1 ? "" : "s"}.`,
        );
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Couldn't attach the spec.",
      );
    }
  }

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-white/60">
        Attach spec
      </h3>
      <label className="flex flex-col gap-1 text-xs text-white/60">
        Kind
        <select
          className="nodrag rounded bg-white/10 px-2 py-1 text-sm text-white outline-none"
          value={kind}
          onChange={(e) => setKind(e.target.value as FlowSpecKind)}
          disabled={attach.isPending}
        >
          {flowSpecKind.options.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-white/60">
        Source
        <textarea
          className="nodrag h-32 rounded bg-white/10 p-2 font-mono text-xs text-white outline-none"
          placeholder="Paste OpenAPI YAML or JSON…"
          value={source}
          onChange={(e) => setSource(e.target.value)}
          disabled={attach.isPending}
        />
      </label>
      <button
        type="button"
        className="self-end rounded bg-[hsl(280,100%,70%)] px-3 py-1 text-sm font-medium text-white transition hover:bg-[hsl(280,100%,60%)] disabled:opacity-50"
        onClick={() => void onParse()}
        disabled={attach.isPending}
      >
        {attach.isPending ? "Parsing…" : "Parse"}
      </button>
    </section>
  );
}

function FlowPalette({
  ownerNodeId,
  slug,
}: {
  ownerNodeId: string;
  slug: string;
}) {
  const [flows] = api.architecture.getFlowsForNode.useSuspenseQuery({
    ownerNodeId,
    slug,
  });

  if (flows.length === 0) {
    return (
      <p className="text-xs text-white/40">
        No flows yet. Paste a spec above to materialize them.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-1">
      {flows.map((flow) => (
        <li
          key={flow.id}
          className="flex items-center gap-2 rounded bg-white/5 px-2 py-1"
        >
          <span
            className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase ${
              flow.polarity === "INBOUND"
                ? "bg-emerald-500/20 text-emerald-300"
                : "bg-sky-500/20 text-sky-300"
            }`}
            title={`${flow.polarity} ${flow.kind}`}
          >
            {flow.polarity === "INBOUND" ? "IN" : "OUT"}
          </span>
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-sm">{flow.title}</span>
            <span className="truncate text-[10px] text-white/40">
              {flow.key}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

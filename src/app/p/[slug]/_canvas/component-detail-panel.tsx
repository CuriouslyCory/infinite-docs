"use client";

import { ChevronDown, X } from "lucide-react";
import dynamic from "next/dynamic";
import { useEffect } from "react";

import { KIND_ICON, KIND_LABEL } from "~/lib/node-kinds";
import { type NodeKind, type SpecKind } from "~/lib/schemas";

import { AttachSpecSection } from "./attach-spec-section";
import { KindPickerPopover } from "./kind-palette";

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

// Hover-warm hook for the canvas: trigger the Plate chunk's network fetch the
// first time the user hovers ANY Component, so the chunk is parsed and ready
// by the time they click. Memoized via a module-scope Promise so repeat
// invocations are no-ops — the dynamic import itself is cached after the first
// call, but capturing the Promise keeps the hot path branch-free (ADR-0015 §6).
let docsEditorChunk: Promise<unknown> | undefined;
export function prefetchDocsEditor(): void {
  docsEditorChunk ??= import("./component-docs-editor");
}

/**
 * Slide-in detail surface for a selected Component, opened when the owner
 * single-selects a Component on the Canvas. Two sections in this slice:
 *
 * 1. **Kind** — the Component's kind row (owner: opens the kind palette).
 * 2. **Attach spec** — owner-only paste-and-preview affordance that opens the
 *    spec-conflict modal (#64 / ADR-0029).
 * 3. **Documentation** — the Plate markdown editor (issues #11 / #12): a
 *    rendered view that toggles to an editable surface with debounced
 *    optimistic autosave.
 *
 * The Spec paste field and the Flow palette were removed with the Flow model
 * (#62); the spec → Component generation surface returns in #64. The panel
 * deliberately does NOT block the canvas (a sidebar, not a modal) so the user
 * can keep zooming / panning while it is open — performance philosophy #1.
 *
 * Dual-audience (#16): the owner sees the full edit surface; a capability
 * **viewer** (`readOnly`) sees the same panel with docs but NO write
 * affordances — no Kind picker, no docs Edit toggle. `readOnly` is a required
 * discriminator: the write callbacks (`onChangeKind` / `onCommitDocumentation`)
 * are typed to exist only in owner mode, so handing the viewer panel a mutation
 * is a compile error, never a leaked affordance. Read-only mode is presentation,
 * not the authorization boundary — every mutation is still denied at the service
 * layer (ADR-0002). Dismissed by deselect, Escape, or the close button.
 */
type ComponentDetailPanelProps = {
  ownerNodeId: string;
  /** The selected Component's current kind, shown in the Kind row. */
  currentKind: NodeKind;
  /**
   * The kind of the selected Component's PARENT (the current Canvas scope) —
   * `null` at the root. Keys the kind palette's affinity ranking when changing
   * kind, exactly as it does when adding a Component (CONTEXT.md "Kind affinity").
   */
  parentKind: NodeKind | null;
  /** The selected Component's current markdown docs, seeding the editor. */
  initialDocumentation: string;
  onClose: () => void;
} & (
  | {
      /** Owner mode: full edit affordances wired to the canvas's mutations. */
      readOnly: false;
      /** Optimistic change-kind commit; the mutation lives on the canvas. */
      onChangeKind: (ownerNodeId: string, kind: NodeKind) => void;
      /** Debounced optimistic docs autosave; the mutation lives on the canvas. */
      onCommitDocumentation: (ownerNodeId: string, documentation: string) => void;
      /** "Preview" runs the spec parse/diff; the modal lives on the canvas. */
      onPreviewSpec: (
        ownerNodeId: string,
        input: { kind: SpecKind; source: string },
      ) => void;
      /** True while a previewSpec mutation is in flight for THIS Component. */
      specPreviewPending: boolean;
      /** Latest parseError from a preview attempt; null = clean. */
      specPreviewError: string | null;
    }
  | {
      /** Capability-viewer mode: read docs, zero write affordances. */
      readOnly: true;
    }
);

export function ComponentDetailPanel(props: ComponentDetailPanelProps) {
  const { ownerNodeId, currentKind, parentKind, initialDocumentation, onClose } =
    props;
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

      {props.readOnly ? (
        <ReadOnlyKindRow currentKind={currentKind} />
      ) : (
        <KindSection
          currentKind={currentKind}
          parentKind={parentKind}
          onChangeKind={(kind) => props.onChangeKind(ownerNodeId, kind)}
        />
      )}

      {!props.readOnly && (
        <AttachSpecSection
          pending={props.specPreviewPending}
          parseError={props.specPreviewError}
          onPreview={(input) => props.onPreviewSpec(ownerNodeId, input)}
        />
      )}

      <ComponentDocsEditor
        key={ownerNodeId}
        ownerNodeId={ownerNodeId}
        initialDocumentation={initialDocumentation}
        readOnly={props.readOnly}
        onCommit={props.readOnly ? undefined : props.onCommitDocumentation}
      />
    </div>
  );
}

/**
 * Read-only Kind row for the viewer panel: the same icon + label the owner's
 * picker shows, but a static display — no popover, no focus target. Omitted
 * affordance, not a disabled one, so it never signals "you could edit this".
 */
function ReadOnlyKindRow({ currentKind }: { currentKind: NodeKind }) {
  const Icon = KIND_ICON[currentKind];
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-white/60">
        Kind
      </h3>
      <div className="flex items-center gap-2 rounded bg-white/5 px-2 py-1.5 text-sm text-white">
        <Icon
          size={14}
          aria-hidden
          className="shrink-0 text-[hsl(280,100%,80%)]"
        />
        <span className="truncate">{KIND_LABEL[currentKind]}</span>
      </div>
    </section>
  );
}

function KindSection({
  currentKind,
  parentKind,
  onChangeKind,
}: {
  currentKind: NodeKind;
  parentKind: NodeKind | null;
  onChangeKind: (kind: NodeKind) => void;
}) {
  const Icon = KIND_ICON[currentKind];
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-white/60">
        Kind
      </h3>
      {/* Opens the SAME kind palette the Add control uses (ADR-0020), keyed by
          the PARENT's kind for affinity and marking the current kind. */}
      <KindPickerPopover
        parentKind={parentKind}
        currentKind={currentKind}
        onSelect={onChangeKind}
        trigger={({ open, toggle }) => (
          <button
            type="button"
            aria-haspopup="listbox"
            aria-expanded={open}
            onClick={toggle}
            className="nodrag flex items-center gap-2 rounded bg-white/10 px-2 py-1.5 text-sm text-white transition hover:bg-white/15"
          >
            <Icon
              size={14}
              aria-hidden
              className="shrink-0 text-[hsl(280,100%,80%)]"
            />
            <span className="truncate">{KIND_LABEL[currentKind]}</span>
            <ChevronDown
              size={14}
              aria-hidden
              className="ml-auto shrink-0 text-white/40"
            />
          </button>
        )}
      />
    </section>
  );
}

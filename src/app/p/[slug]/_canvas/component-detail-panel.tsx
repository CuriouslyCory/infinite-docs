"use client";

import { ChevronDown, Plus, Route, Trash2, X } from "lucide-react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useEffect, useMemo } from "react";
import { toast } from "sonner";

import { useWorkingTrace } from "~/app/p/[slug]/_trace/use-working-trace";
import { arrowEnds } from "~/lib/connection-direction";
import { INTERACTION_LABEL } from "~/lib/interactions";
import { KIND_ICON, KIND_LABEL } from "~/lib/node-kinds";
import { type NodeKind, type SpecKind } from "~/lib/schemas";
import { type NodeConnection } from "~/lib/types";
import { api } from "~/trpc/react";

import { AttachSpecSection } from "./attach-spec-section";
import { ConnectToPopover, type ConnectTarget } from "./connect-to-palette";
import { KindPickerPopover } from "./kind-palette";

// Lazy-loaded so the Plate bundle code-splits into its own chunk and only
// downloads on first Component selection — it never weighs down the canvas
// island's initial load (performance philosophy #1). The panel already lives
// inside the SSR-disabled canvas island (ADR-0004), so no `ssr: false` needed.
const ComponentDocsEditor = dynamic(
  () => import("./component-docs-editor").then((m) => m.ComponentDocsEditor),
  {
    loading: () => <p className="text-xs text-muted-foreground/70">Loading editor…</p>,
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
 * 2. **Connections** — the Component's complete incident Connections (#66 /
 *    ADR-0032), read for everyone; the owner adds one through the project-wide
 *    "Connect to…" search.
 * 3. **Attach spec** — owner-only paste-and-preview affordance that opens the
 *    spec-conflict modal (#64 / ADR-0029).
 * 4. **Documentation** — the Plate markdown editor (issues #11 / #12): a
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
  /** The Project's capability slug — keys the slug-readable Connections read
   *  (and, for the owner, the project-wide "Connect to…" search). */
  slug: string;
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
      /** Optimistic cross-scope connect from the "Connect to…" search; the
       *  mutation (and its far-end-proxy insert + reconcile) lives on the
       *  canvas (#66). */
      onConnect: (ownerNodeId: string, target: ConnectTarget) => void;
      /** On-scope Project Portals the cross-project connect can route through
       *  (#122) — the palette surfaces a "From [portal]" group per entry. Empty at
       *  scopes with no readable portal. */
      connectPortals: readonly { referenceNodeId: string; title: string }[];
      /** Optimistic Connection delete from a row's trash control; the mutation
       *  (and its on-canvas edge + per-edge boundary-proxy removal) lives on the
       *  canvas, mirroring the keyboard-Delete path (ADR-0030 / ADR-0031). */
      onDeleteConnection: (ownerNodeId: string, connectionId: string) => void;
      /** Debounced optimistic docs autosave; the mutation lives on the canvas. */
      onCommitDocumentation: (
        ownerNodeId: string,
        documentation: string,
      ) => void;
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
  const {
    ownerNodeId,
    slug,
    currentKind,
    parentKind,
    initialDocumentation,
    onClose,
  } = props;
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
    <div className="pointer-events-auto flex h-full w-80 flex-col gap-4 overflow-y-auto rounded-l-lg border-l border-border bg-card p-4 text-sm text-foreground shadow-2xl">
      <header className="flex items-center justify-between border-b border-border pb-2">
        <h2 className="font-semibold">Component detail</h2>
        <button
          type="button"
          aria-label="Close component detail"
          title="Close"
          className="text-muted-foreground/70 transition hover:text-foreground"
          onClick={onClose}
        >
          <X size={16} aria-hidden />
        </button>
      </header>

      {/* Shown to owner AND viewer alike: marking a trace point is client-side
          selection state, not a write (ADR-0002), so it is not behind the
          `readOnly` discriminator (#57). */}
      <TraceCheckbox nodeId={ownerNodeId} slug={slug} />

      {props.readOnly ? (
        <ReadOnlyKindRow currentKind={currentKind} />
      ) : (
        <KindSection
          currentKind={currentKind}
          parentKind={parentKind}
          onChangeKind={(kind) => props.onChangeKind(ownerNodeId, kind)}
        />
      )}

      <ConnectionsSection
        slug={slug}
        ownerNodeId={ownerNodeId}
        connectPortals={props.readOnly ? [] : props.connectPortals}
        onConnect={
          props.readOnly
            ? undefined
            : (target) => props.onConnect(ownerNodeId, target)
        }
        onDeleteConnection={
          props.readOnly
            ? undefined
            : (connectionId) =>
                props.onDeleteConnection(ownerNodeId, connectionId)
        }
      />

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
 * The **Trace this Component** checkbox (#57): marks the selected Component as a
 * **trace point** in the per-Project **working trace**. Shown to owner and
 * viewer alike — it is client-side selection state, not a write (ADR-0002).
 * Adding the second trace point unlocks the **Trace view**, so the "added"
 * toast carries an "Open Trace view" action once the post-toggle count reaches
 * two.
 */
function TraceCheckbox({ nodeId, slug }: { nodeId: string; slug: string }) {
  const router = useRouter();
  const { isTracePoint, toggle, count } = useWorkingTrace();
  const checked = isTracePoint(nodeId);

  const onToggle = () => {
    const transition = toggle(nodeId);
    if (transition === "added") {
      const nextCount = count + 1;
      toast.success(
        "Trace point added",
        nextCount >= 2
          ? {
              action: {
                label: "Open Trace view",
                onClick: () => router.push(`/p/${slug}/trace`),
              },
            }
          : undefined,
      );
    } else {
      toast("Trace point removed");
    }
  };

  return (
    <section className="flex flex-col gap-1.5">
      <label className="nodrag flex cursor-pointer items-center gap-2">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          className="h-4 w-4 shrink-0 accent-primary"
        />
        <Route size={14} aria-hidden className="shrink-0 text-muted-foreground" />
        <span className="text-sm font-medium text-foreground">
          Trace this Component
        </span>
      </label>
      <p className="pl-6 text-xs text-muted-foreground/70">
        Mark 2 or more Components to see how they connect.
      </p>
    </section>
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
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Kind
      </h3>
      <div className="flex items-center gap-2 rounded bg-muted px-2 py-1.5 text-sm text-foreground">
        <Icon
          size={14}
          aria-hidden
          className="shrink-0 text-primary"
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
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Kind
      </h3>
      {/* Opens the SAME kind palette the Add control uses (ADR-0020), keyed by
          the PARENT's kind for affinity and marking the current kind. */}
      <KindPickerPopover
        parentKind={parentKind}
        currentKind={currentKind}
        onSelect={onChangeKind}
        trigger={
          <button
            type="button"
            aria-haspopup="listbox"
            className="nodrag flex items-center gap-2 rounded bg-muted px-2 py-1.5 text-sm text-foreground transition hover:bg-muted"
          >
            <Icon
              size={14}
              aria-hidden
              className="shrink-0 text-primary"
            />
            <span className="truncate">{KIND_LABEL[currentKind]}</span>
            <ChevronDown
              size={14}
              aria-hidden
              className="ml-auto shrink-0 text-muted-foreground/70"
            />
          </button>
        }
      />
    </section>
  );
}

/**
 * The **Connections** section (#66): the Component's COMPLETE incident
 * Connections across scopes (`listNodeConnections` / ADR-0032), not just the ones
 * visible on the current Canvas. Dual-audience: everyone reads the list; the owner
 * gets a "+ Add connection" control that opens the project-wide "Connect to…"
 * search. `onConnect === undefined` is the viewer (read-only) discriminator — the
 * add affordance is OMITTED, not disabled (ADR-0002). The list reads the
 * slug-readable query directly; the optimistic add lives on the canvas (it must
 * also insert the far-end boundary proxy and reconcile `getCanvas`), so this
 * section only forwards the chosen target up through `onConnect`.
 */
function ConnectionsSection({
  slug,
  ownerNodeId,
  connectPortals,
  onConnect,
  onDeleteConnection,
}: {
  slug: string;
  ownerNodeId: string;
  connectPortals: readonly { referenceNodeId: string; title: string }[];
  onConnect?: (target: ConnectTarget) => void;
  onDeleteConnection?: (connectionId: string) => void;
}) {
  const {
    data: connections,
    isLoading,
    isError,
  } = api.architecture.listNodeConnections.useQuery({
    slug,
    nodeId: ownerNodeId,
  });

  // Already-connected far ends (plus the Component itself) are excluded from the
  // search so the user can't pick a target that would just bounce off the
  // ASSOCIATION de-dupe (the default this gesture draws). Self is always excluded
  // — a Connection can't link a Component to itself.
  const excludeIds = useMemo(
    () =>
      new Set<string>([
        ownerNodeId,
        ...(connections ?? []).map((c) => c.other.id),
      ]),
    [ownerNodeId, connections],
  );

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Connections
        </h3>
        {onConnect && (
          <ConnectToPopover
            slug={slug}
            portals={connectPortals}
            excludeIds={excludeIds}
            onSelect={onConnect}
            trigger={
              <button
                type="button"
                aria-haspopup="listbox"
                className="nodrag flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs text-foreground transition hover:bg-muted"
              >
                <Plus size={12} aria-hidden />
                Add connection
              </button>
            }
          />
        )}
      </div>

      {isLoading ? (
        <p className="text-xs text-muted-foreground/70">Loading…</p>
      ) : isError ? (
        // Distinct from "No connections yet." so a failed fetch is not silently
        // indistinguishable from a genuinely empty list (TanStack v5 leaves
        // `data` undefined on first-fetch error).
        <p className="text-xs text-muted-foreground/70">Couldn’t load connections.</p>
      ) : !connections || connections.length === 0 ? (
        <p className="text-xs text-muted-foreground/70">No connections yet.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {connections.map((connection) => (
            <ConnectionRow
              key={connection.id}
              connection={connection}
              onDelete={onDeleteConnection}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * One Connection row, oriented from the selected Component's perspective: the
 * arrow glyph is derived from the Connection's interaction (`arrowEnds`) mapped
 * through `sourceIsSelf` so it points the way the Connection was drawn relative to
 * THIS Component, without re-deriving direction. The far endpoint's kind icon and
 * title identify the other end; the interaction label and any user label sit
 * muted beneath.
 */
function ConnectionRow({
  connection,
  onDelete,
}: {
  connection: NodeConnection;
  onDelete?: (connectionId: string) => void;
}) {
  const ends = arrowEnds(connection.interaction);
  const atOther = connection.sourceIsSelf ? ends.atTarget : ends.atSource;
  const atSelf = connection.sourceIsSelf ? ends.atSource : ends.atTarget;
  const glyph = atOther && atSelf ? "↔" : atOther ? "→" : atSelf ? "←" : "—";
  const Icon = KIND_ICON[connection.other.kind];
  // A still-optimistic row has no server id yet — its delete would 404, and the
  // create's own rollback owns it. Mirror the canvas node's "hidden while
  // temp_" delete affordance (component-node.tsx).
  const canDelete = onDelete && !connection.id.startsWith("temp_");
  return (
    <li className="group flex flex-col gap-0.5 rounded bg-muted px-2 py-1.5">
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className="w-3 shrink-0 text-center text-muted-foreground/70"
          title={INTERACTION_LABEL[connection.interaction]}
        >
          {glyph}
        </span>
        <Icon
          size={14}
          aria-hidden
          className="shrink-0 text-primary"
        />
        <span className="truncate text-sm text-foreground">
          {connection.other.title}
        </span>
        {/* Delete affordance, mirroring the canvas node's trash control: a
            soft-delete of just this Connection (ADR-0030), revealed on hover or
            keyboard focus so it stays reachable without a pointer. */}
        {canDelete && (
          <button
            type="button"
            aria-label={`Delete connection to ${connection.other.title}`}
            title="Delete connection"
            className="ml-auto shrink-0 text-muted-foreground/70 opacity-0 transition group-hover:opacity-100 hover:text-destructive focus-visible:opacity-100"
            onClick={() => onDelete(connection.id)}
          >
            <Trash2 size={14} aria-hidden />
          </button>
        )}
      </div>
      <span className="pl-5 text-xs text-muted-foreground/70">
        {INTERACTION_LABEL[connection.interaction]}
        {connection.label ? ` · ${connection.label}` : ""}
      </span>
    </li>
  );
}

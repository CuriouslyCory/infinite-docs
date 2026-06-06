"use client";

import { Copy } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";

import { Popover, PopoverPanel, PopoverTrigger } from "~/components/ui/popover";
import { type ExportMarkdownMode } from "~/lib/schemas";
import { api } from "~/trpc/react";

/**
 * The **Copy menu** (#130): one popover that folds the three former copy
 * affordances — the toolbar "Copy as markdown" / "Copy index" pair and the
 * breadcrumb scope copy — into a single **scope × mode** chooser. Scope is
 * *whole project* (`canvasNodeId: null`) vs *current view* (the subtree the
 * viewer has descended into); mode is *full* markdown (authored docs included)
 * vs *index* (titles + kinds, no doc bodies). Every row reuses the imperative
 * `exportMarkdown.fetch` so each click fires fresh — no standing subscription,
 * no cache-key churn across copies.
 *
 * Slug-readable (ADR-0002), so available to any viewer — never gated on edit.
 * Two surfaces mount it, differing only by `defaultScope`:
 *
 *  - The canvas toolbar (`defaultScope="project"`) leads with the "give me
 *    everything" rows.
 *  - The breadcrumb bar (`defaultScope="current"`, `compact`) leads with the
 *    current-view rows — the subtree-with-boundary-context export the AC calls
 *    "self-describing".
 *
 * At the project root the two scopes coincide, so the menu collapses to two
 * rows (Full / Index, both whole-project); descended it shows four (Full and
 * Index groups, each with a whole-project and a current-view row), and
 * `defaultScope` only decides the row order within each group.
 *
 * Built on the Base UI Popover wrapper (the same surface as the header Share
 * menu, #105) with hand-applied menu semantics: the trigger is a native
 * `<button aria-haspopup="menu">`, the panel a `role="menu"` container, each
 * row a native `<button role="menuitem">`. Native buttons give Tab +
 * Enter/Space for free; a lightweight ArrowDown/ArrowUp roving handler moves
 * focus between rows. Escape-closes, outside-press dismissal, focus restore,
 * portal, and collision handling all come from the Popover wrapper.
 *
 * No `<Toaster>` is mounted here: sonner's `toast()` is a global singleton
 * rendered by ANY mounted Toaster, and every route mounting this component
 * already mounts one in its island (canvas). A second Toaster would
 * DOUBLE-FIRE the copy toast — so we rely on the existing island Toaster.
 */
async function copyToClipboard(
  fetcher: (input: {
    slug: string;
    canvasNodeId: string | null;
    mode: ExportMarkdownMode;
  }) => Promise<{ markdown: string }>,
  slug: string,
  canvasNodeId: string | null,
  mode: ExportMarkdownMode,
): Promise<void> {
  try {
    const { markdown } = await fetcher({ slug, canvasNodeId, mode });
    await navigator.clipboard.writeText(markdown);
    toast.success(
      mode === "index"
        ? "Index copied to clipboard."
        : "Markdown copied to clipboard.",
    );
  } catch {
    toast.error("Couldn’t copy. Please try again.");
  }
}

const TOOLBAR_BUTTON_CLASSES =
  "flex items-center gap-1 rounded-lg bg-muted px-2 py-1.5 text-sm text-foreground transition hover:bg-muted/70 data-[popup-open]:bg-muted/80 data-[popup-open]:shadow-inner focus:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const COMPACT_BUTTON_CLASSES =
  "ml-2 flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition hover:bg-foreground/10 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const MENU_ITEM_CLASSES =
  "flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left text-sm text-foreground transition hover:bg-muted focus:outline-none focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring";

type Row = {
  scope: string | null;
  mode: ExportMarkdownMode;
  label: string;
  subtitle?: string;
};

export function CopyMenu({
  slug,
  canvasNodeId,
  defaultScope,
  compact = false,
}: {
  slug: string;
  canvasNodeId: string | null;
  defaultScope: "project" | "current";
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const utils = api.useUtils();
  const fetcher = useCallback(
    (input: {
      slug: string;
      canvasNodeId: string | null;
      mode: ExportMarkdownMode;
    }) => utils.architecture.exportMarkdown.fetch(input),
    [utils],
  );

  const descended = canvasNodeId !== null;

  // `defaultScope` orders the pair within each group; it never changes which
  // rows appear. "project" leads with the whole-project row, "current" with the
  // current-view row.
  const projectFirst = defaultScope === "project";
  const scopePair = (mode: ExportMarkdownMode): Row[] => {
    const whole: Row = { scope: null, mode, label: "Whole project" };
    const current: Row = { scope: canvasNodeId, mode, label: "Current view" };
    return projectFirst ? [whole, current] : [current, whole];
  };

  const handleSelect = (row: Row) => {
    setOpen(false);
    void copyToClipboard(fetcher, slug, row.scope, row.mode);
  };

  // Lightweight roving focus: native buttons already handle Tab + Enter/Space,
  // ArrowDown/ArrowUp move between the menuitem buttons within the role="menu".
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items =
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    if (!items || items.length === 0) return;
    event.preventDefault();
    const list = Array.from(items);
    const currentIndex = list.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const nextIndex =
      currentIndex === -1
        ? event.key === "ArrowDown"
          ? 0
          : list.length - 1
        : (currentIndex + delta + list.length) % list.length;
    list[nextIndex]?.focus();
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-haspopup="menu"
            className={
              compact ? COMPACT_BUTTON_CLASSES : TOOLBAR_BUTTON_CLASSES
            }
            title="Copy markdown — whole project or current view, full or index"
          >
            <Copy size={compact ? 12 : 14} aria-hidden />
            <span>Copy</span>
          </button>
        }
      />
      <PopoverPanel
        align={compact ? "end" : "start"}
        className="border-border bg-popover text-foreground w-60 rounded-xl border p-1.5 shadow-xl"
      >
        <div
          ref={menuRef}
          role="menu"
          aria-label="Copy markdown"
          onKeyDown={handleKeyDown}
          className="flex flex-col gap-0.5"
        >
          {!descended ? (
            <>
              <MenuRow
                row={{ scope: null, mode: "full", label: "Full markdown" }}
                onSelect={handleSelect}
              />
              <MenuRow
                row={{
                  scope: null,
                  mode: "index",
                  label: "Index",
                  subtitle: "titles + kinds, no docs",
                }}
                onSelect={handleSelect}
              />
            </>
          ) : (
            <>
              <div role="group" aria-label="Full markdown">
                <p
                  role="presentation"
                  className="text-muted-foreground px-2 pt-1 pb-0.5 text-xs font-medium"
                >
                  Full
                </p>
                {scopePair("full").map((row) => (
                  <MenuRow
                    key={`full-${row.scope ?? "root"}`}
                    row={row}
                    onSelect={handleSelect}
                  />
                ))}
              </div>
              <div role="group" aria-label="Index">
                <p
                  role="presentation"
                  className="text-muted-foreground px-2 pt-1 pb-0.5 text-xs font-medium"
                >
                  Index{" "}
                  <span className="text-muted-foreground/70 font-normal">
                    — titles + kinds, no docs
                  </span>
                </p>
                {scopePair("index").map((row) => (
                  <MenuRow
                    key={`index-${row.scope ?? "root"}`}
                    row={row}
                    onSelect={handleSelect}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </PopoverPanel>
    </Popover>
  );
}

function MenuRow({
  row,
  onSelect,
}: {
  row: Row;
  onSelect: (row: Row) => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={() => onSelect(row)}
      className={MENU_ITEM_CLASSES}
    >
      <span>{row.label}</span>
      {row.subtitle && (
        <span className="text-muted-foreground text-xs">{row.subtitle}</span>
      )}
    </button>
  );
}

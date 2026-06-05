"use client";

import { Copy, ListTree } from "lucide-react";
import { useCallback } from "react";
import { toast } from "sonner";

import { type ExportMarkdownMode } from "~/lib/schemas";
import { api } from "~/trpc/react";

/**
 * "Copy as markdown" affordances — export a scope to deterministic markdown
 * (ADR-0017 / #15) and write the result to the clipboard. Slug-readable
 * (ADR-0002), so available to any viewer — never gated on edit.
 *
 * Two surfaces share this component, differing only in props:
 *
 *  - The canvas toolbar (`<CopyMarkdownToolbar slug …/>`) anchors to the
 *    **whole project** (`canvasNodeId: null`) regardless of how deep the
 *    user has descended — the canonical "give me everything" action.
 *  - The breadcrumb bar (`<CopyCurrentScopeButton slug canvasNodeId …/>`)
 *    exports the **current scope** (the subtree the viewer is looking at).
 *    At the root scope this equals the toolbar action; deeper it's the
 *    subtree-with-boundary-context export the AC calls "self-describing".
 *
 * Calls the imperative `utils.exportMarkdown.fetch` so each click fires
 * fresh — no standing subscription, no cache-key churn across copies.
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
  "flex items-center gap-1 rounded-md bg-muted px-2 py-1.5 text-sm text-foreground transition hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function CopyMarkdownToolbar({ slug }: { slug: string }) {
  const utils = api.useUtils();
  const fetcher = useCallback(
    (input: {
      slug: string;
      canvasNodeId: string | null;
      mode: ExportMarkdownMode;
    }) => utils.architecture.exportMarkdown.fetch(input),
    [utils],
  );

  return (
    <div className="flex items-center gap-1 rounded-lg bg-black/40 p-2 backdrop-blur">
      <button
        type="button"
        onClick={() => void copyToClipboard(fetcher, slug, null, "full")}
        className={TOOLBAR_BUTTON_CLASSES}
        title="Copy the whole project as deterministic markdown"
      >
        <Copy size={14} aria-hidden />
        <span>Copy as markdown</span>
      </button>
      <button
        type="button"
        onClick={() => void copyToClipboard(fetcher, slug, null, "index")}
        className={TOOLBAR_BUTTON_CLASSES}
        title="Copy a cheap structural index (titles + kinds, no doc bodies)"
      >
        <ListTree size={14} aria-hidden />
        <span>Copy index</span>
      </button>
    </div>
  );
}

const COMPACT_BUTTON_CLASSES =
  "ml-2 flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-muted-foreground transition hover:bg-foreground/10 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function CopyCurrentScopeButton({
  slug,
  canvasNodeId,
}: {
  slug: string;
  canvasNodeId: string | null;
}) {
  const utils = api.useUtils();
  const fetcher = useCallback(
    (input: {
      slug: string;
      canvasNodeId: string | null;
      mode: ExportMarkdownMode;
    }) => utils.architecture.exportMarkdown.fetch(input),
    [utils],
  );

  const scopeLabel = canvasNodeId === null ? "project" : "scope";

  return (
    <button
      type="button"
      onClick={() => void copyToClipboard(fetcher, slug, canvasNodeId, "full")}
      className={COMPACT_BUTTON_CLASSES}
      title={`Copy this ${scopeLabel} as deterministic markdown`}
      aria-label={`Copy this ${scopeLabel} as markdown`}
    >
      <Copy size={12} aria-hidden />
      <span>Copy</span>
    </button>
  );
}

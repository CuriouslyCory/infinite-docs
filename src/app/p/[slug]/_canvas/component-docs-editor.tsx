"use client";

import {
  BasicBlocksPlugin,
  BasicMarksPlugin,
} from "@platejs/basic-nodes/react";
import { LinkPlugin } from "@platejs/link/react";
import { ListStyleType, toggleList } from "@platejs/list";
import { ListPlugin } from "@platejs/list/react";
import { MarkdownPlugin } from "@platejs/markdown";
import {
  Bold,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  List,
  ListOrdered,
  type LucideIcon,
  Pencil,
  Quote,
  Strikethrough,
} from "lucide-react";
import { KEYS } from "platejs";
import { Plate, PlateContent, usePlateEditor } from "platejs/react";
import { useCallback, useEffect, useRef, useState } from "react";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";

const AUTOSAVE_DELAY_MS = 700;

// Heuristic: did a paste lose meaningful markdown on round-trip? Compares the
// pasted source against what the editor serialized back, normalizing whitespace
// (Plate's serializer re-flows lists and re-emits newlines, both noisy) and
// requiring a meaningful length delta to filter out trivial reformat. Returns
// true when the user almost certainly lost a construct outside the supported
// set (table, image, raw HTML, footnote) — a noisy false positive is harmless
// (an extra one-time toast); a missed loss is the failure mode we care about.
function lossyMarkdownDelta(pasted: string, serialized: string): boolean {
  const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
  const a = collapse(pasted);
  const b = collapse(serialized);
  if (a === b) return false;
  // 5% length tolerance absorbs minor re-flow (list bullets, code-fence
  // languages); anything bigger is a real loss.
  const drift = Math.abs(a.length - b.length) / Math.max(a.length, 1);
  return drift > 0.05;
}

/**
 * The Component documentation surface — issues #11 (edit) + #12 (render +
 * view/edit toggle), delivered as one Plate WYSIWYG editor. `readOnly` mode IS
 * the rendered view (#12); flipping it editable is the edit mode (#11).
 *
 * Autosave is debounced and optimistic: there is no save button. The owning
 * canvas holds the mutation (via `onCommit`), so this component can unmount the
 * instant the user deselects without aborting the in-flight write — and we
 * flush any pending edit on blur, on switching back to view, and on unmount, so
 * the last keystroke is never lost.
 *
 * Mounted with `key={ownerNodeId}` by the caller so selecting a different
 * Component remounts with fresh content rather than re-seeding mid-edit.
 *
 * `readOnly` is the capability-viewer mode (#16): the editor is locked to the
 * rendered view — no Edit toggle, no empty-state CTA — so a non-owner reads the
 * docs but can never enter edit mode or commit. `onCommit` is then absent.
 */
export function ComponentDocsEditor({
  ownerNodeId,
  initialDocumentation,
  onCommit,
  readOnly = false,
}: {
  ownerNodeId: string;
  initialDocumentation: string;
  onCommit?: (id: string, documentation: string) => void;
  readOnly?: boolean;
}) {
  const [mode, setMode] = useState<"view" | "edit">("view");
  // Drives the empty-state hint without re-serializing on every render;
  // updated whenever a save commits.
  const [savedDoc, setSavedDoc] = useState(initialDocumentation);

  // Plugins are passed inline so Plate captures each plugin's literal type and
  // augments `editor.tf` with the typed transforms (`tf.h1`, `tf.bold`, …) the
  // toolbar calls. The markdown plugin is the source-of-truth bridge: stored
  // `documentation` is a markdown string, deserialized on mount and serialized
  // back on every debounced save. The supported element set (paragraphs,
  // headings, marks, lists, links, blockquote, code) bounds what survives the
  // round trip — constructs outside it degrade. That bound is acceptable
  // because a Component's docs start empty and are authored here, so there is
  // no legacy markdown to lose (ADR-0015).
  const editor = usePlateEditor({
    plugins: [
      BasicBlocksPlugin,
      BasicMarksPlugin,
      ListPlugin,
      LinkPlugin,
      MarkdownPlugin.configure({ options: { remarkPlugins: [remarkGfm] } }),
    ],
    value: (e) =>
      e.getApi(MarkdownPlugin).markdown.deserialize(initialDocumentation),
  });

  const lastSavedRef = useRef(initialDocumentation);
  const dirtyRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Plate's `onChange` fires on selection moves too, not just content edits.
  // Tracking the last seen `editor.children` reference lets us flip `dirtyRef`
  // only when the actual value changed, so the 700ms timer + serialize() pass
  // doesn't fire after every caret click.
  const lastValueRef = useRef(editor.children);

  const saveNow = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!dirtyRef.current) return;
    // Don't clear dirtyRef until we've successfully serialized — a throw below
    // must leave the dirty flag set so a later tick / unmount flush retries.
    try {
      const markdown = editor.getApi(MarkdownPlugin).markdown.serialize();
      dirtyRef.current = false;
      if (markdown === lastSavedRef.current) return;
      lastSavedRef.current = markdown;
      setSavedDoc(markdown);
      onCommit?.(ownerNodeId, markdown);
    } catch (error) {
      console.error("Failed to serialize documentation:", error);
      // dirtyRef stays true so the next save attempt retries this edit.
    }
  }, [editor, onCommit, ownerNodeId]);

  const scheduleSave = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(saveNow, AUTOSAVE_DELAY_MS);
  }, [saveNow]);

  // Flush the pending edit exactly once on unmount (deselect / Component
  // switch) with the latest closure — the no-lost-work guarantee. Two effects
  // are needed: the first keeps `saveNowRef.current` pointed at the current
  // `saveNow` closure on every render so we never call a stale function; the
  // second's cleanup (empty deps) runs only on unmount and invokes
  // `saveNowRef.current()` to flush via the latest closure.
  const saveNowRef = useRef(saveNow);
  useEffect(() => {
    saveNowRef.current = saveNow;
  });
  useEffect(() => () => saveNowRef.current(), []);

  const enterEdit = useCallback(() => setMode("edit"), []);
  const leaveEdit = useCallback(() => {
    saveNow();
    setMode("view");
  }, [saveNow]);

  // Toolbar actions close over the precisely-typed `editor` so the
  // plugin-added transforms (`tf.bold`, `tf.h1`, …) resolve. `onMouseDown` +
  // preventDefault keeps the editor selection so each transform hits the right
  // range. Link insertion is intentionally omitted (it needs a heavier
  // floating-URL UX); pasted markdown links still render and round-trip.
  const toolbarGroups: {
    icon: LucideIcon;
    title: string;
    run: () => void;
  }[][] = [
    [
      {
        icon: Heading1,
        title: "Heading 1",
        run: () => editor.tf.toggleBlock(KEYS.h1),
      },
      {
        icon: Heading2,
        title: "Heading 2",
        run: () => editor.tf.toggleBlock(KEYS.h2),
      },
      {
        icon: Heading3,
        title: "Heading 3",
        run: () => editor.tf.toggleBlock(KEYS.h3),
      },
    ],
    [
      { icon: Bold, title: "Bold", run: () => editor.tf.toggleMark(KEYS.bold) },
      {
        icon: Italic,
        title: "Italic",
        run: () => editor.tf.toggleMark(KEYS.italic),
      },
      {
        icon: Strikethrough,
        title: "Strikethrough",
        run: () => editor.tf.toggleMark(KEYS.strikethrough),
      },
      {
        icon: Code,
        title: "Inline code",
        run: () => editor.tf.toggleMark(KEYS.code),
      },
    ],
    [
      {
        icon: List,
        title: "Bulleted list",
        run: () => toggleList(editor, { listStyleType: ListStyleType.Disc }),
      },
      {
        icon: ListOrdered,
        title: "Numbered list",
        run: () => toggleList(editor, { listStyleType: ListStyleType.Decimal }),
      },
      {
        icon: Quote,
        title: "Quote",
        run: () => editor.tf.toggleBlock(KEYS.blockquote),
      },
    ],
  ];

  const isEmpty = savedDoc.trim().length === 0;

  // Round-trip drift warning: ADR-0015 §5 bounds the supported markdown set
  // (paragraphs, headings, marks, lists, links, blockquote). A pasted table /
  // image / raw HTML / footnote silently degrades on serialize. Compare the
  // editor's serialized output against the pasted source; on a meaningful
  // mismatch, toast once per mount so the user knows the loss happened. The
  // ref is per-mount because `key={ownerNodeId}` remounts on Component switch.
  const warnedLossyPasteRef = useRef(false);
  const onPasteCapture = useCallback(
    (event: React.ClipboardEvent<HTMLDivElement>) => {
      if (mode !== "edit" || warnedLossyPasteRef.current) return;
      const pasted = event.clipboardData.getData("text/plain");
      if (!pasted || pasted.length < 8) return;
      // Defer until Plate has applied the paste (deserialize is synchronous
      // but the change commits in a queued microtask). One setTimeout(0) is
      // enough; serialize-and-compare runs after the value settles.
      setTimeout(() => {
        try {
          const serialized = editor.getApi(MarkdownPlugin).markdown.serialize();
          if (lossyMarkdownDelta(pasted, serialized)) {
            warnedLossyPasteRef.current = true;
            toast.warning(
              "Some formatting wasn't preserved (tables, images, and raw HTML aren't supported here).",
            );
          }
        } catch {
          // Serialize failure is handled by saveNow's own try/catch — don't
          // surface a second toast from the paste path.
        }
      }, 0);
    },
    [editor, mode],
  );

  // Backspace / Delete inside the editor must NOT reach React Flow's keyboard
  // handler (which would soft-delete the selected Component — `deleteKeyCode`
  // is unset, i.e. defaulted to Backspace/Delete on the canvas). Plate's
  // contentEditable surface usually escapes React Flow's input-skip heuristic,
  // but stopping propagation here makes the contract explicit and robust to
  // future React Flow changes.
  const onKeyDownCapture = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Backspace" || event.key === "Delete") {
        event.stopPropagation();
      }
    },
    [],
  );

  return (
    <section
      className="flex flex-col gap-2"
      onKeyDownCapture={onKeyDownCapture}
      onPasteCapture={onPasteCapture}
    >
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold tracking-wide text-white/60 uppercase">
          Documentation
        </h3>
        {readOnly ? null : mode === "view" ? (
          <button
            type="button"
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-white/60 transition hover:bg-white/10 hover:text-white"
            onClick={enterEdit}
          >
            <Pencil size={12} aria-hidden />
            Edit
          </button>
        ) : (
          <button
            type="button"
            className="rounded bg-[hsl(280,100%,70%)] px-2 py-0.5 text-xs font-medium text-white transition hover:bg-[hsl(280,100%,60%)]"
            onClick={leaveEdit}
          >
            Done
          </button>
        )}
      </div>

      {mode === "view" && isEmpty ? (
        readOnly ? (
          <p className="px-1 py-4 text-xs text-white/40">No documentation.</p>
        ) : (
          <button
            type="button"
            onClick={enterEdit}
            className="rounded border border-dashed border-white/15 px-3 py-4 text-left text-xs text-white/40 transition hover:border-white/30 hover:text-white/60"
          >
            No documentation yet — click Edit to describe this Component.
          </button>
        )
      ) : (
        <Plate
          editor={editor}
          onChange={() => {
            if (mode !== "edit") return;
            // Plate's onChange fires on selection moves too; only schedule a
            // save when the value reference actually changed, so a caret click
            // after 700ms idle doesn't run a no-op serialize.
            if (editor.children === lastValueRef.current) return;
            lastValueRef.current = editor.children;
            dirtyRef.current = true;
            scheduleSave();
          }}
        >
          {mode === "edit" && (
            <div className="nodrag flex flex-wrap items-center gap-0.5 rounded bg-white/5 p-1">
              {toolbarGroups.map((group, gi) => (
                <div key={gi} className="flex items-center gap-0.5">
                  {gi > 0 && (
                    <span className="mx-0.5 h-5 w-px bg-white/10" aria-hidden />
                  )}
                  {group.map(({ icon: Icon, title, run }) => (
                    <button
                      key={title}
                      type="button"
                      title={title}
                      aria-label={title}
                      className="flex h-7 w-7 items-center justify-center rounded text-white/60 transition hover:bg-white/10 hover:text-white"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        run();
                      }}
                    >
                      <Icon size={15} aria-hidden />
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
          <PlateContent
            readOnly={mode === "view"}
            onBlur={mode === "edit" ? saveNow : undefined}
            placeholder="Write documentation in markdown…"
            className={`plate-doc nodrag rounded text-sm text-white/90 outline-none ${
              mode === "edit"
                ? "max-h-80 min-h-32 overflow-y-auto bg-white/5 p-2"
                : "p-0"
            }`}
          />
        </Plate>
      )}
    </section>
  );
}

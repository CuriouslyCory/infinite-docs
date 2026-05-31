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

const AUTOSAVE_DELAY_MS = 700;

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
 */
export function ComponentDocsEditor({
  ownerNodeId,
  initialDocumentation,
  onCommit,
}: {
  ownerNodeId: string;
  initialDocumentation: string;
  onCommit: (id: string, documentation: string) => void;
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

  const saveNow = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    const markdown = editor.getApi(MarkdownPlugin).markdown.serialize();
    if (markdown === lastSavedRef.current) return;
    lastSavedRef.current = markdown;
    setSavedDoc(markdown);
    onCommit(ownerNodeId, markdown);
  }, [editor, onCommit, ownerNodeId]);

  const scheduleSave = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(saveNow, AUTOSAVE_DELAY_MS);
  }, [saveNow]);

  // Flush the pending edit exactly once on unmount (deselect / Component
  // switch) with the latest closure — the no-lost-work guarantee. The first
  // effect keeps the ref pointed at the current `saveNow`; the second runs its
  // cleanup only on unmount (empty deps).
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
  const toolbarGroups: { icon: LucideIcon; title: string; run: () => void }[][] =
    [
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
          run: () =>
            toggleList(editor, { listStyleType: ListStyleType.Decimal }),
        },
        {
          icon: Quote,
          title: "Quote",
          run: () => editor.tf.toggleBlock(KEYS.blockquote),
        },
      ],
    ];

  const isEmpty = savedDoc.trim().length === 0;

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold tracking-wide text-white/60 uppercase">
          Documentation
        </h3>
        {mode === "view" ? (
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
        <button
          type="button"
          onClick={enterEdit}
          className="rounded border border-dashed border-white/15 px-3 py-4 text-left text-xs text-white/40 transition hover:border-white/30 hover:text-white/60"
        >
          No documentation yet — click Edit to describe this Component.
        </button>
      ) : (
        <Plate
          editor={editor}
          onChange={() => {
            if (mode !== "edit") return;
            dirtyRef.current = true;
            scheduleSave();
          }}
        >
          {mode === "edit" && (
            <div className="flex flex-wrap items-center gap-0.5 rounded bg-white/5 p-1">
              {toolbarGroups.map((group, gi) => (
                <div key={gi} className="flex items-center gap-0.5">
                  {gi > 0 && (
                    <span
                      className="mx-0.5 h-5 w-px bg-white/10"
                      aria-hidden
                    />
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

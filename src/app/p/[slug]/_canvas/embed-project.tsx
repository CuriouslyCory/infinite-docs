"use client";

import { Boxes } from "lucide-react";
import { useState } from "react";

import { api } from "~/trpc/react";

/**
 * The "Embed a project" control (#119): a button that opens a small popover
 * listing the actor's other Projects (`listReferenceableProjects`), each one
 * committing a Project Portal via the island's `onEmbed`. Owner-gated at the call
 * site (only rendered when `canEdit`); the real authority is the server-side embed
 * gate (host `edit` + target ≥ view).
 *
 * The list is restricted to OWNED projects this slice, so the slug it carries is
 * the actor's own — never a foreign-slug leak. `title` is untrusted user content
 * rendered as plain text.
 */
export function EmbedProject({
  excludeProjectId,
  onEmbed,
  pending,
}: {
  excludeProjectId: string;
  onEmbed: (target: { id: string; title: string }) => void;
  pending: boolean;
}) {
  const [open, setOpen] = useState(false);
  // Lazy: only fetch the candidate list once the picker is opened.
  const { data: projects, isLoading } =
    api.architecture.listReferenceableProjects.useQuery(
      { excludeProjectId },
      { enabled: open },
    );

  return (
    <div className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={pending}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-lg bg-white/10 px-3 py-1.5 text-sm font-semibold text-white backdrop-blur transition hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Boxes size={14} aria-hidden />
        {pending ? "Embedding…" : "Embed a project"}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute top-full left-0 z-10 mt-1 max-h-72 w-64 overflow-auto rounded-lg border border-white/15 bg-[#1f2138] p-1 shadow-xl"
        >
          {isLoading ? (
            <p className="px-2 py-1.5 text-sm text-white/50">Loading…</p>
          ) : !projects || projects.length === 0 ? (
            <p className="px-2 py-1.5 text-sm text-white/50">
              No other projects to embed.
            </p>
          ) : (
            projects.map((p) => (
              <button
                key={p.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onEmbed({ id: p.id, title: p.title });
                }}
                className="block w-full truncate rounded px-2 py-1.5 text-left text-sm text-white transition hover:bg-white/10"
              >
                {p.title}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

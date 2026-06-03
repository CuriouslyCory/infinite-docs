"use client";

import { Trash2 } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";
import { Toaster } from "sonner";

import { createProjectInput } from "~/lib/schemas";
import { api } from "~/trpc/react";
import { DeleteProjectDialog } from "./delete-project-dialog";

/**
 * Owner-only dashboard: lists the actor's projects and creates new ones.
 *
 * Imports only client-safe modules (`~/lib/schemas` is zod-only; `~/trpc/react`
 * is the client tRPC surface) — never `~/server`. The ESLint guard for
 * `src/app/_components/**` enforces that. See docs/adr/0004.
 */
export function ProjectDashboard() {
  const utils = api.useUtils();
  const [projects] = api.architecture.listProjects.useSuspenseQuery();
  const [title, setTitle] = useState("");
  const [pendingDelete, setPendingDelete] = useState<{
    slug: string;
    title: string;
  } | null>(null);
  // Where focus returns when the delete dialog closes: confirming removes the
  // card whose trash button opened it, so we hand focus to the always-present
  // create input rather than letting it fall to `<body>` (a11y).
  const createInputRef = useRef<HTMLInputElement>(null);

  const createProject = api.architecture.createProject.useMutation({
    onSuccess: async () => {
      setTitle("");
      // The new project (with its server-minted slug) appears in the list as a
      // clickable card once the refetch lands. Optimistic insert is deferred:
      // the slug is unguessable and server-generated, so an optimistic row
      // can't link anywhere until reconciliation.
      await utils.architecture.listProjects.invalidate();
    },
  });

  const trimmed = title.trim();
  const isValid = createProjectInput.safeParse({ title: trimmed }).success;
  const canSubmit = isValid && !createProject.isPending;

  return (
    <div className="w-full">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!canSubmit) return;
          createProject.mutate({ title: trimmed });
        }}
        className="flex gap-2"
      >
        <input
          ref={createInputRef}
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="New project name"
          maxLength={200}
          aria-label="New project name"
          className="flex-1 rounded-lg bg-white/10 px-4 py-2 text-white placeholder:text-white/40 focus:bg-white/15 focus:outline-none"
        />
        <button
          type="submit"
          disabled={!canSubmit}
          className="rounded-lg bg-[hsl(280,100%,70%)] px-6 py-2 font-semibold text-black transition hover:bg-[hsl(280,100%,80%)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {createProject.isPending ? "Creating…" : "Create"}
        </button>
      </form>

      {createProject.isError && (
        <p role="alert" className="mt-2 text-sm text-red-300">
          Couldn’t create the project. Please try again.
        </p>
      )}

      <div className="mt-8">
        {projects.length === 0 ? (
          <p className="text-white/50">
            No projects yet. Create one above to start modeling your
            architecture.
          </p>
        ) : (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {projects.map((project) => (
              <li key={project.id} className="group relative">
                <Link
                  href={`/p/${project.slug}`}
                  className="block rounded-xl bg-white/10 p-4 pr-12 transition hover:bg-white/20"
                >
                  <span className="font-medium text-white">
                    {project.title}
                  </span>
                </Link>
                <button
                  type="button"
                  aria-label={`Delete ${project.title}`}
                  title="Delete project"
                  onClick={() =>
                    setPendingDelete({
                      slug: project.slug,
                      title: project.title,
                    })
                  }
                  className="absolute top-1/2 right-3 -translate-y-1/2 rounded p-1.5 text-white/40 opacity-0 transition group-hover:opacity-100 hover:bg-white/10 hover:text-red-400 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
                >
                  <Trash2 size={16} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <DeleteProjectDialog
        project={pendingDelete}
        onClose={() => setPendingDelete(null)}
        finalFocusRef={createInputRef}
      />
      <Toaster theme="dark" position="bottom-right" richColors />
    </div>
  );
}

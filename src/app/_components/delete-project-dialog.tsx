"use client";

import { useState } from "react";
import { toast } from "sonner";

import {
  Dialog,
  DialogDescription,
  DialogPanel,
  DialogTitle,
} from "~/components/ui/dialog";
import { api } from "~/trpc/react";

type DeletableProject = { slug: string; title: string };

/**
 * Type-to-confirm delete (GitHub/Vercel-style): the destructive button stays
 * disabled until the typed text exactly equals the project title. That match is
 * a client-side friction gate only — the server's real authorization is
 * `assertCanWrite` keyed on the slug. Open state is derived from `project`
 * (non-null = open); the parent owns it.
 *
 * The mutation lives here (the always-mounted outer) rather than in the inner
 * form: confirming closes the dialog optimistically, unmounting the form, and
 * the lifecycle callbacks (rollback/invalidate) must still fire after that.
 * The inner form is keyed by slug so each open mounts a fresh typed-value state
 * (React's "reset state with a key" pattern — no effect needed).
 */
export function DeleteProjectDialog({
  project,
  onClose,
}: {
  project: DeletableProject | null;
  onClose: () => void;
}) {
  const utils = api.useUtils();

  const del = api.architecture.deleteProject.useMutation({
    onMutate: async ({ slug }) => {
      await utils.architecture.listProjects.cancel();
      const previous = utils.architecture.listProjects.getData();
      utils.architecture.listProjects.setData(undefined, (old) =>
        old?.filter((p) => p.slug !== slug),
      );
      return { previous };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.previous)
        utils.architecture.listProjects.setData(undefined, ctx.previous);
      toast.error("Couldn’t delete the project. Please try again.");
    },
    onSuccess: () => toast.success("Project deleted"),
    onSettled: () => utils.architecture.listProjects.invalidate(),
  });

  return (
    <Dialog
      open={project !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      {project && (
        <DeleteProjectForm
          key={project.slug}
          project={project}
          onConfirm={() => {
            del.mutate({ slug: project.slug });
            onClose();
          }}
          onClose={onClose}
        />
      )}
    </Dialog>
  );
}

function DeleteProjectForm({
  project,
  onConfirm,
  onClose,
}: {
  project: DeletableProject;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState("");
  const canDelete = value === project.title;

  return (
    <DialogPanel className="w-[min(28rem,calc(100vw-2rem))]">
      <header className="flex flex-col gap-1 border-b border-white/10 px-5 py-4">
        <DialogTitle>Delete project</DialogTitle>
        <DialogDescription>
          This permanently removes{" "}
          <span className="font-medium text-white">{project.title}</span> and
          everything inside it. This can’t be undone. Type the project name to
          confirm.
        </DialogDescription>
      </header>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!canDelete) return;
          onConfirm();
        }}
        className="flex flex-col gap-4 px-5 py-4"
      >
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={project.title}
          aria-label="Type the project name to confirm deletion"
          autoFocus
          autoComplete="off"
          className="rounded-lg bg-white/10 px-4 py-2 text-white placeholder:text-white/40 focus:bg-white/15 focus:outline-none"
        />

        <footer className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1.5 text-sm text-white/70 transition hover:bg-white/5"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canDelete}
            className="rounded bg-white/10 px-3 py-1.5 text-sm font-semibold text-red-200 transition hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Delete project
          </button>
        </footer>
      </form>
    </DialogPanel>
  );
}

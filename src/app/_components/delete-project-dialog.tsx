"use client";

import { type RefObject, useId, useState } from "react";
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
 *
 * `finalFocusRef` is where focus lands when the dialog closes. The default
 * (return to the trigger) would strand focus on `<body>`, because confirming
 * optimistically removes the card whose trash button opened the dialog — so the
 * parent points this at a stable element that survives the delete (a11y: avoid
 * focus loss, WCAG 2.4.3).
 */
export function DeleteProjectDialog({
  project,
  onClose,
  finalFocusRef,
}: {
  project: DeletableProject | null;
  onClose: () => void;
  finalFocusRef: RefObject<HTMLElement | null>;
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
          finalFocusRef={finalFocusRef}
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
  finalFocusRef,
}: {
  project: DeletableProject;
  onConfirm: () => void;
  onClose: () => void;
  finalFocusRef: RefObject<HTMLElement | null>;
}) {
  const [value, setValue] = useState("");
  const inputId = useId();
  // Trim so a stray trailing space (mobile keyboards love appending one) doesn't
  // silently keep the action disabled — case still matters, that's the gate.
  const canDelete = value.trim() === project.title;

  return (
    <DialogPanel
      finalFocus={finalFocusRef}
      className="w-[min(28rem,calc(100vw-2rem))]"
    >
      <header className="flex flex-col gap-1 border-b border-border px-5 py-4">
        <DialogTitle>Delete project</DialogTitle>
        <DialogDescription>
          This permanently removes{" "}
          <span className="font-medium break-words text-foreground">
            {project.title}
          </span>{" "}
          and everything inside it. This can’t be undone.
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
        <label htmlFor={inputId} className="flex flex-col gap-1.5 text-sm">
          <span className="text-muted-foreground">
            Type{" "}
            <span className="font-medium break-words text-foreground">
              {project.title}
            </span>{" "}
            to confirm
          </span>
          <input
            id={inputId}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Project name"
            autoFocus
            autoComplete="off"
            className="rounded-lg bg-muted px-4 py-2 text-foreground placeholder:text-muted-foreground/70 focus:bg-muted focus:outline-none"
          />
        </label>

        <footer className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1.5 text-sm text-muted-foreground transition hover:bg-foreground/5"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canDelete}
            className={`rounded px-3 py-1.5 text-sm font-semibold transition ${
              canDelete
                ? "bg-destructive/10 text-destructive hover:bg-destructive hover:text-destructive-foreground"
                : "cursor-not-allowed bg-muted text-muted-foreground/70"
            }`}
          >
            Delete project
          </button>
        </footer>
      </form>
    </DialogPanel>
  );
}

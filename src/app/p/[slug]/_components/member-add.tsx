"use client";

import { UserPlus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { projectRole, type ProjectRoleInput } from "~/lib/schemas";
import { api } from "~/trpc/react";

/**
 * Admin-only "add a member by email" section inside the ShareMenu (#107). The
 * second grant path alongside the invite link: an admin types an email; if a
 * `User` with that address exists (Discord supplies it on sign-in), they're
 * granted membership immediately. Rendered in the ShareMenu's `canManage` block
 * (grantMemberByEmail is ADMIN+) and collapsed behind a disclosure, mirroring
 * invite-create so the popover stays tidy.
 *
 * The role picker imports the client-safe `projectRole.options` — NEVER the
 * Prisma enum (ADR-0004, `verbatimModuleSyntax`). The mutation returns a typed
 * discriminated union; the three arms drive the three result messages. No
 * `<Toaster>` is mounted here (the single-Toaster rule, share-menu.tsx). #108
 * builds the full manage-access dialog and may relocate this input into it —
 * kept self-contained for that move.
 */

const ROLE_LABEL: Record<ProjectRoleInput, string> = {
  VIEWER: "Viewer",
  EDITOR: "Editor",
  ADMIN: "Admin",
};

type Notice = { kind: "success" | "info"; message: string };

export function MemberAdd({
  projectId,
}: {
  projectId: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<ProjectRoleInput>("VIEWER");
  const [notice, setNotice] = useState<Notice | null>(null);

  const grant = api.architecture.grantMemberByEmail.useMutation({
    onSuccess: (result, variables) => {
      switch (result.status) {
        case "granted": {
          const msg = `Added ${variables.email} as ${ROLE_LABEL[result.role]}.`;
          toast.success(msg);
          setNotice({ kind: "success", message: msg });
          setEmail("");
          break;
        }
        case "no_account": {
          const msg =
            "No account found for that email. Share an invite link instead.";
          toast(msg);
          setNotice({ kind: "info", message: msg });
          break;
        }
        case "already_owner": {
          const msg =
            "That’s the project owner — they already have full access.";
          toast(msg);
          setNotice({ kind: "info", message: msg });
          break;
        }
      }
    },
    onError: () => {
      const msg = "Couldn’t add that member. Please try again.";
      toast.error(msg);
      setNotice({ kind: "info", message: msg });
    },
  });

  function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (grant.isPending) return;
    const trimmed = email.trim();
    if (!trimmed) return;
    setNotice(null);
    grant.mutate({ projectId, email: trimmed, role });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center justify-center gap-2 rounded-lg bg-white/10 px-3 py-2 text-sm font-medium transition hover:bg-white/20"
      >
        <UserPlus size={14} aria-hidden />
        Add a member by email
      </button>
    );
  }

  return (
    <form onSubmit={handleAdd} className="flex flex-col gap-2.5">
      <label className="flex flex-col gap-1">
        <span className="text-white/60">Email</span>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="teammate@example.com"
          className="rounded-lg bg-white/10 px-3 py-2 text-white placeholder:text-white/40 focus:bg-white/15 focus:outline-none"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-white/60">Role</span>
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as ProjectRoleInput)}
          className="rounded-lg bg-white/10 px-3 py-2 text-white focus:bg-white/15 focus:outline-none"
        >
          {projectRole.options.map((opt) => (
            <option key={opt} value={opt} className="text-black">
              {ROLE_LABEL[opt]}
            </option>
          ))}
        </select>
      </label>
      <button
        type="submit"
        disabled={grant.isPending}
        className="inline-flex items-center justify-center gap-2 rounded-lg bg-[hsl(280,100%,70%)] px-3 py-2 text-sm font-semibold text-black transition hover:bg-[hsl(280,100%,80%)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {grant.isPending ? "Adding…" : "Add member"}
      </button>

      {notice && (
        <p
          className={`text-xs ${
            notice.kind === "success" ? "text-emerald-300/90" : "text-white/70"
          }`}
        >
          {notice.message}
        </p>
      )}
    </form>
  );
}

"use client";

import { Link2 } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import { toast } from "sonner";

import { CopyButton } from "~/app/_components/copy-button";
import { projectRole, type ProjectRoleInput } from "~/lib/schemas";
import { api } from "~/trpc/react";

/**
 * Admin-only invite-create section inside the ShareMenu (#106). Collapsed behind
 * a disclosure so the common copy-link case stays uncluttered; rendered in the
 * ShareMenu's `canManage` block (createInvite is ADMIN+). On generate, the raw
 * `infinv_…` token is revealed EXACTLY once in component-local state — never
 * cached, never refetchable — and the full `${origin}/i/${token}` URL is copyable
 * (the show-once precedent from connect-agent.tsx). Multiple links are creatable;
 * the prior reveal is simply replaced (the link still works, it's just no longer
 * re-displayable). The role picker imports the client-safe `projectRole.options`
 * — NEVER the Prisma enum (ADR-0004). No `<Toaster>` is mounted here (the
 * single-Toaster rule, share-menu.tsx).
 */

const ROLE_LABEL: Record<ProjectRoleInput, string> = {
  VIEWER: "Viewer",
  EDITOR: "Editor",
  ADMIN: "Admin",
};

const EXPIRY_OPTIONS = [
  { label: "7 days", value: "7" },
  { label: "30 days", value: "30" },
  { label: "90 days", value: "90" },
  { label: "Never", value: "never" },
] as const;

function expiryToDays(value: string): 7 | 30 | 90 | null {
  switch (value) {
    case "30":
      return 30;
    case "90":
      return 90;
    case "never":
      return null;
    default:
      return 7;
  }
}

const noopSubscribe = () => () => undefined;

export function InviteCreate({
  projectId,
}: {
  projectId: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<ProjectRoleInput>("VIEWER");
  const [expiry, setExpiry] = useState<string>("7");
  const [maxUses, setMaxUses] = useState<string>("");
  const [revealedToken, setRevealedToken] = useState<string | null>(null);

  // SSR-safe origin read (the repo's useSyncExternalStore pattern): a null server
  // snapshot avoids a hydration mismatch; the live origin resolves once mounted.
  const origin = useSyncExternalStore(
    noopSubscribe,
    () => window.location.origin,
    () => null,
  );
  const inviteUrl =
    revealedToken && origin ? `${origin}/i/${revealedToken}` : null;

  const createInvite = api.architecture.createInvite.useMutation({
    onSuccess: ({ token }) => {
      setRevealedToken(token);
      setRole("VIEWER");
      setExpiry("7");
      setMaxUses("");
    },
    onError: () => {
      toast.error("Couldn’t create the invite link. Please try again.");
    },
  });

  function handleGenerate(e: React.FormEvent) {
    e.preventDefault();
    if (createInvite.isPending) return;
    const parsed = Number.parseInt(maxUses, 10);
    createInvite.mutate({
      projectId,
      role,
      expiresInDays: expiryToDays(expiry),
      maxUses: Number.isFinite(parsed) && parsed > 0 ? parsed : null,
    });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="bg-muted hover:bg-muted inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition"
      >
        <Link2 size={14} aria-hidden />
        Create invite link
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      <form onSubmit={handleGenerate} className="flex flex-col gap-2.5">
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Role</span>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as ProjectRoleInput)}
            className="bg-muted text-foreground focus:bg-muted rounded-lg px-3 py-2 focus:outline-none"
          >
            {projectRole.options.map((opt) => (
              <option key={opt} value={opt} className="text-black">
                {ROLE_LABEL[opt]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Expiry</span>
          <select
            value={expiry}
            onChange={(e) => setExpiry(e.target.value)}
            className="bg-muted text-foreground focus:bg-muted rounded-lg px-3 py-2 focus:outline-none"
          >
            {EXPIRY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value} className="text-black">
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground">Max uses (optional)</span>
          <input
            type="number"
            min={1}
            value={maxUses}
            onChange={(e) => setMaxUses(e.target.value)}
            placeholder="Unlimited"
            className="bg-muted text-foreground placeholder:text-muted-foreground/70 focus:bg-muted rounded-lg px-3 py-2 focus:outline-none"
          />
        </label>
        <button
          type="submit"
          disabled={createInvite.isPending}
          className="bg-primary text-primary-foreground hover:bg-primary inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50"
        >
          {createInvite.isPending ? "Generating…" : "Generate invite link"}
        </button>
      </form>

      {expiry === "never" && (
        <p className="text-edit/80 text-xs">
          This link never expires — revoke it promptly if it’s ever leaked.
        </p>
      )}

      {inviteUrl && (
        <div className="border-primary/40 bg-primary/10 flex flex-col gap-2 rounded-lg border p-3">
          <p className="text-foreground text-xs font-semibold">
            Copy this invite link now
          </p>
          <p className="text-muted-foreground text-xs">
            This is the only time you’ll see it. If you lose it, create a new
            one.
          </p>
          <div className="flex items-center gap-2">
            <code className="bg-muted text-foreground flex-1 overflow-x-auto rounded px-2 py-1.5 font-mono text-xs">
              {inviteUrl}
            </code>
            <CopyButton
              value={inviteUrl}
              label="Copy"
              copiedLabel="Copied"
              className="bg-muted hover:bg-muted inline-flex items-center gap-1.5 rounded px-2.5 py-1.5 text-xs font-medium transition"
            />
          </div>
          <button
            type="button"
            onClick={() => setRevealedToken(null)}
            className="text-muted-foreground hover:text-foreground self-start text-xs underline-offset-2 transition hover:underline"
          >
            Done
          </button>
        </div>
      )}
    </div>
  );
}

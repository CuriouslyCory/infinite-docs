"use client";

import { ShieldCheck, Trash2, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogPanel,
  DialogTitle,
} from "~/components/ui/dialog";
import { projectRole, type ProjectRoleInput } from "~/lib/schemas";
import { api } from "~/trpc/react";

/**
 * The manage-access dialog (#108): the "manage existing access" surface — list
 * members + active invites, change roles, remove members, revoke links. Granting
 * new access (add-by-email #107, create-invite #106) stays in the ShareMenu
 * popover; this dialog reads-and-mutates the existing set.
 *
 * Admin-gated: ShareMenu only renders the trigger in its `canManage` block, and
 * the underlying `getProjectAccess` query is itself ADMIN+ (the same gate), so a
 * non-admin can neither see the button nor read the payload.
 *
 * The role picker imports the client-safe `projectRole` — NEVER the Prisma enum
 * (ADR-0004, `verbatimModuleSyntax`). No `<Toaster>` is mounted here (the
 * single-Toaster rule, share-menu.tsx); `toast()` surfaces via the route island's
 * Toaster. All three mutations live in this always-mounted island so their
 * optimistic callbacks fire even after a row unmounts.
 *
 * Mutations are keyed by `projectId`/`inviteId`, but the cache they update is
 * `getProjectAccess({ slug })` — the `{ slug }` key is closed over from the prop,
 * NOT read from the mutation variables.
 */

const ROLE_LABEL: Record<ProjectRoleInput, string> = {
  VIEWER: "Viewer",
  EDITOR: "Editor",
  ADMIN: "Admin",
};

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

function formatExpiry(expiresAt: Date | null): string {
  if (expiresAt === null) return "Never expires";
  const prefix = expiresAt.getTime() <= Date.now() ? "Expired " : "";
  return `${prefix}${dateFmt.format(expiresAt)}`;
}

function formatUses(useCount: number, maxUses: number | null): string {
  return maxUses == null ? `${useCount} uses` : `${useCount} / ${maxUses} uses`;
}

export function ManageAccessDialog({
  slug,
  projectId,
}: {
  slug: string;
  projectId: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const utils = api.useUtils();
  // Warm already (GuestAccessToggle fetches the same key); gate refetch to open.
  const access = api.architecture.getProjectAccess.useQuery(
    { slug },
    { enabled: open },
  );

  const updateRole = api.architecture.updateMemberRole.useMutation({
    onMutate: async ({ userId, role }) => {
      await utils.architecture.getProjectAccess.cancel({ slug });
      const previous = utils.architecture.getProjectAccess.getData({ slug });
      utils.architecture.getProjectAccess.setData({ slug }, (old) =>
        old
          ? {
              ...old,
              members: old.members.map((m) =>
                m.userId === userId ? { ...m, role } : m,
              ),
            }
          : old,
      );
      return { previous };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.previous)
        utils.architecture.getProjectAccess.setData({ slug }, ctx.previous);
      toast.error("Couldn’t change that member’s role. Please try again.");
    },
    onSuccess: () => toast.success("Role updated"),
    onSettled: () => utils.architecture.getProjectAccess.invalidate({ slug }),
  });

  const removeMember = api.architecture.removeMember.useMutation({
    onMutate: async ({ userId }) => {
      await utils.architecture.getProjectAccess.cancel({ slug });
      const previous = utils.architecture.getProjectAccess.getData({ slug });
      utils.architecture.getProjectAccess.setData({ slug }, (old) =>
        old
          ? { ...old, members: old.members.filter((m) => m.userId !== userId) }
          : old,
      );
      return { previous };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.previous)
        utils.architecture.getProjectAccess.setData({ slug }, ctx.previous);
      toast.error("Couldn’t remove that member. Please try again.");
    },
    onSuccess: () => toast.success("Member removed"),
    onSettled: () => utils.architecture.getProjectAccess.invalidate({ slug }),
  });

  const revokeInvite = api.architecture.revokeInvite.useMutation({
    onMutate: async ({ inviteId }) => {
      await utils.architecture.getProjectAccess.cancel({ slug });
      const previous = utils.architecture.getProjectAccess.getData({ slug });
      utils.architecture.getProjectAccess.setData({ slug }, (old) =>
        old
          ? { ...old, invites: old.invites.filter((i) => i.id !== inviteId) }
          : old,
      );
      return { previous };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.previous)
        utils.architecture.getProjectAccess.setData({ slug }, ctx.previous);
      toast.error("Couldn’t revoke that link. Please try again.");
    },
    onSuccess: () => toast.success("Invite revoked"),
    onSettled: () => utils.architecture.getProjectAccess.invalidate({ slug }),
  });

  const data = access.data;
  const viewerId = data?.viewerUserId;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center justify-center gap-2 rounded-lg bg-white/10 px-3 py-2 text-sm font-medium transition hover:bg-white/20"
      >
        <ShieldCheck size={14} aria-hidden />
        Manage access
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPanel className="w-[min(34rem,calc(100vw-2rem))]">
          <header className="flex flex-col gap-1 border-b border-white/10 px-5 py-4">
            <DialogTitle>Manage access</DialogTitle>
            <DialogDescription>
              Change roles, remove people, and revoke invite links.
            </DialogDescription>
          </header>

          <div className="flex-1 overflow-y-auto px-5 py-4">
            <section className="flex flex-col gap-2">
              <h3 className="text-xs font-semibold tracking-wide text-white/40 uppercase">
                People
              </h3>

              {data && (
                <div className="flex items-center justify-between gap-2 rounded-lg bg-white/5 px-3 py-2">
                  <span className="min-w-0 truncate text-sm text-white">
                    {data.owner.name ?? data.owner.email ?? "Owner"}
                    {data.owner.userId === viewerId && (
                      <span className="ml-1.5 text-xs text-white/40">
                        (You)
                      </span>
                    )}
                  </span>
                  <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs text-white/70">
                    Owner
                  </span>
                </div>
              )}

              {data?.members.length === 0 && (
                <p className="text-xs text-white/40">
                  No members yet — invite someone from the Share menu.
                </p>
              )}

              {data?.members.map((m) => {
                const isSelf = m.userId === viewerId;
                const label = m.name ?? m.email ?? m.userId;
                return (
                  <div
                    key={m.userId}
                    className="flex items-center justify-between gap-2 rounded-lg px-3 py-2 hover:bg-white/5"
                  >
                    <span className="min-w-0 truncate text-sm text-white">
                      {label}
                      {isSelf && (
                        <span className="ml-1.5 text-xs text-white/40">
                          (You)
                        </span>
                      )}
                    </span>
                    <div className="flex shrink-0 items-center gap-2">
                      <select
                        aria-label={`Role for ${label}`}
                        value={m.role}
                        disabled={updateRole.isPending}
                        onChange={(e) =>
                          updateRole.mutate({
                            projectId,
                            userId: m.userId,
                            role: e.target.value as ProjectRoleInput,
                          })
                        }
                        className="rounded-lg bg-white/10 px-2 py-1 text-sm text-white focus:bg-white/15 focus:outline-none disabled:opacity-50"
                      >
                        {projectRole.options.map((opt) => (
                          <option key={opt} value={opt} className="text-black">
                            {ROLE_LABEL[opt]}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        aria-label={`Remove ${label}`}
                        disabled={removeMember.isPending}
                        onClick={() => {
                          if (
                            isSelf &&
                            !window.confirm(
                              "Remove yourself from this project? You’ll lose access and this dialog will close.",
                            )
                          )
                            return;
                          removeMember.mutate({ projectId, userId: m.userId });
                          if (isSelf) setOpen(false);
                        }}
                        className="rounded p-1.5 text-red-300 transition hover:bg-red-500/10 hover:text-red-200 disabled:opacity-50"
                      >
                        <Trash2 size={15} aria-hidden />
                      </button>
                    </div>
                  </div>
                );
              })}
            </section>

            <section className="mt-5 flex flex-col gap-2 border-t border-white/10 pt-4">
              <h3 className="text-xs font-semibold tracking-wide text-white/40 uppercase">
                Invite links
              </h3>
              {data?.invites.length === 0 && (
                <p className="text-xs text-white/40">No active invite links.</p>
              )}
              {data?.invites.map((inv) => (
                <div
                  key={inv.id}
                  className="flex items-center justify-between gap-2 rounded-lg px-3 py-2 hover:bg-white/5"
                >
                  <div className="min-w-0">
                    <code className="font-mono text-xs text-white">
                      {inv.prefix}…
                    </code>
                    <p className="truncate text-xs text-white/50">
                      {ROLE_LABEL[inv.role]} · {formatExpiry(inv.expiresAt)} ·{" "}
                      {formatUses(inv.useCount, inv.maxUses)}
                    </p>
                  </div>
                  <button
                    type="button"
                    aria-label={`Revoke invite ${inv.prefix}`}
                    disabled={revokeInvite.isPending}
                    onClick={() => revokeInvite.mutate({ inviteId: inv.id })}
                    className="shrink-0 rounded p-1.5 text-red-300 transition hover:bg-red-500/10 hover:text-red-200 disabled:opacity-50"
                  >
                    <X size={15} aria-hidden />
                  </button>
                </div>
              ))}
            </section>
          </div>

          <footer className="flex justify-end border-t border-white/10 px-5 py-3">
            <DialogClose className="rounded px-3 py-1.5 text-sm text-white/70 transition hover:bg-white/5">
              Done
            </DialogClose>
          </footer>
        </DialogPanel>
      </Dialog>
    </>
  );
}

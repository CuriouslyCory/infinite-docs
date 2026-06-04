"use client";

import { Share2 } from "lucide-react";
import { useSyncExternalStore } from "react";
import { toast } from "sonner";

import { CopyButton } from "~/app/_components/copy-button";
import { InviteCreate } from "~/app/p/[slug]/_components/invite-create";
import { MemberAdd } from "~/app/p/[slug]/_components/member-add";
import { Popover, PopoverPanel, PopoverTrigger } from "~/components/ui/popover";
import { guestAccessLevel, type GuestAccessLevel } from "~/lib/schemas";
import { api } from "~/trpc/react";

const noopSubscribe = () => () => undefined;

/**
 * The Share menu in the Project header (#105). Renders for EVERY viewer — the
 * copy-link row is universal (all links are share links by default, philosophy
 * #3). Only the guest-access toggle INSIDE is gated on `canManage` (owner/ADMIN);
 * a viewer/anon sees just the copy-link row.
 *
 * Props are primitives only — `canManage` is derived server-side from the
 * Capability ladder, never the Capability/Prisma type, so the server module
 * graph stays out of the client bundle (ADR-0004/0040, `verbatimModuleSyntax`).
 *
 * No `<Toaster>` is mounted here: sonner's `toast()` is a global singleton
 * rendered by ANY mounted Toaster, and every route bearing this header already
 * mounts one in its island (canvas / trace). A second Toaster would DOUBLE-FIRE
 * the copy toast — so we rely on the existing island Toaster.
 */
export function ShareMenu({
  slug,
  projectId,
  canManage,
}: {
  slug: string;
  projectId: string;
  canManage: boolean;
}): React.JSX.Element {
  // SSR-safe href read (the repo's `useSyncExternalStore` pattern, cf.
  // mcp-instructions.tsx): a `null` server snapshot keeps the first client render
  // matching the server HTML (no hydration mismatch), then resolves to the live
  // current URL — including any interior node/trace segment — once mounted,
  // without a setState-in-effect cascade.
  const href = useSyncExternalStore(
    noopSubscribe,
    () => window.location.href,
    () => null,
  );
  const url = href ?? `/p/${slug}`;

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="flex items-center gap-1.5 rounded-full border border-white/15 bg-white/10 px-2.5 py-1 text-xs font-medium text-white/80 transition hover:bg-white/15 hover:text-white focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:outline-none"
          >
            <Share2 size={12} aria-hidden />
            Share
          </button>
        }
      />
      <PopoverPanel
        side="bottom"
        align="end"
        className="flex w-72 flex-col gap-3 rounded-xl border border-white/10 bg-[#1d1e3a] p-4 text-sm text-white shadow-xl"
      >
        <div className="flex flex-col gap-1.5">
          <span className="text-white/60">Share this project</span>
          <CopyButton
            value={url}
            label="Copy link"
            copiedLabel="Link copied"
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-white/10 px-3 py-2 text-sm font-medium transition hover:bg-white/20"
          />
        </div>
        {canManage && (
          <>
            <GuestAccessToggle slug={slug} projectId={projectId} />
            <InviteCreate projectId={projectId} />
            <MemberAdd projectId={projectId} />
          </>
        )}
      </PopoverPanel>
    </Popover>
  );
}

const OPTION_LABEL: Record<GuestAccessLevel, string> = {
  NONE: "None",
  VIEW: "View",
};

function GuestAccessToggle({
  slug,
  projectId,
}: {
  slug: string;
  projectId: string;
}): React.JSX.Element {
  const utils = api.useUtils();
  const access = api.architecture.getProjectAccess.useQuery({ slug });

  const setAccess = api.architecture.setGuestAccess.useMutation({
    onMutate: async ({ level }) => {
      await utils.architecture.getProjectAccess.cancel({ slug });
      const previous = utils.architecture.getProjectAccess.getData({ slug });
      // Spread preserves any fields #108 appends to the access object.
      utils.architecture.getProjectAccess.setData({ slug }, (old) =>
        old ? { ...old, guestAccess: level } : old,
      );
      return { previous };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.previous)
        utils.architecture.getProjectAccess.setData({ slug }, ctx.previous);
      toast.error("Couldn’t update guest access. Please try again.");
    },
    onSettled: () => utils.architecture.getProjectAccess.invalidate({ slug }),
  });

  const level = access.data?.guestAccess ?? "VIEW";

  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="text-white/60">Guest access</legend>
      {/*
        Native radio inputs (visually hidden, styled via their <label>) so the
        browser gives a real radiogroup for free: a single tab stop, arrow-key
        roving, and standard screen-reader announcements ("radio, 1 of 2") —
        none of which a button-based role="radio" gets without hand-rolled key
        handling. Selection-follows-focus is native radio behaviour; each change
        fires the optimistic mutation, which is reversible and idempotent.
      */}
      <div className="flex gap-1 rounded-lg bg-white/5 p-1">
        {guestAccessLevel.options.map((opt) => {
          const disabled = setAccess.isPending || !access.isSuccess;
          return (
            <label
              key={opt}
              className={`flex-1 rounded-md px-2 py-1 text-center text-xs transition focus-within:ring-2 focus-within:ring-white/40 ${
                disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"
              } ${
                level === opt
                  ? "bg-white/15 text-white"
                  : "text-white/60 hover:text-white"
              }`}
            >
              <input
                type="radio"
                name="guest-access"
                value={opt}
                checked={level === opt}
                disabled={disabled}
                onChange={() => setAccess.mutate({ projectId, level: opt })}
                className="sr-only"
              />
              {OPTION_LABEL[opt]}
            </label>
          );
        })}
      </div>
      <span className="text-xs text-white/40">
        {level === "VIEW"
          ? "Anyone with the link can view."
          : "Only you and invited members."}
      </span>
    </fieldset>
  );
}

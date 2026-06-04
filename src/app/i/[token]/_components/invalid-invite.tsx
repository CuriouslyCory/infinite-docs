import Link from "next/link";

/**
 * The single non-disclosing failure view for `/i/[token]` (#106). Rendered for
 * EVERY invalid claim — missing, expired, revoked, maxed, or an invite for a
 * soft-deleted project — with identical copy, so it never discloses which check
 * failed nor whether the project exists (ADR-0002/0040). Styled to match the
 * project not-found page. A pure server component (no `"use client"`).
 */
export function InvalidInvite(): React.JSX.Element {
  return (
    <main className="flex h-dvh flex-col items-center justify-center gap-4 bg-[#15162c] px-4 text-center text-white">
      <h1 className="text-3xl font-bold">Invite unavailable</h1>
      <p className="max-w-md text-white/60">
        This invite link is invalid or has expired. Ask the project owner for a
        new one.
      </p>
      <Link
        href="/"
        className="rounded-full bg-white/10 px-8 py-2 font-semibold no-underline transition hover:bg-white/20"
      >
        Go to your projects
      </Link>
    </main>
  );
}

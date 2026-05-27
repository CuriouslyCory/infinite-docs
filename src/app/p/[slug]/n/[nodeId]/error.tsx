"use client";

import Link from "next/link";
import { useParams } from "next/navigation";

/**
 * Error boundary for the interior Canvas route. The common trigger is a `nodeId`
 * that resolves to no live Node — a stale or shared link, a soft-deleted or
 * cross-project Component: `getCanvas` throws NOT_FOUND inside the island /
 * breadcrumb read, and a client suspense throw cannot call the server-only
 * `notFound()`, so the not-found UI lives here instead (ADR-0007). Showing it
 * for a bad scope is acceptable existence-hiding under ADR-0002 — the slug
 * already grants read to the whole Project, so a bad scope within it reveals
 * nothing about a foreign secret.
 */
export default function InteriorCanvasError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const { slug } = useParams<{ slug: string }>();

  return (
    <main className="flex h-dvh flex-col items-center justify-center gap-4 bg-[#15162c] px-6 text-center text-white">
      <h1 className="text-lg font-medium">This Canvas isn’t available</h1>
      <p className="max-w-sm text-sm text-white/60">
        The Component you tried to open isn’t here — it may have been removed,
        or the link is out of date.
      </p>
      <div className="flex items-center gap-3 text-sm">
        <button
          type="button"
          onClick={reset}
          className="rounded border border-white/20 px-3 py-1.5 transition hover:bg-white/10"
        >
          Try again
        </button>
        <Link
          href={`/p/${slug}`}
          className="rounded border border-white/20 px-3 py-1.5 no-underline transition hover:bg-white/10"
        >
          Back to the top-level Canvas
        </Link>
      </div>
    </main>
  );
}

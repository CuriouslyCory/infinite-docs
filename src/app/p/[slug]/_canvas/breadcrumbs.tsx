"use client";

import { ChevronRight } from "lucide-react";
import Link from "next/link";

import { api } from "~/trpc/react";

import { CopyCurrentScopeButton } from "./copy-markdown";

/**
 * The breadcrumb bar — the rendered navigation UI for a Canvas scope's ancestor
 * trail. CONTEXT.md splits the two: the *trail* is the `breadcrumbs` data, this
 * *bar* is the UI that renders it. It reads the SAME `getCanvas` query the
 * Canvas island reads (identical `{ slug, canvasNodeId }` key), so it shares
 * that one hydrated fetch — no extra round trip (ADR-0007).
 *
 * The Project is the presentational root crumb. The `breadcrumbs` data is
 * ordered root -> current with the current scope last, and is `[]` at the root
 * scope (no "root" sentinel ever lives in the data — that string is an island
 * key only). So at the root the Project title is the current crumb; deeper, the
 * Project links home and the trail's last entry is the current (non-link) crumb.
 *
 * Client-only and reads domain data only through the tRPC hooks — it never
 * imports `~/server` (ADR-0004). A crumb `title` is untrusted user content
 * rendered as plain text, never markup (prompt-injection standing note,
 * CONTEXT.md).
 */
export function Breadcrumbs({
  slug,
  canvasNodeId,
  projectTitle,
}: {
  slug: string;
  canvasNodeId: string | null;
  projectTitle: string;
}) {
  const [{ breadcrumbs }] = api.architecture.getCanvas.useSuspenseQuery({
    slug,
    canvasNodeId,
  });

  const atRoot = breadcrumbs.length === 0;

  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-sm">
      {atRoot ? (
        <span
          aria-current="page"
          className="max-w-[12rem] truncate font-medium"
        >
          {projectTitle}
        </span>
      ) : (
        <Link
          href={`/p/${slug}`}
          className="max-w-[12rem] truncate text-white/60 no-underline transition hover:text-white"
        >
          {projectTitle}
        </Link>
      )}
      {breadcrumbs.map((crumb, i) => {
        const isCurrent = i === breadcrumbs.length - 1;
        return (
          <span key={crumb.id} className="flex items-center gap-1">
            <ChevronRight
              size={14}
              aria-hidden
              className="shrink-0 text-white/30"
            />
            {isCurrent ? (
              <span
                aria-current="page"
                className="max-w-[12rem] truncate font-medium"
              >
                {crumb.title}
              </span>
            ) : (
              <Link
                href={`/p/${slug}/n/${crumb.id}`}
                className="max-w-[12rem] truncate text-white/60 no-underline transition hover:text-white"
              >
                {crumb.title}
              </Link>
            )}
          </span>
        );
      })}
      {/* Scope-anchored markdown copy (#15 / ADR-0017). At the root scope
          this exports the whole project; descended, it exports the current
          subtree with its self-describing Boundary context. */}
      <CopyCurrentScopeButton slug={slug} canvasNodeId={canvasNodeId} />
    </nav>
  );
}

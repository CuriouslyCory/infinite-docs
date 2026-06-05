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
  embedPath = [],
}: {
  slug: string;
  canvasNodeId: string | null;
  projectTitle: string;
  /**
   * The portal crossing stack (#119). Joins the getCanvas key (matching the
   * island/route exactly) and drives the host→portal→foreign spine: each crossed
   * portal is a non-link marker, and the active segment's links carry `?via=` so
   * they stay on the host URL.
   */
  embedPath?: string[];
}) {
  const [{ breadcrumbs, embedTrail, activeProject }] =
    api.architecture.getCanvas.useSuspenseQuery({
      slug,
      canvasNodeId,
      embedPath,
    });

  const inEmbed = embedPath.length > 0;
  // The `?via=` suffix every active-segment link must carry so descent stays on
  // the host URL and inside the same embedded project.
  const viaSuffix = inEmbed ? `?via=${embedPath.join(",")}` : "";
  // Inside an embed the active root is the FOREIGN project's root (foreign title);
  // outside, the active segment is the host project itself.
  const activeRootTitle = inEmbed ? activeProject.title : projectTitle;
  const activeRootHref = inEmbed ? `/p/${slug}${viaSuffix}` : `/p/${slug}`;
  // The active root is the current crumb only when there is no portal marker after
  // it AND no deeper foreign scope.
  const activeRootIsCurrent = breadcrumbs.length === 0;

  return (
    <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-sm">
      {/* Host project root. A link whenever we are anywhere below it (a deeper
          host scope, OR inside an embed — back returns to the host root). */}
      {!inEmbed && breadcrumbs.length === 0 ? (
        <span
          aria-current="page"
          className="max-w-[12rem] truncate font-medium"
        >
          {projectTitle}
        </span>
      ) : (
        <Link
          href={`/p/${slug}`}
          className="max-w-[12rem] truncate text-muted-foreground no-underline transition hover:text-foreground"
        >
          {projectTitle}
        </Link>
      )}

      {/* Crossed portals (#119): each is a non-link marker — the foreign slug is
          never exposed, and a portal has no own page. The marker delimits the host
          trail from the foreign spine. */}
      {embedTrail.map((portal) => (
        <span key={portal.id} className="flex items-center gap-1">
          <ChevronRight
            size={14}
            aria-hidden
            className="shrink-0 text-portal/50"
          />
          <span
            title="Embedded project"
            className="max-w-[10rem] truncate text-portal/70"
          >
            {portal.title}
          </span>
        </span>
      ))}

      {/* The active project's root crumb (foreign title when in an embed). Shown
          only inside an embed — outside, the host root above already IS it. */}
      {inEmbed && (
        <span className="flex items-center gap-1">
          <ChevronRight
            size={14}
            aria-hidden
            className="shrink-0 text-muted-foreground/60"
          />
          {activeRootIsCurrent ? (
            <span
              aria-current="page"
              className="max-w-[12rem] truncate font-medium"
            >
              {activeRootTitle}
            </span>
          ) : (
            <Link
              href={activeRootHref}
              className="max-w-[12rem] truncate text-muted-foreground no-underline transition hover:text-foreground"
            >
              {activeRootTitle}
            </Link>
          )}
        </span>
      )}

      {breadcrumbs.map((crumb, i) => {
        const isCurrent = i === breadcrumbs.length - 1;
        return (
          <span key={crumb.id} className="flex items-center gap-1">
            <ChevronRight
              size={14}
              aria-hidden
              className="shrink-0 text-muted-foreground/60"
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
                href={`/p/${slug}/n/${crumb.id}${viaSuffix}`}
                className="max-w-[12rem] truncate text-muted-foreground no-underline transition hover:text-foreground"
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

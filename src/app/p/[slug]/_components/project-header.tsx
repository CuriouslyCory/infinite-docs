import Link from "next/link";
import { Route } from "lucide-react";
import { Suspense } from "react";

import { Breadcrumbs } from "~/app/p/[slug]/_canvas/breadcrumbs";
import { ViewOnlyBadge } from "~/app/p/[slug]/_components/view-only-badge";

/**
 * The shared Project header, rendered identically by the root Canvas route
 * (`/p/[slug]`), the interior Canvas route (`/p/[slug]/n/[nodeId]`), and the
 * Trace view (`/p/[slug]/trace`). Extracted so the three headers cannot drift —
 * the back link, the breadcrumb trail, the always-enabled Trace button, and the
 * view-only badge live in exactly one place.
 *
 * Server component: `<Breadcrumbs>` is a client component kept inside its own
 * Suspense boundary exactly as before. The Trace button rides the capability
 * slug (ADR-0002) and is NOT gated on `canEdit` — any slug-holder (owner or
 * viewer) can open the Trace view (#57).
 */
export function ProjectHeader({
  slug,
  projectTitle,
  canvasNodeId,
  canEdit,
}: {
  slug: string;
  projectTitle: string;
  /** The current Canvas scope's Node id, or `null` at the root. */
  canvasNodeId: string | null;
  canEdit: boolean;
}) {
  return (
    <header className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
      <Link
        href="/"
        className="text-sm text-white/60 no-underline transition hover:text-white"
      >
        ← Projects
      </Link>
      <Suspense
        fallback={<span className="text-sm font-medium">{projectTitle}</span>}
      >
        <Breadcrumbs
          slug={slug}
          canvasNodeId={canvasNodeId}
          projectTitle={projectTitle}
        />
      </Suspense>
      <div className="ml-auto flex items-center gap-2">
        {!canEdit && <ViewOnlyBadge />}
        <Link
          href={`/p/${slug}/trace`}
          className="flex items-center gap-1.5 rounded-full border border-white/15 bg-white/10 px-2.5 py-1 text-xs font-medium text-white/80 no-underline transition hover:bg-white/15 hover:text-white"
          title="Open the Trace view"
        >
          <Route size={12} aria-hidden />
          Trace
        </Link>
      </div>
    </header>
  );
}

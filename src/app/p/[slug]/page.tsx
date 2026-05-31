import { TRPCError } from "@trpc/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { CanvasIsland } from "~/app/p/[slug]/_canvas";
import { Breadcrumbs } from "~/app/p/[slug]/_canvas/breadcrumbs";
import { ViewOnlyBadge } from "~/app/p/[slug]/_components/view-only-badge";
import { auth } from "~/server/auth";
import { HydrateClient, api } from "~/trpc/server";

/**
 * The Project route: the capability-URL slug as a path segment, landing on the
 * Project's top-level Canvas. Reachable WITHOUT a session — possession of the
 * unguessable slug is the read grant (ADR-0002). This is a server component
 * shell; the interactive Canvas is mounted beneath it as an SSR-disabled
 * client island (ADR-0004).
 */
export default async function ProjectPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const session = await auth();

  let project;
  try {
    project = await api.architecture.getProjectBySlug({ slug });
  } catch (error) {
    // A missing OR soft-deleted project both surface as NOT_FOUND, and we
    // render the same 404 — never revealing whether a slug exists-but-forbidden
    // (ADR-0002). Any other error propagates to the error boundary, so a DB
    // outage is not disguised as "project doesn't exist".
    if (error instanceof TRPCError && error.code === "NOT_FOUND") {
      notFound();
    }
    throw error;
  }

  const canEdit = session?.user?.id === project.ownerId;

  // Prefetch the root Canvas so the client island reads it from the hydration
  // cache with no extra round trip (ADR-0004 names this route as that seam). The
  // input MUST match the island's query key exactly — { slug, canvasNodeId: null }
  // — or hydration misses and the island silently refetches (a waterfall).
  void api.architecture.getCanvas.prefetch({ slug, canvasNodeId: null });

  return (
    <HydrateClient>
      <main className="flex h-dvh flex-col bg-[#15162c] text-white">
        <header className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
          <Link
            href="/"
            className="text-sm text-white/60 no-underline transition hover:text-white"
          >
            ← Projects
          </Link>
          {/* The breadcrumb bar reads the same hydrated getCanvas query the
              Canvas island reads (ADR-0007). At the root scope the trail is
              empty, so it renders just the Project title as the current crumb. */}
          <Suspense
            fallback={
              <span className="text-sm font-medium">{project.title}</span>
            }
          >
            <Breadcrumbs
              slug={slug}
              canvasNodeId={null}
              projectTitle={project.title}
            />
          </Suspense>
          {!canEdit && <ViewOnlyBadge />}
        </header>
        <div className="min-h-0 flex-1">
          <CanvasIsland
            canvasScope="root"
            slug={slug}
            projectId={project.id}
            canEdit={canEdit}
          />
        </div>
      </main>
    </HydrateClient>
  );
}

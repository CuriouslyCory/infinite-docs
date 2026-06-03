import { TRPCError } from "@trpc/server";
import { notFound } from "next/navigation";

import { ProjectHeader } from "~/app/p/[slug]/_components/project-header";
import { TraceIsland } from "~/app/p/[slug]/trace/trace-island";
import { auth } from "~/server/auth";
import { HydrateClient, api } from "~/trpc/server";

/**
 * The saved-**Trace** route (#59 / ADR-0035): a shareable URL for a named Trace,
 * `/p/[slug]/trace/[traceId]`. It rides the Project capability slug — any
 * slug-holder (owner or viewer) reaches it (ADR-0002); there is no write here, so
 * no `assertCanWrite`. The bearer-slug security headers are inherited from the
 * `/p/:path*` matcher in next.config.js.
 *
 * Reconciled single-render-path design: the route LOADS-INTO the working trace
 * rather than rendering a second, parallel "read directly from the Trace" path.
 * The shell prefetches `getTrace` (so the island seeds with no waterfall) plus
 * `listProjectComponents` + `getCanvas` (the working-set manager + breadcrumbs);
 * the island then seeds the working set from the Trace ONCE and the existing
 * #57/#58 working-set → `getTraceView` render path takes over identically. A
 * NotFound `getTrace` (foreign or soft-deleted traceId) → `notFound()`.
 */
export default async function SavedTracePage({
  params,
}: {
  params: Promise<{ slug: string; traceId: string }>;
}) {
  const { slug, traceId } = await params;
  const session = await auth();

  let project;
  try {
    project = await api.architecture.getProjectBySlug({ slug });
  } catch (error) {
    if (error instanceof TRPCError && error.code === "NOT_FOUND") {
      notFound();
    }
    throw error;
  }

  try {
    await api.architecture.getTrace({ slug, traceId });
  } catch (error) {
    if (error instanceof TRPCError && error.code === "NOT_FOUND") {
      notFound();
    }
    throw error;
  }

  const canEdit = session?.user?.id === project.ownerId;

  void api.architecture.getTrace.prefetch({ slug, traceId });
  void api.architecture.listProjectComponents.prefetch({ slug });
  void api.architecture.getCanvas.prefetch({ slug, canvasNodeId: null });

  return (
    <HydrateClient>
      <main className="flex h-dvh flex-col bg-[#15162c] text-white">
        <ProjectHeader
          slug={slug}
          projectTitle={project.title}
          canvasNodeId={null}
          canEdit={canEdit}
        />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <TraceIsland
            projectId={project.id}
            slug={slug}
            canEdit={canEdit}
            seedTraceId={traceId}
          />
        </div>
      </main>
    </HydrateClient>
  );
}

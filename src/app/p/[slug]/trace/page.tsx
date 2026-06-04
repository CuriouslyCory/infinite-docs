import { TRPCError } from "@trpc/server";
import { notFound } from "next/navigation";

import { ProjectHeader } from "~/app/p/[slug]/_components/project-header";
import { TraceIsland } from "~/app/p/[slug]/trace/trace-island";
import { capabilityAtLeast } from "~/server/architecture/access";
import { HydrateClient, api } from "~/trpc/server";

/**
 * The **Trace view** route (#57): a server-component shell over the SSR-disabled
 * working-set manager island (ADR-0004). It rides the Project capability slug —
 * any slug-holder (owner or viewer) reaches it (ADR-0002); there is no write
 * here, so no `assertCanWrite`. The bearer-slug security headers are inherited
 * from the `/p/:path*` matcher in next.config.js.
 *
 * This slice renders ONLY the working-set manager / empty state — the
 * cross-layer on-path graph is #58. The shell prefetches
 * `listProjectComponents` so the island resolves trace-point ids to titles, and
 * `getCanvas` so the header breadcrumbs hydrate, both from the hydration cache
 * with no waterfall (performance philosophy #1).
 */
export default async function TraceViewPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  let project;
  try {
    project = await api.architecture.getProjectBySlug({ slug });
  } catch (error) {
    if (error instanceof TRPCError && error.code === "NOT_FOUND") {
      notFound();
    }
    throw error;
  }

  const canEdit = capabilityAtLeast(project.viewerCapability, "edit");
  const canManage = capabilityAtLeast(project.viewerCapability, "admin");

  void api.architecture.listProjectComponents.prefetch({ slug });
  // The header's Breadcrumbs reads `getCanvas` with the same `{ slug,
  // canvasNodeId: null }` key; prefetch it so the bar hydrates without a
  // client-side round trip (performance philosophy #1).
  void api.architecture.getCanvas.prefetch({ slug, canvasNodeId: null });

  return (
    <HydrateClient>
      <main className="flex h-dvh flex-col bg-[#15162c] text-white">
        <ProjectHeader
          slug={slug}
          projectTitle={project.title}
          canvasNodeId={null}
          canEdit={canEdit}
          canManage={canManage}
          projectId={project.id}
        />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <TraceIsland projectId={project.id} slug={slug} canEdit={canEdit} />
        </div>
      </main>
    </HydrateClient>
  );
}

import { TRPCError } from "@trpc/server";
import { notFound } from "next/navigation";

import { CanvasIsland } from "~/app/p/[slug]/_canvas";
import { ProjectHeader } from "~/app/p/[slug]/_components/project-header";
import { capabilityAtLeast } from "~/server/architecture/access";
import { HydrateClient, api } from "~/trpc/server";

/**
 * The interior Canvas route — a Descent target addressed by the scope's Node id
 * under the Project's capability path (`/p/[slug]/n/[nodeId]`). The ancestor
 * trail is NOT in the URL: it is server-derived from this one id via the
 * recursive breadcrumb query (ADR-0006), so the segment carries only the scope
 * (ADR-0007). The bearer-slug security headers (Referrer-Policy / X-Robots-Tag /
 * Cache-Control) are inherited from the `/p/:path*` matcher in next.config.js
 * (ADR-0002/0004).
 *
 * Like the root route, this is a server-component shell over the SSR-disabled
 * Canvas island (ADR-0004). It prefetches the scoped `getCanvas` so the island
 * AND the breadcrumb bar read it from the hydration cache with no extra round
 * trip. A `nodeId` that resolves to no live Node in this Project throws
 * NOT_FOUND inside that read and is caught by `error.tsx` (ADR-0007).
 */
export default async function InteriorCanvasPage({
  params,
}: {
  params: Promise<{ slug: string; nodeId: string }>;
}) {
  const { slug, nodeId } = await params;

  let project;
  try {
    project = await api.architecture.getProjectBySlug({ slug });
  } catch (error) {
    // A missing, soft-deleted, OR access-denied Project all surface as the same
    // 404 (ADR-0002/0040); any other error propagates so a DB outage isn't
    // disguised as "not found".
    if (error instanceof TRPCError && error.code === "NOT_FOUND") {
      notFound();
    }
    throw error;
  }

  const canEdit = capabilityAtLeast(project.viewerCapability, "edit");
  const canManage = capabilityAtLeast(project.viewerCapability, "admin");

  // Seed the scoped Canvas so the island and the breadcrumb bar both read it
  // from the hydration cache — one fetch, no waterfall. The input MUST match the
  // island's derived key exactly ({ slug, canvasNodeId: nodeId }) or hydration
  // misses and the client silently refetches (ADR-0004/0007).
  void api.architecture.getCanvas.prefetch({ slug, canvasNodeId: nodeId });

  return (
    <HydrateClient>
      <main className="flex h-dvh flex-col bg-[#15162c] text-white">
        <ProjectHeader
          slug={slug}
          projectTitle={project.title}
          canvasNodeId={nodeId}
          canEdit={canEdit}
          canManage={canManage}
          projectId={project.id}
        />
        <div className="min-h-0 flex-1">
          <CanvasIsland
            canvasScope={nodeId}
            slug={slug}
            projectId={project.id}
            canEdit={canEdit}
          />
        </div>
      </main>
    </HydrateClient>
  );
}

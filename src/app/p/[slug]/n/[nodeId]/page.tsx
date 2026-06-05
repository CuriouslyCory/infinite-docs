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
  searchParams,
}: {
  params: Promise<{ slug: string; nodeId: string }>;
  searchParams: Promise<{ via?: string }>;
}) {
  const { slug, nodeId } = await params;
  // Project Portal crossing stack (#119): the ordered portal Node ids carried in
  // `?via=` (comma-separated). `[]` is an ordinary same-project Canvas. UNTRUSTED —
  // the server re-gates every crossing, so a forged chain collapses to NotFound at
  // the getCanvas re-gate; here it only shapes the prefetch + read-only flag.
  const { via } = await searchParams;
  const embedPath = via ? via.split(",").filter(Boolean) : [];

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

  // Read-only inside an embed this slice (#119): exploration of a foreign project
  // through a portal is view-only regardless of the actor's capability on the HOST
  // project. Force `canEdit` false whenever a crossing stack is present.
  const canEdit =
    embedPath.length === 0 &&
    capabilityAtLeast(project.viewerCapability, "edit");
  const canManage = capabilityAtLeast(project.viewerCapability, "admin");

  // Seed the scoped Canvas so the island and the breadcrumb bar both read it
  // from the hydration cache — one fetch, no waterfall. The input MUST match the
  // island's derived key exactly ({ slug, canvasNodeId: nodeId, embedPath }) or
  // hydration misses and the client silently refetches (ADR-0004/0007).
  void api.architecture.getCanvas.prefetch({
    slug,
    canvasNodeId: nodeId,
    embedPath,
  });

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
          embedPath={embedPath}
        />
        <div className="min-h-0 flex-1">
          <CanvasIsland
            canvasScope={nodeId}
            slug={slug}
            projectId={project.id}
            canEdit={canEdit}
            embedPath={embedPath}
          />
        </div>
      </main>
    </HydrateClient>
  );
}

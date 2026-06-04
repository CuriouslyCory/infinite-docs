import { TRPCError } from "@trpc/server";
import { notFound } from "next/navigation";

import { CanvasIsland } from "~/app/p/[slug]/_canvas";
import { ProjectHeader } from "~/app/p/[slug]/_components/project-header";
import { capabilityAtLeast } from "~/server/architecture/access";
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

  let project;
  try {
    project = await api.architecture.getProjectBySlug({ slug });
  } catch (error) {
    // A missing, soft-deleted, OR access-denied project (guestAccess=NONE for a
    // non-member) all surface as NOT_FOUND, and we render the same 404 — never
    // revealing whether a slug exists-but-forbidden (ADR-0002/0040). Any other
    // error propagates to the error boundary, so a DB outage is not disguised as
    // "project doesn't exist".
    if (error instanceof TRPCError && error.code === "NOT_FOUND") {
      notFound();
    }
    throw error;
  }

  // Derive the edit affordance from the server-resolved capability and pass a
  // plain boolean to the client island — the Capability type (whose module graph
  // reaches Prisma) never crosses into the client bundle (ADR-0040, ADR-0004).
  const canEdit = capabilityAtLeast(project.viewerCapability, "edit");
  const canManage = capabilityAtLeast(project.viewerCapability, "admin");

  // Prefetch the root Canvas so the client island reads it from the hydration
  // cache with no extra round trip (ADR-0004 names this route as that seam). The
  // input MUST match the island's query key exactly — { slug, canvasNodeId: null }
  // — or hydration misses and the island silently refetches (a waterfall).
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

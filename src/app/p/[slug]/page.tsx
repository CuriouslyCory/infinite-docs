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
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ via?: string }>;
}) {
  const { slug } = await params;
  // Project Portal crossing stack (#119): descending a portal lands on the host
  // ROOT URL with `?via=<portal ids>`, so the root route renders the FOREIGN
  // project's root Canvas while staying on the host slug. `[]` is the ordinary host
  // root. UNTRUSTED — the server re-gates every crossing (forged chain → NotFound).
  const { via } = await searchParams;
  const embedPath = via ? via.split(",").filter(Boolean) : [];

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
  // This boolean reflects the HOST capability only and is meaningful at the host
  // scope; inside a portal the island re-derives the edit affordance from the
  // FOREIGN project's capability (`activeProject.canEdit`) and owns the
  // foreign-scope UI, so we force this false there to avoid double-signalling
  // (#121, ADR-0042). `embedded` tells the header to defer to the island.
  const canEdit =
    embedPath.length === 0 &&
    capabilityAtLeast(project.viewerCapability, "edit");
  const canManage = capabilityAtLeast(project.viewerCapability, "admin");

  // Prefetch the root Canvas so the client island reads it from the hydration
  // cache with no extra round trip (ADR-0004 names this route as that seam). The
  // input MUST match the island's query key exactly — { slug, canvasNodeId: null,
  // embedPath } — or hydration misses and the island silently refetches.
  void api.architecture.getCanvas.prefetch({
    slug,
    canvasNodeId: null,
    embedPath,
  });

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
          embedPath={embedPath}
          embedded={embedPath.length > 0}
        />
        <div className="min-h-0 flex-1">
          <CanvasIsland
            canvasScope="root"
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

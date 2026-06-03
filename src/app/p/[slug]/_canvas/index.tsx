"use client";

import dynamic from "next/dynamic";

import { WorkingTraceProvider } from "~/app/p/[slug]/_trace/use-working-trace";

/**
 * Client wrapper for the Canvas island. Its only jobs: load the canvas with
 * `ssr: false` (the diagramming library is not server-renderable, and
 * `ssr: false` is disallowed inside a server component), and key the canvas by
 * its scope so the React Flow store fully re-seeds when the scope changes.
 *
 * `@xyflow/react` is imported only inside `./canvas`, behind this lazy
 * boundary, so it never enters the server render path or the page's first-load
 * bundle. See docs/adr/0004.
 */
const Canvas = dynamic(() => import("./canvas"), {
  ssr: false,
  loading: () => <div className="h-full w-full bg-[#1b1c33]" aria-hidden />,
});

export function CanvasIsland({
  canvasScope,
  slug,
  projectId,
  canEdit,
}: {
  canvasScope: string;
  slug: string;
  projectId: string;
  canEdit: boolean;
}) {
  // Key the lazily-loaded Canvas (which owns the ReactFlowProvider) so changing
  // the scope forces a full remount and a fresh store. The scope is "root" for
  // the Project's top-level Canvas and a canvasNodeId after a Descent; the keyed
  // remount guarantees the child Canvas never inherits the parent's viewport or
  // nodes.
  //
  // `slug` keys the capability read (getCanvas); `projectId` addresses the
  // owner-only create. Both are plain scalars passed from the server route — not
  // server modules — so no server graph crosses into this client island.
  // `canEdit` gates owner-only edit affordances (add, rename, delete, drag,
  // connect).
  // The working-trace store wraps the canvas island (not the keyed Canvas) so
  // the trace-point set survives a Descent remount; it is keyed by `projectId`
  // and reads the same `localStorage` set the Trace view reads (#57).
  return (
    <WorkingTraceProvider projectId={projectId}>
      <Canvas
        key={canvasScope}
        scope={canvasScope}
        slug={slug}
        projectId={projectId}
        canEdit={canEdit}
      />
    </WorkingTraceProvider>
  );
}

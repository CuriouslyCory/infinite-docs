"use client";

import dynamic from "next/dynamic";

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
}: {
  canvasScope: string;
  slug: string;
  projectId: string;
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
  return (
    <Canvas
      key={canvasScope}
      scope={canvasScope}
      slug={slug}
      projectId={projectId}
    />
  );
}

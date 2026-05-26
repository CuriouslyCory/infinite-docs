"use client";

import "@xyflow/react/dist/style.css";

import { Background, Controls, ReactFlow, ReactFlowProvider } from "@xyflow/react";

/**
 * The Canvas island — the ONLY module that statically imports `@xyflow/react`.
 * It is loaded via `next/dynamic({ ssr: false })` from `./index`, so the
 * diagramming library never runs on the server and never lands in the page's
 * first-load bundle. The stylesheet is imported locally here (not in
 * globals/layout) so it ships only with this lazy chunk. See docs/adr/0004.
 *
 * Empty for this slice: the Project has no Nodes yet (Components arrive in a
 * later slice), so we render the Project's top-level Canvas with nothing on it.
 * The `scope` prop identifies which Canvas this is ("root" for the top level)
 * and marks where the single-round-trip getCanvas payload will enter later.
 */
export default function Canvas({ scope }: { scope: string }) {
  return (
    <ReactFlowProvider>
      <div data-canvas-scope={scope} className="h-full w-full">
        <ReactFlow defaultNodes={[]} defaultEdges={[]}>
          <Background />
          <Controls />
        </ReactFlow>
      </div>
    </ReactFlowProvider>
  );
}

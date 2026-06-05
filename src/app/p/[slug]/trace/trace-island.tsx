"use client";

import dynamic from "next/dynamic";

import { WorkingTraceProvider } from "~/app/p/[slug]/_trace/use-working-trace";

/**
 * Client wrapper for the Trace view. Loads the working-set manager with
 * `ssr: false` (it reads `localStorage`, browser-only) and mounts its own
 * `WorkingTraceProvider` — a separate React tree from the canvas island, kept in
 * sync only through the per-Project `localStorage` set (ADR-0004 / #57).
 */
const TraceView = dynamic(
  () => import("./_trace-view").then((m) => m.TraceView),
  {
    ssr: false,
    loading: () => (
      <div className="px-6 py-20 text-center text-sm text-muted-foreground/70">
        Loading…
      </div>
    ),
  },
);

export function TraceIsland({
  projectId,
  slug,
  canEdit,
  seedTraceId,
}: {
  projectId: string;
  slug: string;
  canEdit: boolean;
  seedTraceId?: string;
}) {
  return (
    <WorkingTraceProvider projectId={projectId}>
      <TraceView slug={slug} canEdit={canEdit} seedTraceId={seedTraceId} />
    </WorkingTraceProvider>
  );
}

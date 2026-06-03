import { type McpReadInput } from "~/lib/schemas";

/**
 * The MCP read-resource catalog as plain data — NO SDK or service imports, so
 * both the SDK registration (`resources.ts`) and the `llms.txt` discovery route
 * render from one source and can never disagree. Keeping this dependency-free
 * also keeps the `llms.txt` route from pulling the MCP SDK into its bundle.
 *
 * Frozen at {index, project, subtree} for #18. Future read resources plug in
 * as a pure APPEND to {@link READ_RESOURCES} — no change to the registration
 * loop, the auth gate, the route, or `llms.txt`. The three map 1:1 to the
 * serializer's three modes (ADR-0017): they are the MCP-addressable face of
 * `Markdown export`, not a new data vocabulary.
 */

/** The custom URI scheme every MCP read resource is addressed under. */
export const RESOURCE_SCHEME = "architecture";
export const MARKDOWN_MIME = "text/markdown";

type UriVariables = Record<string, string | string[] | undefined>;

/** First value of a matched URI-template variable (templates yield strings). */
function uriVar(vars: UriVariables, key: string): string {
  const raw = vars[key];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value ?? "";
}

export interface McpReadResourceDescriptor {
  /** MCP resource name and first URI path segment, e.g. `"project"`. */
  name: string;
  /**
   * Which owner-gated service backs this descriptor's read. `"project"` (the
   * default) reads via `exportMarkdownForActor` using {@link toInput};
   * `"trace"` reads a saved Trace via `getTraceMarkdownForActor`. The dispatch
   * lives in `resources.ts` (not here) so this catalog stays dependency-free —
   * importing a service would pull the MCP/Prisma graph into the `llms.txt`
   * bundle.
   */
  kind: "project" | "trace";
  /** Human/agent-facing one-liner (shown in `resources/list` and `llms.txt`). */
  title: string;
  description: string;
  /** URI template after the scheme, e.g. `"project/{projectId}"`. */
  uriTemplate: string;
  /** Whether `resources/list` enumerates one entry per owner project. */
  enumerateProjects: boolean;
  /**
   * Maps matched URI variables to the owner-gated read input. Present only on
   * `kind: "project"` descriptors; the `trace` read derives its own
   * `{ traceId }` from the URI in `resources.ts`.
   */
  toInput?: (vars: UriVariables) => McpReadInput;
}

export const READ_RESOURCES: McpReadResourceDescriptor[] = [
  {
    name: "index",
    kind: "project",
    title: "Project index (cheap structural map)",
    description:
      "A cheap structural map of one project: every Component's title, kind, anchor, and connection count, indented by depth. No documentation bodies. Read this first to orient before fetching full bodies.",
    uriTemplate: "index/{projectId}",
    enumerateProjects: true,
    toInput: (vars) => ({
      projectId: uriVar(vars, "projectId"),
      canvasNodeId: null,
      mode: "index",
    }),
  },
  {
    name: "project",
    kind: "project",
    title: "Project architecture (full)",
    description:
      "The full architecture of one project as deterministic markdown: every Component with its authored documentation, plus a Connections section.",
    uriTemplate: "project/{projectId}",
    enumerateProjects: true,
    toInput: (vars) => ({
      projectId: uriVar(vars, "projectId"),
      canvasNodeId: null,
      mode: "full",
    }),
  },
  {
    name: "subtree",
    kind: "project",
    title: "Component subtree",
    description:
      "One Component and its descendants as deterministic markdown, with a Boundary context section naming the external systems it connects to — so a deep slice reads standalone. Address {nodeId} by the {#anchor} ids found in the index or project markdown.",
    uriTemplate: "subtree/{projectId}/{nodeId}",
    enumerateProjects: false,
    toInput: (vars) => ({
      projectId: uriVar(vars, "projectId"),
      canvasNodeId: uriVar(vars, "nodeId"),
      mode: "full",
    }),
  },
  {
    name: "trace",
    kind: "trace",
    title: "Saved Trace (cross-layer on-path subgraph)",
    description:
      "One saved Trace as deterministic markdown: every Component and Connection on a path between its trace points, expanded across all layers, with its trace-point endpoints listed. Owner-gated. Address {traceId} by the id from the trace's saved route (/p/<slug>/trace/<traceId>).",
    uriTemplate: "trace/{traceId}",
    enumerateProjects: false,
  },
];

/** First value of a matched URI-template variable — re-exported for the read dispatch. */
export { uriVar };

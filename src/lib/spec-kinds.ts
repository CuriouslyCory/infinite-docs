import {
  type FlowSpecKind,
  type NodeKind,
} from "~/lib/schemas";

/**
 * The client-safe FlowSpec-kind catalog: friendly label, paste placeholder, and
 * **spec-kind affinity** per `NodeKind` — which spec formats the "Attach spec"
 * picker offers a Component of a given kind. The sibling of `~/lib/node-kinds`
 * (which ranks child Component kinds); this one ranks the spec a Component can
 * attach. Imports only `~/lib/schemas` (Zod-only), so it is safe in the Canvas
 * island and any client component without dragging the server graph into the
 * browser bundle (ADR-0004).
 *
 * Affinity is PRESENTATION-ONLY (ADR-0019 precedent: ranking, never constraint).
 * The service accepts any `FlowSpecKind` on any Component regardless of kind —
 * kind stays cosmetic. This catalog only decides what the picker surfaces, and
 * an empty list hides the Attach-spec section entirely (nothing sensible to
 * attach to a Network or a Region).
 */

// Spec kind → user-facing label. The picker renders these instead of the raw
// enum value (`"OPENAPI"` → "OpenAPI", `"SQL_DDL"` → "SQL schema").
export const SPEC_KIND_LABEL: Record<FlowSpecKind, string> = {
  OPENAPI: "OpenAPI",
  ASYNCAPI: "AsyncAPI",
  GRAPHQL: "GraphQL SDL",
  SQL_DDL: "SQL schema",
  TS_SIGNATURE: "TypeScript signatures",
  CUSTOM: "Custom",
};

// Spec kind → textarea placeholder, so the paste field tells the user what
// shape of source each parser expects.
export const SPEC_KIND_PLACEHOLDER: Record<FlowSpecKind, string> = {
  OPENAPI: "Paste OpenAPI YAML or JSON…",
  ASYNCAPI: "Paste AsyncAPI YAML or JSON…",
  GRAPHQL: "Paste GraphQL SDL (type Query { … })…",
  SQL_DDL: "Paste SQL CREATE TABLE statements…",
  TS_SIGNATURE: "Paste TypeScript function / interface signatures…",
  CUSTOM: "Describe the contract in prose (stored as-is)…",
};

/**
 * **Spec-kind affinity** — the ordered structured spec kinds offered for a
 * Component of a given `NodeKind`. Exhaustive `Record<NodeKind, …>`, so adding a
 * `NodeKind` to the Zod enum fails to compile until it declares its spec
 * affinity (the same exhaustiveness guard `KIND_AFFINITY` uses). An empty list
 * means "no structured spec makes sense" — the picker hides for that kind.
 * `CUSTOM` is NOT listed here; `specKindsFor` appends it as a universal fallback
 * wherever the list is non-empty.
 */
export const SPEC_KIND_AFFINITY: Record<NodeKind, readonly FlowSpecKind[]> = {
  // Interface surfaces expose API contracts.
  EXTERNAL_API: ["OPENAPI", "GRAPHQL", "ASYNCAPI"],
  ENDPOINT: ["OPENAPI"],
  WEBHOOK: ["ASYNCAPI"],
  // Runtimes can expose any of an HTTP API, a GraphQL API, or code signatures.
  SERVICE: ["OPENAPI", "GRAPHQL", "TS_SIGNATURE"],
  MICROSERVICE: ["OPENAPI", "GRAPHQL", "TS_SIGNATURE"],
  APPLICATION: ["OPENAPI", "GRAPHQL", "TS_SIGNATURE"],
  // Code units expose callable signatures.
  MODULE: ["TS_SIGNATURE"],
  CLASS: ["TS_SIGNATURE"],
  FUNCTION: ["TS_SIGNATURE"],
  STORED_PROCEDURE: ["TS_SIGNATURE"],
  // Data surfaces expose tables.
  DATABASE: ["SQL_DDL"],
  TABLE: ["SQL_DDL"],
  // Messaging surfaces expose channels.
  QUEUE: ["ASYNCAPI"],
  TOPIC: ["ASYNCAPI"],
  CONSUMER: ["ASYNCAPI"],
  PRODUCER: ["ASYNCAPI"],
  // Infrastructure / structural kinds have no contract to attach — hide.
  GENERIC: [],
  GLOBAL_INFRA: [],
  REGION: [],
  DATACENTER: [],
  NETWORK: [],
  HOST: [],
  CONTAINER: [],
  CRON: [],
  VARIABLE: [],
  BRANCH: [],
};

/**
 * The spec kinds to offer a Component of `kind`, in display order. The affined
 * structured kinds first, then `CUSTOM` as a universal prose fallback — but only
 * when there is at least one structured kind, so kinds with no sensible spec
 * stay empty and the Attach-spec section hides entirely.
 */
export function specKindsFor(kind: NodeKind): FlowSpecKind[] {
  const affined = SPEC_KIND_AFFINITY[kind];
  if (affined.length === 0) return [];
  return [...affined, "CUSTOM"];
}

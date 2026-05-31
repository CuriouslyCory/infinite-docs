import {
  AppWindow,
  Box,
  Boxes,
  Braces,
  Cable,
  Clock,
  Cog,
  Container,
  Cpu,
  Database,
  Download,
  Earth,
  FileCode,
  GitBranch,
  Globe,
  HardDrive,
  Map,
  Megaphone,
  Network,
  Server,
  SquareFunction,
  Table,
  Upload,
  Variable,
  Webhook,
  type LucideIcon,
} from "lucide-react";

import { type NodeKind } from "~/lib/schemas";

/**
 * The client-safe Component-kind catalog: label, icon, and **kind affinity** for
 * every `NodeKind`. Each record is `Record<NodeKind, …>`, so adding a kind to the
 * Zod enum (`~/lib/schemas`) fails to compile until it gets a label, an icon, and
 * an affinity row here — the exhaustiveness check that keeps the catalog honest
 * the same way the service-layer parity guard keeps Prisma and Zod in lockstep
 * (CONTEXT.md "Component kind", "Kind affinity"; ADR-0018, ADR-0019).
 *
 * Imports only `~/lib/schemas` (a Zod-only module) and `lucide-react`, so it is
 * safe to import from the Canvas island and any client component without dragging
 * the server graph into the browser bundle (ADR-0004). Kind is cosmetic: nothing
 * here confers behaviour or authorization — it drives icon, label, and the order
 * the kind palette suggests.
 */

// Kind → user-facing label. Multi-word kinds are spelled out here, not derived
// (`EXTERNAL_API` → "External API", `STORED_PROCEDURE` → "Stored procedure").
// Exported so the boundary-group node labels its inherited members with the same
// vocabulary.
export const KIND_LABEL: Record<NodeKind, string> = {
  GENERIC: "Generic",
  GLOBAL_INFRA: "Global infrastructure",
  REGION: "Region",
  DATACENTER: "Data center",
  NETWORK: "Network",
  HOST: "Host",
  CONTAINER: "Container",
  SERVICE: "Service",
  MICROSERVICE: "Microservice",
  CRON: "Cron",
  QUEUE: "Queue",
  APPLICATION: "Application",
  MODULE: "Module",
  CLASS: "Class",
  FUNCTION: "Function",
  VARIABLE: "Variable",
  BRANCH: "Branch",
  DATABASE: "Database",
  TABLE: "Table",
  STORED_PROCEDURE: "Stored procedure",
  EXTERNAL_API: "External API",
  ENDPOINT: "Endpoint",
  WEBHOOK: "Webhook",
  TOPIC: "Topic",
  CONSUMER: "Consumer",
  PRODUCER: "Producer",
};

// Kind → icon. Kind is cosmetic (CONTEXT.md "Component kind"); this is the only
// place the kinds acquire a glyph. A finite `Record` keyed by `NodeKind` is not
// widened by `noUncheckedIndexedAccess`, so indexing it needs no guard. Shared
// by the Component node, the kind palette, and the boundary-proxy/-group nodes.
export const KIND_ICON: Record<NodeKind, LucideIcon> = {
  GENERIC: Box,
  GLOBAL_INFRA: Earth,
  REGION: Map,
  DATACENTER: Boxes,
  NETWORK: Network,
  HOST: Server,
  CONTAINER: Container,
  SERVICE: Cog,
  MICROSERVICE: Cpu,
  CRON: Clock,
  QUEUE: HardDrive,
  APPLICATION: AppWindow,
  MODULE: Braces,
  CLASS: FileCode,
  FUNCTION: SquareFunction,
  VARIABLE: Variable,
  BRANCH: GitBranch,
  DATABASE: Database,
  TABLE: Table,
  STORED_PROCEDURE: Cog,
  EXTERNAL_API: Globe,
  ENDPOINT: Cable,
  WEBHOOK: Webhook,
  TOPIC: Megaphone,
  CONSUMER: Download,
  PRODUCER: Upload,
};

// The full kind list in catalog order — concrete kinds tiered by where they sit
// in the hierarchy, `GENERIC` first as the catch-all default. The kind palette's
// "All kinds" section renders this order minus whatever the active scope's
// affinity already promoted.
export const KIND_ORDER: readonly NodeKind[] = [
  "GENERIC",
  "GLOBAL_INFRA",
  "REGION",
  "DATACENTER",
  "NETWORK",
  "HOST",
  "CONTAINER",
  "SERVICE",
  "MICROSERVICE",
  "CRON",
  "QUEUE",
  "APPLICATION",
  "MODULE",
  "CLASS",
  "FUNCTION",
  "VARIABLE",
  "BRANCH",
  "DATABASE",
  "TABLE",
  "STORED_PROCEDURE",
  "EXTERNAL_API",
  "ENDPOINT",
  "WEBHOOK",
  "TOPIC",
  "CONSUMER",
  "PRODUCER",
];

/**
 * The sentinel key for the Project root's affinity in `KIND_AFFINITY`: the root
 * Canvas has no parent Component, so there is no `NodeKind` to key its suggestions
 * against (CONTEXT.md "Kind affinity"). `suggestedKinds(null)` resolves to it.
 */
export const ROOT_AFFINITY_KEY = "ROOT" as const;

/**
 * **Kind affinity** — the ordered list of child kinds the picker promotes when a
 * Component is created or re-kinded inside a parent of a given kind (CONTEXT.md
 * "Kind affinity"; ADR-0019). Affinity is presentation-only: every kind stays
 * selectable below the affined ones, and the service accepts any kind regardless
 * of parent kind, so kind stays cosmetic. Keyed by `NodeKind` plus the `"ROOT"`
 * sentinel for the parentless root Canvas; an empty list means "no affinity — just
 * the alphabetic 'All kinds' tail."
 */
export const KIND_AFFINITY: Record<
  NodeKind | typeof ROOT_AFFINITY_KEY,
  readonly NodeKind[]
> = {
  ROOT: ["GLOBAL_INFRA", "DATACENTER", "REGION", "NETWORK", "HOST", "EXTERNAL_API"],
  GLOBAL_INFRA: ["DATACENTER", "REGION", "NETWORK", "EXTERNAL_API"],
  REGION: ["DATACENTER", "NETWORK", "HOST", "EXTERNAL_API"],
  DATACENTER: ["HOST", "NETWORK", "DATABASE", "QUEUE"],
  NETWORK: ["HOST", "EXTERNAL_API", "SERVICE"],
  HOST: ["CONTAINER", "SERVICE", "MICROSERVICE", "CRON"],
  CONTAINER: ["APPLICATION", "SERVICE", "MICROSERVICE", "CRON"],
  APPLICATION: ["MODULE", "SERVICE", "FUNCTION", "CLASS"],
  SERVICE: ["MODULE", "FUNCTION", "CLASS", "ENDPOINT"],
  MICROSERVICE: ["MODULE", "FUNCTION", "ENDPOINT"],
  MODULE: ["CLASS", "FUNCTION", "MODULE"],
  CLASS: ["FUNCTION", "VARIABLE"],
  FUNCTION: ["BRANCH", "VARIABLE", "FUNCTION"],
  BRANCH: ["VARIABLE", "BRANCH", "FUNCTION"],
  CRON: ["FUNCTION", "MODULE"],
  DATABASE: ["TABLE", "STORED_PROCEDURE"],
  STORED_PROCEDURE: ["VARIABLE", "BRANCH"],
  EXTERNAL_API: ["ENDPOINT", "WEBHOOK"],
  QUEUE: ["TOPIC", "CONSUMER", "PRODUCER"],
  // Terminal-ish kinds: no affinity, only the alphabetic "All kinds" tail.
  GENERIC: [],
  TABLE: [],
  ENDPOINT: [],
  WEBHOOK: [],
  TOPIC: [],
  CONSUMER: [],
  PRODUCER: [],
  VARIABLE: [],
};

/**
 * Splits the full kind set into the affined "suggested" kinds for a parent kind
 * (`null` => the Project root) and the alphabetically-labelled remainder. The
 * kind palette renders `suggested` above a separator and `rest` below; the union
 * is always every kind, so search reaches all of them regardless of affinity.
 */
export function suggestedKinds(parentKind: NodeKind | null): {
  suggested: NodeKind[];
  rest: NodeKind[];
} {
  const suggested = [
    ...KIND_AFFINITY[parentKind ?? ROOT_AFFINITY_KEY],
  ];
  const promoted = new Set(suggested);
  const rest = KIND_ORDER.filter((k) => !promoted.has(k)).sort((a, b) =>
    KIND_LABEL[a] < KIND_LABEL[b] ? -1 : KIND_LABEL[a] > KIND_LABEL[b] ? 1 : 0,
  );
  return { suggested, rest };
}

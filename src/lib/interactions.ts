import { type Interaction } from "~/lib/schemas";

/**
 * The client-safe **Interaction** catalog: the user-facing label and a one-line
 * hint for every `Interaction`. Each record is `Record<Interaction, …>`, so
 * adding a value to the Zod `interaction` enum (`~/lib/schemas`) fails to compile
 * until it gets a label and a hint here — the same exhaustiveness guard
 * `KIND_LABEL` gives the Component-kind catalog (`~/lib/node-kinds.ts`).
 *
 * Imports only `~/lib/schemas` (a Zod-only module), so the interaction picker can
 * read it from the Canvas island without dragging the server graph into the
 * browser bundle (ADR-0004). The picker labels the value "Interaction", never
 * "type" — `interaction` is the Connection's typing axis but the word "type" is
 * reserved (React Flow's node-type registry key; CONTEXT.md).
 */

// Interaction → user-facing label, phrased from the source endpoint's
// perspective (CONTEXT.md "Interaction").
export const INTERACTION_LABEL: Record<Interaction, string> = {
  ASSOCIATION: "Association",
  REQUEST: "Request / response",
  PUSH: "Push",
  SUBSCRIBE: "Subscribe",
  DUPLEX: "Duplex",
};

// Interaction → one-line hint for the picker, naming the concrete protocols each
// value models (CONTEXT.md "Interaction"; src/lib/schemas.ts).
export const INTERACTION_HINT: Record<Interaction, string> = {
  ASSOCIATION: "Plain relationship — no direction",
  REQUEST: "Source calls the target (REST, RPC, GraphQL)",
  PUSH: "Source emits unprompted (SSE, webhook, event)",
  SUBSCRIBE: "Source consumes a stream or feed",
  DUPLEX: "Two-way (WebSocket)",
};

// The picker's option order: ASSOCIATION (the default) first, then the four
// directional interactions. A finite `Record` keyed by `Interaction` is not
// widened by `noUncheckedIndexedAccess`, so indexing the maps above needs no
// guard; this ordered list drives the segmented control's render order.
export const INTERACTION_ORDER: readonly Interaction[] = [
  "ASSOCIATION",
  "REQUEST",
  "PUSH",
  "SUBSCRIBE",
  "DUPLEX",
];

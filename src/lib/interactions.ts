import {
  ArrowLeftRight,
  Cable,
  Radio,
  Rss,
  type LucideIcon,
} from "lucide-react";

import { type Interaction } from "~/lib/schemas";

/**
 * The client-safe **Interaction** catalog: the user-facing label, a one-line
 * hint, and a resting-canvas glyph for every `Interaction`. Each record is
 * `Record<Interaction, …>`, so adding a value to the Zod `interaction` enum
 * (`~/lib/schemas`) fails to compile until it gets a label, a hint, and a glyph
 * here — the same exhaustiveness guard `KIND_LABEL` gives the Component-kind
 * catalog (`~/lib/node-kinds.ts`).
 *
 * Imports only `~/lib/schemas` (a Zod-only module) and `lucide-react`, so the
 * interaction picker can read it from the Canvas island without dragging the
 * server graph into the browser bundle (ADR-0004) — the same client-safe pairing
 * `~/lib/node-kinds.ts` relies on for `KIND_ICON`. The picker labels the value
 * "Interaction", never "type" — `interaction` is the Connection's typing axis but
 * the word "type" is reserved (React Flow's node-type registry key; CONTEXT.md).
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

// Interaction → resting-edge glyph (ADR-0039). A directional interaction carries
// a small kind badge so a labelled or unlabelled edge reads at a glance; the
// glyph is a *kind* cue, never a direction signal — the arrowhead derived from
// `arrowEnds(interaction, source, target)` (ADR-0027) remains the only direction.
// `ASSOCIATION` is `null` on purpose: a plain relationship stays bare so a canvas
// of associations reads quiet. Keyed `Record<Interaction, …>` so a new value
// fails to compile until it gets a glyph — the same guard as the maps above, and
// the `KIND_ICON` precedent in `~/lib/node-kinds.ts`.
export const INTERACTION_GLYPH: Record<Interaction, LucideIcon | null> = {
  ASSOCIATION: null,
  REQUEST: ArrowLeftRight,
  PUSH: Radio,
  SUBSCRIBE: Rss,
  DUPLEX: Cable,
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

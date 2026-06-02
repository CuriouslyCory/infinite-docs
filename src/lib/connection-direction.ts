import { type Interaction } from "~/lib/schemas";

/**
 * The single source of truth for a Connection's arrowheads — the successor to the
 * retired `~/lib/flow-direction` helper (ADR-0027). It maps an **Interaction** to
 * which END of the Connection bears an arrow, framework-agnostically:
 *
 *   REQUEST | PUSH → arrow at the target end (source calls / emits to target);
 *   SUBSCRIBE      → arrow at the source end (source consumes the target's stream);
 *   DUPLEX         → arrows at both ends (two-way, e.g. a WebSocket);
 *   ASSOCIATION    → neither end (a plain undirected line).
 *
 * It takes ONLY `interaction`. Which physical Component each arrow lands on is
 * bound by the Edge's stored `source`/`target` draw order at render time — the
 * canvas attaches `atSource`→`markerStart` (the source end) and `atTarget`→
 * `markerEnd` (the target end), so the arrow "points the way it was drawn" without
 * this helper ever seeing the endpoint ids (ADR-0027: arrows are *derived* from
 * `(interaction, source, target)`, never a stored direction).
 *
 * Lives in `~/lib` and imports nothing but the client-safe `Interaction` type (no
 * `~/server`, no `@xyflow/react`, no generated Prisma client): the Canvas island
 * derives React Flow markers from it (ADR-0004 keeps the server graph and the
 * diagramming library out of `~/lib`), and the markdown exporter derives the
 * `→` / `←` / `↔` / `—` glyph from the SAME booleans (#67) — one mapping, two
 * consumers (ADR-0027). Do NOT add a React Flow `MarkerType` here; that mapping is
 * the island's job.
 */
export interface ArrowEnds {
  atSource: boolean;
  atTarget: boolean;
}

/** Derives which ends of a Connection bear an arrow, from its Interaction alone. */
export function arrowEnds(interaction: Interaction): ArrowEnds {
  switch (interaction) {
    case "REQUEST":
    case "PUSH":
      return { atSource: false, atTarget: true };
    case "SUBSCRIBE":
      return { atSource: true, atTarget: false };
    case "DUPLEX":
      return { atSource: true, atTarget: true };
    case "ASSOCIATION":
      return { atSource: false, atTarget: false };
  }
}

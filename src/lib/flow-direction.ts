import { type FlowInteraction } from "~/lib/schemas";

/**
 * The single source of truth for deriving a Connection's arrow direction from
 * the Flows routed on it (ADR-0023, which supersedes ADR-0009/0013). A
 * Connection is an unordered association between two Components; its arrowheads
 * are NEVER stored — they are computed, per routed Flow, from the Flow's
 * owner-relative `interaction` and which endpoint owns it:
 *
 *   REQUEST   — owner is called → arrow points AT the owner
 *   SUBSCRIBE — owner consumes  → arrow points AT the owner
 *   PUSH      — owner emits      → arrow points AWAY from the owner
 *   DUPLEX    — both             → arrows at BOTH ends
 *
 * A Connection's rendered arrowheads are the union of these over its active
 * routed Flows: none → plain undirected line, one direction → one arrowhead,
 * both → arrowheads at both ends (the WebSocket case, on a single Connection).
 *
 * Pure and client-safe (imports only the `~/lib/schemas` value enum), so the
 * server aggregation, the optimistic canvas delta, and the markdown exporter
 * all share one rule. `pointsAtA` / `pointsAtB` name the Edge's two endpoints
 * generically — the stored endpoint order is arbitrary and carries no meaning.
 */
export function flowArrowEndpoints(
  ownerIsEndpointA: boolean,
  interaction: FlowInteraction,
): { pointsAtA: boolean; pointsAtB: boolean } {
  const atOwner = interaction === "REQUEST" || interaction === "SUBSCRIBE";
  const awayFromOwner = interaction === "PUSH";
  const both = interaction === "DUPLEX";

  const pointsAtOwner = atOwner || both;
  const pointsAtOther = awayFromOwner || both;

  return ownerIsEndpointA
    ? { pointsAtA: pointsAtOwner, pointsAtB: pointsAtOther }
    : { pointsAtA: pointsAtOther, pointsAtB: pointsAtOwner };
}

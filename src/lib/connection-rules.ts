/**
 * Pure topology rules for drawing a Connection — the no-database half of the
 * Connection invariants (CONTEXT.md "Connection"/"Edge"; ADR-0027, ADR-0028).
 *
 * Lives in `~/lib` and imports nothing (no `~/server`, no `@xyflow/react`, no
 * generated Prisma client), so the Canvas island can consume it for instant
 * drag feedback without pulling the server graph into the browser bundle
 * (ADR-0004), and a future MCP tool can reuse the SAME rules — it takes plain
 * endpoint ids, never React Flow's `Connection` or a `temp_` optimistic id.
 *
 * This MIRRORS a subset of the service's `connectNodes` invariants for UX only;
 * `connectNodes` stays the single source of truth (it also enforces live
 * endpoints and ownership against the database, none of which are knowable
 * here). Do NOT refactor `connectNodes` to import this — the MCP path does not
 * pass through the client, so the service must stand alone (ADR-0001). The two
 * rules that ARE pure topology — no self-link and no duplicate against the
 * current Connection set — live here, in one tested place.
 *
 * Scope: this mirrors the ASSOCIATION de-dupe rule, the only interaction the web
 * client DRAWS. An ASSOCIATION's key is the UNORDERED endpoint pair, so A→B and
 * B→A are the SAME Connection (ADR-0027); this helper sees only endpoint ids and
 * matches that unordered rule. #65's interaction picker UPGRADES an existing
 * Connection (an `updateEdgeInteraction` edit, which does not pass through this
 * draw-time check), so it needs no `interaction` arm here. A gesture that DRAWS a
 * directional Connection up front (the #66 "Connect to…" surface) is what would
 * grow this arm: directional interactions de-dupe on the ORDERED triple
 * `(source, target, interaction)`, so a directional A→B must NOT be rejected just
 * because an ASSOCIATION A↔B already exists (see `activeDuplicateWhere` in
 * `edge.service.ts`).
 */

/** A Connection a user is proposing to draw, by endpoint Node id. */
export type ProposedConnection = { source: string; target: string };

/** An existing Connection in the current set, by endpoint Node id (unordered). */
export type ExistingConnection = { source: string; target: string };

export type ConnectionRejection = "self-link" | "duplicate";

export type ConnectionCheck =
  | { ok: true }
  | { ok: false; reason: ConnectionRejection };

/**
 * Decides whether `proposed` may be drawn given the Canvas's current
 * Connections. Rejects a self-link (an endpoint to itself) and a duplicate (an
 * active Connection between the same UNORDERED pair already present — A→B and
 * B→A are the same ASSOCIATION; ADR-0027). The caller maps its own edge shape
 * into `ExistingConnection[]` and decides how to surface a rejection (a toast,
 * a snap-back, a thrown error).
 */
export function canConnect(
  proposed: ProposedConnection,
  existing: readonly ExistingConnection[],
): ConnectionCheck {
  if (proposed.source === proposed.target) {
    return { ok: false, reason: "self-link" };
  }
  if (
    existing.some(
      (e) =>
        (e.source === proposed.source && e.target === proposed.target) ||
        (e.source === proposed.target && e.target === proposed.source),
    )
  ) {
    return { ok: false, reason: "duplicate" };
  }
  return { ok: true };
}

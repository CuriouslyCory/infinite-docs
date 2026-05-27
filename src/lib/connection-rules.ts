/**
 * Pure topology rules for drawing a Connection — the no-database half of the
 * Connection invariants (CONTEXT.md "Connection"/"Edge"/"Port"; ADR-0005,
 * ADR-0009).
 *
 * Lives in `~/lib` and imports nothing (no `~/server`, no `@xyflow/react`, no
 * generated Prisma client), so the Canvas island can consume it for instant
 * drag feedback without pulling the server graph into the browser bundle
 * (ADR-0004), and a future MCP tool can reuse the SAME rules — it takes plain
 * endpoint ids, never React Flow's `Connection` or a `temp_` optimistic id.
 *
 * This MIRRORS a subset of the service's `connectNodes` invariants for UX only;
 * `connectNodes` stays the single source of truth (it also enforces same-Canvas,
 * live endpoints, and ownership against the database, none of which are knowable
 * here). Do NOT refactor `connectNodes` to import this — the MCP path does not
 * pass through the client, so the service must stand alone (ADR-0001). The two
 * rules that ARE pure topology — no self-link and no duplicate against the
 * current Connection set — live here, in one tested place.
 *
 * Output→input is deliberately NOT re-checked here: a Connection can only run
 * output Port → input Port, but that is enforced structurally by React Flow's
 * strict `connectionMode` (a drag can only go from a `source` handle to a
 * `target` handle). This helper sees only endpoint ids, not which Port a drag
 * started from, so the rule would be unverifiable theater. The de-dupe key is
 * the ORDERED pair, so A→B and B→A are distinct — that ordering IS the
 * direction (ADR-0009).
 */

/** A Connection a user is proposing to draw, by endpoint Node id. */
export type ProposedConnection = { source: string; target: string };

/** An existing Connection on the same Canvas, by endpoint Node id. */
export type ExistingConnection = { source: string; target: string };

export type ConnectionRejection = "self-link" | "duplicate";

export type ConnectionCheck =
  | { ok: true }
  | { ok: false; reason: ConnectionRejection };

/**
 * Decides whether `proposed` may be drawn given the Canvas's current
 * Connections. Rejects a self-link (an endpoint to itself) and a duplicate (an
 * active Connection with the same ordered source→target already present). The
 * caller maps its own edge shape into `ExistingConnection[]` and decides how to
 * surface a rejection (a toast, a snap-back, a thrown error).
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
      (e) => e.source === proposed.source && e.target === proposed.target,
    )
  ) {
    return { ok: false, reason: "duplicate" };
  }
  return { ok: true };
}

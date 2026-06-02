import type { ParsedComponent } from "~/lib/schemas";

/**
 * Anti-OOM safety bounds, NOT feature limits (#64 / ADR-0029). A pasted Spec is
 * untrusted: even after the 2 MB source cap, a small document can describe a
 * pathological number of components or nest absurdly deep. These caps turn that
 * into one clean `parseError` (generate nothing) instead of an unbounded graph.
 * Sized far past any real-world API/schema while still bounding the blast radius.
 */
export const MAX_PARSED_NODES = 5_000;
export const MAX_TREE_DEPTH = 8;

class BoundError extends Error {}

/**
 * Validates a parsed tree against the safety bounds AND the cross-tree `specKey`
 * uniqueness invariant the diff relies on (a key is a Component's identity for
 * re-parse matching, so two nodes cannot share one — child keys are qualified by
 * their parent's to guarantee this). Returns a `parseError` string on any breach
 * rather than throwing past the parser boundary.
 */
export function enforceBounds(
  tree: ParsedComponent[],
): { ok: true } | { ok: false; parseError: string } {
  let count = 0;
  const seen = new Set<string>();

  const walk = (nodes: ParsedComponent[], depth: number): void => {
    if (depth > MAX_TREE_DEPTH) {
      throw new BoundError(
        `Spec nests deeper than the ${MAX_TREE_DEPTH}-level safety bound.`,
      );
    }
    for (const node of nodes) {
      count += 1;
      if (count > MAX_PARSED_NODES) {
        throw new BoundError(
          `Spec describes more than the ${MAX_PARSED_NODES}-component safety bound.`,
        );
      }
      if (seen.has(node.specKey)) {
        throw new BoundError(
          `Spec produced a duplicate identity "${node.specKey}" — cannot match it on re-parse.`,
        );
      }
      seen.add(node.specKey);
      if (node.children && node.children.length > 0) {
        walk(node.children, depth + 1);
      }
    }
  };

  try {
    walk(tree, 1);
    return { ok: true };
  } catch (error) {
    if (error instanceof BoundError) {
      return { ok: false, parseError: error.message };
    }
    throw error;
  }
}

import { Kind, parse, print } from "graphql";
import type { DefinitionNode, FieldDefinitionNode } from "graphql";

import { type FlowInteraction } from "~/lib/schemas";

import {
  type ParsedFlow,
  type ParseFlowSpecResult,
} from "../shared";

/**
 * GraphQL SDL loader. Materializes one Flow per ROOT field — the fields on the
 * Query / Mutation / Subscription object types (and their `extend type`
 * extensions), which are the routable units a GraphQL API exposes, the direct
 * analog of OpenAPI operations. Non-root types are the payload shapes those
 * fields return; they are not themselves routable, so they are not extracted.
 *
 * Parse-only via graphql-js `parse` (no schema build, no validation, no
 * execution, `noLocation` to drop position bloat). Root type NAMES honor an
 * explicit `schema { query: X }` definition, else default to the conventional
 * Query/Mutation/Subscription. Interaction is owner-relative (ADR-0023):
 * query/mutation are REQUEST (the caller depends on the owner), subscription is
 * PUSH (the owner streams results outward).
 */

const MAX_FIELDS = 500;

type RootOperation = "query" | "mutation" | "subscription";

const INTERACTION_BY_OPERATION: Record<RootOperation, FlowInteraction> = {
  query: "REQUEST",
  mutation: "REQUEST",
  subscription: "PUSH",
};

export function parseGraphql(source: string): ParseFlowSpecResult {
  let definitions: readonly DefinitionNode[];
  try {
    definitions = parse(source, { noLocation: true }).definitions;
  } catch {
    return {
      parseError: "Couldn't parse spec as GraphQL — input is not valid SDL.",
    };
  }

  const rootTypeNames = resolveRootTypeNames(definitions);
  // Reverse lookup: type name → which root operation it serves.
  const operationByTypeName = new Map<string, RootOperation>();
  for (const op of ["query", "mutation", "subscription"] as const) {
    operationByTypeName.set(rootTypeNames[op], op);
  }

  const flows: ParsedFlow[] = [];
  for (const def of definitions) {
    if (
      def.kind !== Kind.OBJECT_TYPE_DEFINITION &&
      def.kind !== Kind.OBJECT_TYPE_EXTENSION
    ) {
      continue;
    }
    // The kind guard above narrows `def` to the object-type union.
    const operation = operationByTypeName.get(def.name.value);
    if (!operation) continue;

    for (const field of def.fields ?? []) {
      if (flows.length >= MAX_FIELDS) {
        return {
          parseError: `Couldn't parse spec as GraphQL — field count exceeds the cap (${MAX_FIELDS}).`,
        };
      }
      flows.push(toFlow(operation, def.name.value, field));
    }
  }

  return { flows };
}

function toFlow(
  operation: RootOperation,
  rootTypeName: string,
  field: FieldDefinitionNode,
): ParsedFlow {
  return {
    kind: "GRAPHQL_FIELD",
    key: `${rootTypeName}.${field.name.value}`,
    title: field.name.value,
    interaction: INTERACTION_BY_OPERATION[operation],
    signature: {
      operation,
      arguments: (field.arguments ?? []).map((arg) => print(arg)),
      returns: print(field.type),
    },
  };
}

// Default root type names, overridden by an explicit `schema { ... }` block.
function resolveRootTypeNames(
  definitions: readonly DefinitionNode[],
): Record<RootOperation, string> {
  const names: Record<RootOperation, string> = {
    query: "Query",
    mutation: "Mutation",
    subscription: "Subscription",
  };
  for (const def of definitions) {
    if (
      def.kind !== Kind.SCHEMA_DEFINITION &&
      def.kind !== Kind.SCHEMA_EXTENSION
    ) {
      continue;
    }
    for (const opType of def.operationTypes ?? []) {
      names[opType.operation] = opType.type.name.value;
    }
  }
  return names;
}

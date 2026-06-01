import { type FlowInteraction } from "~/lib/schemas";

import {
  MAX_DEPTH,
  exceedsDepth,
  isPlainObject,
  loadAsYamlOrJson,
  type ParsedFlow,
  type ParseFlowSpecResult,
} from "../shared";

/**
 * AsyncAPI loader. Materializes one Flow per channel operation, spanning both
 * the v2 channel-keyed shape (`channels.<name>.{publish,subscribe}`) and the v3
 * operation-keyed shape (`operations.<id>.{action,channel}`). No `$ref`
 * resolution — a `channel.$ref` is read as a display string only, never
 * followed (security-load-bearing, same rule as the OpenAPI parser).
 *
 * Interaction is OWNER-RELATIVE (the enum encodes what the owning Component
 * does; ADR-0023), and AsyncAPI v2's verbs are the classic trap: per the 2.x
 * spec, `publish` describes "messages CONSUMED BY the application from the
 * channel" and `subscribe` describes "messages PRODUCED BY the application and
 * sent to the channel" — i.e. from the application's view they are inverted
 * from the intuitive reading. So v2 `publish` → SUBSCRIBE (owner consumes) and
 * v2 `subscribe` → PUSH (owner emits). v3 fixed the confusion with an explicit
 * `action`: `send` → PUSH, `receive` → SUBSCRIBE. The human-facing `key` keeps
 * the document's own verb so it stays recognizable against the source.
 */

const MAX_OPERATIONS = 500;

export function parseAsyncApi(source: string): ParseFlowSpecResult {
  let parsed: unknown;
  try {
    parsed = loadAsYamlOrJson(source);
  } catch {
    return {
      parseError:
        "Couldn't parse spec as AsyncAPI — input is not valid YAML or JSON.",
    };
  }

  if (!isPlainObject(parsed)) {
    return {
      parseError:
        "Couldn't parse spec as AsyncAPI — top-level is not an object.",
    };
  }

  if (exceedsDepth(parsed, MAX_DEPTH)) {
    return {
      parseError: `Couldn't parse spec as AsyncAPI — nesting exceeds the depth cap (${MAX_DEPTH}).`,
    };
  }

  const flows: ParsedFlow[] = [];
  const overflow = { hit: false };

  const operations = (parsed as { operations?: unknown }).operations;
  const channels = (parsed as { channels?: unknown }).channels;

  if (isPlainObject(operations)) {
    // AsyncAPI v3: top-level operations carry the action explicitly.
    for (const [opId, op] of Object.entries(operations)) {
      if (!isPlainObject(op)) continue;
      const action = typeof op.action === "string" ? op.action : undefined;
      if (action !== "send" && action !== "receive") continue;
      const channelName = refOrName(op.channel) ?? opId;
      const interaction: FlowInteraction =
        action === "send" ? "PUSH" : "SUBSCRIBE";
      if (push(flows, overflow, {
        kind: "ASYNCAPI_CHANNEL",
        key: `${action} ${channelName}`,
        title: typeof op.summary === "string" ? op.summary : opId,
        interaction,
        signature: { version: 3, action, channel: channelName, messages: op.messages },
      })) {
        return capError();
      }
    }
  } else if (isPlainObject(channels)) {
    // AsyncAPI v2: each channel item carries publish/subscribe operations,
    // whose owner-relative meaning is inverted (see file header).
    for (const [channelName, channelItem] of Object.entries(channels)) {
      if (!isPlainObject(channelItem)) continue;
      for (const verb of ["publish", "subscribe"] as const) {
        const op = channelItem[verb];
        if (!isPlainObject(op)) continue;
        const interaction: FlowInteraction =
          verb === "publish" ? "SUBSCRIBE" : "PUSH";
        const operationId =
          typeof op.operationId === "string" ? op.operationId : undefined;
        if (push(flows, overflow, {
          kind: "ASYNCAPI_CHANNEL",
          key: `${verb} ${channelName}`,
          title: operationId ?? (typeof op.summary === "string" ? op.summary : `${verb} ${channelName}`),
          interaction,
          signature: { version: 2, verb, channel: channelName, message: op.message },
        })) {
          return capError();
        }
      }
    }
  }

  return { flows };
}

function refOrName(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (isPlainObject(value) && typeof value.$ref === "string") return value.$ref;
  return undefined;
}

// Pushes a flow unless the cap is reached; returns true once it overflows.
function push(
  flows: ParsedFlow[],
  overflow: { hit: boolean },
  flow: ParsedFlow,
): boolean {
  if (flows.length >= MAX_OPERATIONS) {
    overflow.hit = true;
    return true;
  }
  flows.push(flow);
  return false;
}

function capError(): ParseFlowSpecResult {
  return {
    parseError: `Couldn't parse spec as AsyncAPI — operation count exceeds the cap (${MAX_OPERATIONS}).`,
  };
}

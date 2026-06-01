import { type FlowInteraction } from "~/lib/schemas";

/**
 * Presentation for a Flow's {@link FlowInteraction} verb — the small pill shown
 * on the Component detail panel, the boundary-proxy palette, and the "+ flow"
 * popover. One shared map so the vocabulary and colors stay consistent across
 * every site that surfaces a Flow (replaces the former binary IN/OUT badge).
 * `short` is the uppercase pill text; `label` is the long form for titles/aria.
 * `tone` is a Tailwind class fragment (background + text).
 */
export const FLOW_INTERACTION_DISPLAY: Record<
  FlowInteraction,
  { short: string; label: string; tone: string }
> = {
  REQUEST: {
    short: "REQ",
    label: "Request",
    tone: "bg-emerald-500/20 text-emerald-300",
  },
  PUSH: {
    short: "PUSH",
    label: "Push",
    tone: "bg-sky-500/20 text-sky-300",
  },
  SUBSCRIBE: {
    short: "SUB",
    label: "Subscribe",
    tone: "bg-violet-500/20 text-violet-300",
  },
  DUPLEX: {
    short: "DUP",
    label: "Duplex",
    tone: "bg-amber-500/20 text-amber-300",
  },
};

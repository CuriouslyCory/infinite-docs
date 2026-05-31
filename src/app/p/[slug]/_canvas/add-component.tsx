"use client";

import { useState } from "react";

import { type NodeKind } from "~/lib/schemas";

// User-facing labels for the six kinds. Keyed by `NodeKind`, so adding a kind
// fails to compile until it gets a label here. Concrete kinds first, Generic
// last (the catch-all default). See CONTEXT.md "Component kind". Exported so the
// boundary-group node labels its inherited members with the same vocabulary.
export const KIND_LABEL: Record<NodeKind, string> = {
  SERVICE: "Service",
  DATABASE: "Database",
  EXTERNAL_API: "External API",
  HOST: "Host",
  QUEUE: "Queue",
  GENERIC: "Generic",
};

const KIND_ORDER: readonly NodeKind[] = [
  "SERVICE",
  "DATABASE",
  "EXTERNAL_API",
  "HOST",
  "QUEUE",
  "GENERIC",
];

/**
 * The "Add Component" control: a kind picker plus a button. Dumb by design — it
 * owns only the selected kind and delegates the create to the Canvas island via
 * `onAdd`, so all tRPC/optimistic logic stays in one place.
 */
export function AddComponent({
  onAdd,
  pending,
}: {
  onAdd: (kind: NodeKind) => void;
  pending: boolean;
}) {
  const [kind, setKind] = useState<NodeKind>("GENERIC");

  return (
    <div className="flex items-center gap-2 rounded-lg bg-black/40 p-2 backdrop-blur">
      <label htmlFor="component-kind" className="sr-only">
        Component kind
      </label>
      <select
        id="component-kind"
        value={kind}
        onChange={(e) => setKind(e.target.value as NodeKind)}
        className="rounded-md bg-white/10 px-2 py-1.5 text-sm text-white focus:outline-none"
      >
        {KIND_ORDER.map((k) => (
          <option key={k} value={k} className="text-black">
            {KIND_LABEL[k]}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => onAdd(kind)}
        disabled={pending}
        className="rounded-md bg-[hsl(280,100%,70%)] px-3 py-1.5 text-sm font-semibold text-black transition hover:bg-[hsl(280,100%,80%)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? "Adding…" : "Add Component"}
      </button>
    </div>
  );
}

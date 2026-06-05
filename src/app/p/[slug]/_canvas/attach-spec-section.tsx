"use client";

import { FileCode2 } from "lucide-react";
import { useState } from "react";

import { MAX_SPEC_SOURCE_BYTES, type SpecKind } from "~/lib/schemas";

// Spec kinds that have a parser today (#64 / ADR-0029). ASYNCAPI / TS_SIGNATURE
// / GRAPHQL / CUSTOM are reserved — exposing them here would let the user paste
// content the server can only reject with `parseError`.
const PARSEABLE_KINDS: { value: SpecKind; label: string }[] = [
  { value: "OPENAPI", label: "OpenAPI (JSON or YAML)" },
  { value: "SQL_DDL", label: "SQL DDL" },
];

interface AttachSpecSectionProps {
  pending: boolean;
  parseError: string | null;
  /** Caller (the canvas) runs the previewSpec mutation. */
  onPreview: (input: { kind: SpecKind; source: string }) => void;
}

/**
 * Owner-only "Attach spec" affordance inside the Component detail panel
 * (#64 / ADR-0029): pick a parser kind, paste the source, run preview. The
 * preview opens the conflict modal — nothing writes until the user confirms in
 * the modal (cancel = zero writes is the whole point). Lives alongside the
 * docs editor, not as a separate page, so it stays one keystroke from the
 * Component it attaches to.
 *
 * Read-only viewers never see this surface (rendered only in owner mode), and
 * the server re-enforces owner-only auth on the actual write.
 */
export function AttachSpecSection({
  pending,
  parseError,
  onPreview,
}: AttachSpecSectionProps) {
  const [kind, setKind] = useState<SpecKind>("OPENAPI");
  const [source, setSource] = useState("");

  const byteLength = new TextEncoder().encode(source).length;
  const overCap = byteLength > MAX_SPEC_SOURCE_BYTES;
  const disabled = pending || source.trim().length === 0 || overCap;

  return (
    <section className="flex flex-col gap-2">
      <h3 className="flex items-center gap-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        <FileCode2 size={12} aria-hidden className="text-primary" />
        Attach spec
      </h3>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Kind
        <select
          value={kind}
          onChange={(event) => setKind(event.target.value as SpecKind)}
          disabled={pending}
          className="nodrag rounded bg-muted px-2 py-1.5 text-sm text-foreground outline-none focus:bg-muted disabled:opacity-50"
        >
          {PARSEABLE_KINDS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Source
        <textarea
          value={source}
          onChange={(event) => setSource(event.target.value)}
          placeholder={
            kind === "OPENAPI"
              ? "Paste an OpenAPI document (JSON or YAML)…"
              : "Paste CREATE TABLE statements…"
          }
          rows={6}
          spellCheck={false}
          disabled={pending}
          className="nodrag resize-y rounded bg-muted px-2 py-1.5 font-mono text-xs text-foreground outline-none focus:bg-muted disabled:opacity-50"
        />
      </label>
      <div className="flex items-center justify-between text-[10px] text-muted-foreground/70">
        <span>
          {byteLength.toLocaleString()} /{" "}
          {MAX_SPEC_SOURCE_BYTES.toLocaleString()} bytes
        </span>
        {overCap && (
          <span className="text-edit">
            Source exceeds the {MAX_SPEC_SOURCE_BYTES / 1_000_000} MB cap.
          </span>
        )}
      </div>
      {parseError !== null && (
        <p className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
          {parseError}
        </p>
      )}
      <button
        type="button"
        onClick={() => onPreview({ kind, source })}
        disabled={disabled}
        className="self-start rounded bg-primary px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-primary disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? "Parsing…" : "Preview"}
      </button>
    </section>
  );
}

"use client";

import { ExternalLink } from "lucide-react";
import { useState, useSyncExternalStore } from "react";

import {
  MCP_CLIENTS,
  MCP_ENDPOINT_PATH,
  type McpClientId,
} from "~/lib/mcp-clients";

import { CopyButton } from "./copy-button";

const noopSubscribe = () => () => undefined;

export function McpInstructions({ token }: { token: string | null }) {
  const [selectedId, setSelectedId] = useState<McpClientId>(MCP_CLIENTS[0]!.id);
  // Read the origin from the client only: a `null` server snapshot keeps the
  // first client render matching the server HTML (no hydration mismatch), then
  // resolves to the live origin once mounted — without a setState-in-effect.
  const origin = useSyncExternalStore(
    noopSubscribe,
    () => window.location.origin,
    () => null,
  );

  const active =
    MCP_CLIENTS.find((c) => c.id === selectedId) ?? MCP_CLIENTS[0]!;
  const endpoint = origin ? `${origin}${MCP_ENDPOINT_PATH}` : null;
  const snippet = endpoint ? active.render(endpoint, token) : null;

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-white/10 bg-white/5 p-4">
      <div>
        <h2 className="font-semibold">Connect your client</h2>
        <p className="text-sm text-white/70">
          Pick your agent and paste the snippet to point it at your
          architecture.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {MCP_CLIENTS.map((client) => {
          const isActive = client.id === selectedId;
          return (
            <button
              key={client.id}
              type="button"
              onClick={() => setSelectedId(client.id)}
              aria-pressed={isActive}
              className={`rounded-full px-3 py-1.5 text-sm font-medium transition ${
                isActive
                  ? "bg-[hsl(280,100%,70%)] text-black"
                  : "bg-white/10 text-white hover:bg-white/20"
              }`}
            >
              {client.name}
            </button>
          );
        })}
      </div>

      <div className="flex flex-col gap-2">
        <span className="font-mono text-xs text-white/50">
          {active.configPath}
        </span>
        {snippet ? (
          <pre className="overflow-x-auto rounded-lg bg-black/40 px-3 py-2 font-mono text-sm whitespace-pre text-white">
            {snippet}
          </pre>
        ) : (
          <div className="h-20 animate-pulse rounded-lg bg-black/40" />
        )}
        {active.note && <p className="text-xs text-white/50">{active.note}</p>}
        <div className="flex flex-wrap items-center justify-between gap-2">
          {snippet ? <CopyButton value={snippet} /> : <span className="h-9" />}
          <a
            href={active.docsUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-sm text-white/60 underline-offset-2 transition hover:text-white hover:underline"
          >
            {active.name} MCP docs
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      </div>
    </div>
  );
}

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
    <div className="border-border bg-muted flex flex-col gap-4 rounded-xl border p-4">
      <div>
        <h2 className="font-semibold">Connect your client</h2>
        <p className="text-muted-foreground text-sm">
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
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-foreground hover:bg-muted"
              }`}
            >
              {client.name}
            </button>
          );
        })}
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-muted-foreground font-mono text-xs">
          {active.configPath}
        </span>
        {snippet ? (
          <pre className="bg-muted text-foreground overflow-x-auto rounded-lg px-3 py-2 font-mono text-sm whitespace-pre">
            {snippet}
          </pre>
        ) : (
          <div className="bg-muted h-20 animate-pulse rounded-lg" />
        )}
        {active.note && (
          <p className="text-muted-foreground text-xs">{active.note}</p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          {snippet ? <CopyButton value={snippet} /> : <span className="h-9" />}
          <a
            href={active.docsUrl}
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm underline-offset-2 transition hover:underline"
          >
            {active.name} MCP docs
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      </div>
    </div>
  );
}

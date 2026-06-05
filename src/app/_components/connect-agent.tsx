"use client";

import { KeyRound } from "lucide-react";
import { useState } from "react";
import { Toaster, toast } from "sonner";

import { api, type RouterOutputs } from "~/trpc/react";

import { CopyButton } from "./copy-button";
import { McpInstructions } from "./mcp-instructions";

/**
 * Owner-only Connect-an-agent surface: mints API tokens (revealed exactly once),
 * lists them, and revokes them.
 *
 * Imports only client-safe modules (`~/trpc/react`) — never `~/server`. The
 * ESLint guard for `src/app/_components/**` enforces that (ADR-0004).
 */

type ApiToken = RouterOutputs["token"]["list"][number];

const EXPIRY_OPTIONS = [
  { label: "30 days", value: "30" },
  { label: "90 days", value: "90" },
  { label: "1 year", value: "365" },
  { label: "No expiry", value: "never" },
] as const;

type TokenStatus = "active" | "expired" | "revoked";

function statusOf(token: ApiToken): TokenStatus {
  if (token.revokedAt) return "revoked";
  if (token.expiresAt && new Date(token.expiresAt).getTime() <= Date.now()) {
    return "expired";
  }
  return "active";
}

function expiryToDays(value: string): 30 | 90 | 365 | null {
  switch (value) {
    case "30":
      return 30;
    case "365":
      return 365;
    case "never":
      return null;
    default:
      return 90;
  }
}

function formatDate(value: Date | string | null): string {
  if (!value) return "Never";
  return new Date(value).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function ConnectAgent() {
  const utils = api.useUtils();
  const [tokens] = api.token.list.useSuspenseQuery();
  const [label, setLabel] = useState("");
  const [expiry, setExpiry] = useState<string>("90");
  const [revealedToken, setRevealedToken] = useState<string | null>(null);

  const createToken = api.token.create.useMutation({
    onSuccess: async ({ token }) => {
      setRevealedToken(token);
      setLabel("");
      setExpiry("90");
      await utils.token.list.invalidate();
    },
    onError: () => {
      toast.error("Couldn’t generate a token. Please try again.");
    },
  });

  const revokeToken = api.token.revoke.useMutation({
    // Revocation has no server-generated payload to wait on, so flip the row to
    // Revoked immediately and reconcile on settle (philosophy: optimistic UX).
    onMutate: async ({ id }) => {
      await utils.token.list.cancel();
      const previous = utils.token.list.getData();
      utils.token.list.setData(undefined, (old) =>
        old?.map((t) =>
          t.id === id ? { ...t, revokedAt: t.revokedAt ?? new Date() } : t,
        ),
      );
      return { previous };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) utils.token.list.setData(undefined, ctx.previous);
      toast.error("Couldn’t revoke that token. Please try again.");
    },
    onSettled: async () => {
      await utils.token.list.invalidate();
    },
  });

  function handleGenerate(e: React.FormEvent) {
    e.preventDefault();
    if (createToken.isPending) return;
    const trimmed = label.trim();
    createToken.mutate({
      label: trimmed.length > 0 ? trimmed : undefined,
      expiresInDays: expiryToDays(expiry),
    });
  }

  return (
    <div className="flex w-full flex-col gap-8">
      <Toaster theme="dark" position="bottom-right" richColors />
      <form
        onSubmit={handleGenerate}
        className="border-border bg-muted flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-end"
      >
        <label className="flex flex-1 flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Name (optional)</span>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Claude on laptop"
            maxLength={100}
            className="bg-muted text-foreground placeholder:text-muted-foreground/70 focus:bg-muted rounded-lg px-3 py-2 focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-muted-foreground">Expiry</span>
          <select
            value={expiry}
            onChange={(e) => setExpiry(e.target.value)}
            className="bg-muted text-foreground focus:bg-muted rounded-lg px-3 py-2 focus:outline-none"
          >
            {EXPIRY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value} className="text-black">
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          disabled={createToken.isPending}
          className="bg-primary text-primary-foreground hover:bg-primary inline-flex items-center justify-center gap-2 rounded-lg px-6 py-2 font-semibold transition disabled:cursor-not-allowed disabled:opacity-50"
        >
          <KeyRound className="h-4 w-4" />
          {createToken.isPending ? "Generating…" : "Generate token"}
        </button>
      </form>

      {expiry === "never" && (
        <p className="text-edit/80 -mt-6 text-xs">
          This token never expires — revoke it promptly if it’s ever leaked.
        </p>
      )}

      {revealedToken && (
        <div className="border-primary/40 bg-primary/10 flex flex-col gap-3 rounded-xl border p-4">
          <div>
            <h2 className="font-semibold">Copy your token now</h2>
            <p className="text-muted-foreground text-sm">
              This is the only time you’ll see this token. If you lose it,
              revoke it and generate a new one.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <code className="bg-muted text-foreground flex-1 overflow-x-auto rounded-lg px-3 py-2 font-mono text-sm">
              {revealedToken}
            </code>
            <CopyButton value={revealedToken} />
          </div>
          <button
            type="button"
            onClick={() => setRevealedToken(null)}
            className="text-muted-foreground hover:text-foreground self-start text-sm underline-offset-2 transition hover:underline"
          >
            I’ve saved it — dismiss
          </button>
        </div>
      )}

      <McpInstructions token={revealedToken} />

      <div>
        <h2 className="mb-3 text-lg font-semibold">Your tokens</h2>
        {tokens.length === 0 ? (
          <p className="text-muted-foreground">
            No tokens yet. Generate one above to connect an AI agent to your
            architecture.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {tokens.map((token) => {
              const status = statusOf(token);
              return (
                <li
                  key={token.id}
                  className="border-border bg-muted flex flex-col gap-2 rounded-xl border p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex flex-col gap-1">
                    <span className="font-medium">
                      {token.label ?? "Untitled token"}
                    </span>
                    <span className="text-muted-foreground font-mono text-xs">
                      {token.prefix}…
                    </span>
                    <span className="text-muted-foreground text-xs">
                      Created {formatDate(token.createdAt)} · Expires{" "}
                      {formatDate(token.expiresAt)}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <StatusBadge status={status} />
                    {status === "active" && (
                      <button
                        type="button"
                        onClick={() => revokeToken.mutate({ id: token.id })}
                        className="bg-muted text-destructive hover:bg-destructive/10 rounded-lg px-3 py-1.5 text-sm font-semibold transition"
                      >
                        Revoke
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: TokenStatus }) {
  const styles: Record<TokenStatus, string> = {
    active: "bg-secondary/20 text-secondary",
    expired: "bg-muted text-muted-foreground",
    revoked: "bg-muted text-muted-foreground",
  };
  const labels: Record<TokenStatus, string> = {
    active: "Active",
    expired: "Expired",
    revoked: "Revoked",
  };
  return (
    <span
      className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${styles[status]}`}
    >
      {labels[status]}
    </span>
  );
}

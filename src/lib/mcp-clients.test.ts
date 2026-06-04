import { describe, expect, it } from "vitest";

import {
  MCP_CLIENTS,
  MCP_ENDPOINT_PATH,
  TOKEN_PLACEHOLDER,
  type McpClientId,
  tokenOrPlaceholder,
} from "./mcp-clients";

/**
 * Pure-logic unit test (no DB, no React): drives each MCP-client descriptor's
 * `render` with a sample endpoint + token and asserts the externally-observable
 * snippet — the endpoint, the auth mechanism, and the no-literal-null contract.
 * The vitest `globalSetup` still syncs the test schema before any file runs, but
 * this file does not depend on the database.
 */

const ENDPOINT = `https://example.test${MCP_ENDPOINT_PATH}`;
const TOKEN = "infdoc_real";

const ORDER: readonly McpClientId[] = [
  "claude-code",
  "codex-cli",
  "codex-app",
  "opencode",
  "openclaw",
  "hermes",
  "cursor",
];

describe("tokenOrPlaceholder", () => {
  it("returns the token when present", () => {
    expect(tokenOrPlaceholder(TOKEN)).toBe(TOKEN);
  });

  it("falls back to the placeholder for null", () => {
    expect(tokenOrPlaceholder(null)).toBe(TOKEN_PLACEHOLDER);
  });

  it("falls back to the placeholder for an empty string", () => {
    expect(tokenOrPlaceholder("")).toBe(TOKEN_PLACEHOLDER);
  });
});

describe("MCP_CLIENTS catalog integrity", () => {
  it("has exactly seven descriptors", () => {
    expect(MCP_CLIENTS).toHaveLength(7);
  });

  it("orders descriptors to match the id union", () => {
    expect(MCP_CLIENTS.map((c) => c.id)).toEqual(ORDER);
  });

  it("has unique ids", () => {
    const ids = MCP_CLIENTS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("carries a non-empty name and configPath for every descriptor", () => {
    for (const client of MCP_CLIENTS) {
      expect(client.name.length).toBeGreaterThan(0);
      expect(client.configPath.length).toBeGreaterThan(0);
    }
  });

  it("points every descriptor at a parseable https docs URL", () => {
    for (const client of MCP_CLIENTS) {
      const url = new URL(client.docsUrl);
      expect(url.protocol).toBe("https:");
    }
  });
});

describe("render with a real token", () => {
  for (const client of MCP_CLIENTS) {
    describe(client.id, () => {
      const snippet = client.render(ENDPOINT, TOKEN);

      it("embeds the full endpoint", () => {
        expect(snippet).toContain(ENDPOINT);
      });

      it("embeds the MCP path", () => {
        expect(snippet).toContain(MCP_ENDPOINT_PATH);
      });

      it("embeds the token", () => {
        expect(snippet).toContain(TOKEN);
      });
    });
  }
});

describe("render with a null token", () => {
  for (const client of MCP_CLIENTS) {
    describe(client.id, () => {
      const snippet = client.render(ENDPOINT, null);

      it("falls back to the placeholder", () => {
        expect(snippet).toContain(TOKEN_PLACEHOLDER);
      });

      it("never emits a literal null or undefined", () => {
        expect(snippet).not.toMatch(/\bnull\b/);
        expect(snippet).not.toMatch(/\bundefined\b/);
      });
    });
  }
});

describe("client-specific auth mechanism", () => {
  function get(id: McpClientId) {
    const client = MCP_CLIENTS.find((c) => c.id === id);
    if (!client) throw new Error(`missing descriptor: ${id}`);
    return client;
  }

  it("claude-code uses a Bearer header", () => {
    expect(get("claude-code").render(ENDPOINT, TOKEN)).toContain(
      `Bearer ${TOKEN}`,
    );
  });

  it("cursor uses a Bearer header", () => {
    expect(get("cursor").render(ENDPOINT, TOKEN)).toContain(`Bearer ${TOKEN}`);
  });

  it("opencode declares a remote-type server with a Bearer header", () => {
    const snippet = get("opencode").render(ENDPOINT, TOKEN);
    expect(snippet).toContain("remote");
    expect(snippet).toContain(`Bearer ${TOKEN}`);
  });

  it("openclaw forces the streamable-http transport", () => {
    expect(get("openclaw").render(ENDPOINT, TOKEN)).toContain(
      "streamable-http",
    );
  });

  it("hermes uses a Bearer header", () => {
    expect(get("hermes").render(ENDPOINT, TOKEN)).toContain(`Bearer ${TOKEN}`);
  });

  for (const id of ["codex-cli", "codex-app"] as const) {
    describe(id, () => {
      const snippet = get(id).render(ENDPOINT, TOKEN);

      it("references the env-var name and an export line", () => {
        expect(snippet).toContain("bearer_token_env_var");
        expect(snippet).toContain("INFINITE_DOCS_TOKEN");
        expect(snippet).toContain("export INFINITE_DOCS_TOKEN=");
      });

      it("does not inline a literal Bearer header with the token", () => {
        expect(snippet).not.toContain(`Bearer ${TOKEN}`);
        expect(snippet).not.toContain("Authorization");
      });
    });
  }
});

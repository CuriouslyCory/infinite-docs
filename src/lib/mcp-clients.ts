/**
 * Pure catalog of MCP-client setup snippets for the Connect-an-agent page
 * (#94). Each descriptor renders a copy-paste config that points an agent at
 * this deployment's MCP path with a bearer API token.
 *
 * Lives in `~/lib` and imports nothing (no React, no IO, no `~/server`), so the
 * `/connect` client island can consume it without pulling the server graph into
 * the browser bundle (ADR-0004). The origin is supplied by the caller as a full
 * `${origin}${MCP_ENDPOINT_PATH}` endpoint — the public origin is only knowable
 * server-side (llms.txt's `getPublicOrigin`), so this module never derives it.
 *
 * `render` takes the live token or `null`; a null/empty token renders
 * `TOKEN_PLACEHOLDER` so a snippet is never emitted with a literal "null".
 */

export const MCP_ENDPOINT_PATH = "/api/mcp";
export const TOKEN_PLACEHOLDER = "infdoc_YOUR_TOKEN_HERE";

const SERVER_NAME = "infinite-docs";

export type McpClientId =
  | "claude-code"
  | "codex-cli"
  | "codex-app"
  | "opencode"
  | "openclaw"
  | "hermes"
  | "cursor";

export interface McpClientDescriptor {
  readonly id: McpClientId;
  readonly name: string;
  readonly configPath: string;
  readonly docsUrl: string;
  readonly language: "json" | "toml" | "shell" | "yaml";
  readonly note?: string;
  render(endpoint: string, token: string | null): string;
}

export function tokenOrPlaceholder(token: string | null): string {
  return token && token.length > 0 ? token : TOKEN_PLACEHOLDER;
}

export const MCP_CLIENTS: readonly McpClientDescriptor[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    configPath: "Terminal",
    docsUrl: "https://code.claude.com/docs/en/mcp",
    language: "shell",
    render(endpoint, token) {
      return `claude mcp add --transport http ${SERVER_NAME} ${endpoint} --header "Authorization: Bearer ${tokenOrPlaceholder(token)}"`;
    },
  },
  {
    id: "codex-cli",
    name: "Codex CLI",
    configPath: "~/.codex/config.toml",
    docsUrl: "https://developers.openai.com/codex/config-reference",
    language: "toml",
    // Codex takes the NAME of an env var, not a literal Authorization header —
    // so the snippet defines the var name in TOML and exports the token
    // separately; never inline the bearer token in a header field.
    render(endpoint, token) {
      return `[mcp_servers.${SERVER_NAME}]
url = "${endpoint}"
bearer_token_env_var = "INFINITE_DOCS_TOKEN"

# In your shell:
export INFINITE_DOCS_TOKEN="${tokenOrPlaceholder(token)}"`;
    },
  },
  {
    id: "codex-app",
    name: "Codex (IDE)",
    configPath: "~/.codex/config.toml",
    docsUrl: "https://developers.openai.com/codex/mcp",
    language: "toml",
    note: 'In the IDE: gear menu → "MCP settings" → "Open config.toml".',
    render(endpoint, token) {
      return `[mcp_servers.${SERVER_NAME}]
url = "${endpoint}"
bearer_token_env_var = "INFINITE_DOCS_TOKEN"

# In your shell:
export INFINITE_DOCS_TOKEN="${tokenOrPlaceholder(token)}"`;
    },
  },
  {
    id: "opencode",
    name: "OpenCode",
    configPath: "opencode.json",
    docsUrl: "https://opencode.ai/docs/mcp-servers/",
    language: "json",
    render(endpoint, token) {
      return `{
  "mcp": {
    "${SERVER_NAME}": {
      "type": "remote",
      "url": "${endpoint}",
      "enabled": true,
      "headers": {
        "Authorization": "Bearer ${tokenOrPlaceholder(token)}"
      }
    }
  }
}`;
    },
  },
  {
    id: "openclaw",
    name: "OpenClaw",
    configPath: "~/.openclaw/openclaw.json",
    docsUrl: "https://docs.openclaw.ai/cli/mcp",
    language: "json",
    render(endpoint, token) {
      return `{
  "mcp": {
    "servers": {
      "${SERVER_NAME}": {
        "url": "${endpoint}",
        "transport": "streamable-http",
        "headers": {
          "Authorization": "Bearer ${tokenOrPlaceholder(token)}"
        }
      }
    }
  }
}`;
    },
  },
  {
    id: "hermes",
    name: "Hermes",
    configPath: "~/.hermes/config.yaml",
    docsUrl:
      "https://hermes-agent.nousresearch.com/docs/reference/mcp-config-reference",
    language: "yaml",
    render(endpoint, token) {
      return `mcp_servers:
  ${SERVER_NAME}:
    url: "${endpoint}"
    headers:
      Authorization: "Bearer ${tokenOrPlaceholder(token)}"`;
    },
  },
  {
    id: "cursor",
    name: "Cursor",
    configPath: ".cursor/mcp.json",
    docsUrl: "https://cursor.com/docs/mcp",
    language: "json",
    render(endpoint, token) {
      return `{
  "mcpServers": {
    "${SERVER_NAME}": {
      "url": "${endpoint}",
      "headers": {
        "Authorization": "Bearer ${tokenOrPlaceholder(token)}"
      }
    }
  }
}`;
    },
  },
];

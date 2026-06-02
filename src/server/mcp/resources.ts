import {
  ResourceTemplate,
  type McpServer,
} from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Db } from "~/server/architecture/actor";
import { exportMarkdownForActor } from "~/server/architecture/export.service";
import { listProjects } from "~/server/architecture/project.service";
import { actorFromAuthInfo } from "./auth";
import { MARKDOWN_MIME, READ_RESOURCES, RESOURCE_SCHEME } from "./catalog";
import { toMcpReadError } from "./errors";

/**
 * Registers the read resources (from the {@link READ_RESOURCES} catalog) on a
 * per-request `McpServer`. The db handle is closed over; the Actor is read from
 * each request's `extra.authInfo` (resolved by `withMcpAuth`). `resources/list`
 * enumerates ONLY the calling Actor's projects by reusing the already-owner-
 * scoped `listProjects` — the isolation invariant holds because the enumeration
 * cannot return another user's rows. Each read re-authorizes through
 * `exportMarkdownForActor` (defense in depth); any failure maps to a
 * non-disclosing MCP error.
 */
export function registerArchitectureResources(server: McpServer, db: Db): void {
  for (const descriptor of READ_RESOURCES) {
    const template = new ResourceTemplate(
      `${RESOURCE_SCHEME}://${descriptor.uriTemplate}`,
      {
        list: descriptor.enumerateProjects
          ? async (extra) => {
              const actor = actorFromAuthInfo(extra.authInfo);
              const projects = await listProjects(db, actor);
              return {
                resources: projects.map((project) => ({
                  uri: `${RESOURCE_SCHEME}://${descriptor.name}/${project.id}`,
                  name: `${project.title} — ${descriptor.title}`,
                  description: descriptor.description,
                  mimeType: MARKDOWN_MIME,
                })),
              };
            }
          : undefined,
      },
    );

    server.registerResource(
      descriptor.name,
      template,
      {
        title: descriptor.title,
        description: descriptor.description,
        mimeType: MARKDOWN_MIME,
      },
      async (uri, variables, extra) => {
        const actor = actorFromAuthInfo(extra.authInfo);
        try {
          const { markdown } = await exportMarkdownForActor(
            db,
            actor,
            descriptor.toInput(variables),
          );
          return {
            contents: [
              { uri: uri.href, mimeType: MARKDOWN_MIME, text: markdown },
            ],
          };
        } catch (error) {
          throw toMcpReadError(error);
        }
      },
    );
  }
}

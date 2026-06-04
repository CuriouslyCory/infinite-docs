# Read resources and write tools

All read resources are addressed under the `architecture://` scheme and return deterministic markdown (byte-stable across runs and OS locales). All write tools mutate only the projects owned by the token's minting user. Call `tools/list` / `resources/list` for live schemas; this file teaches the shapes you reach for most.

## Read resources

| Resource | URI template | What it returns | When to read |
| --- | --- | --- | --- |
| `index` | `architecture://index/{projectId}` | A cheap structural map: every Component's title, kind, `{#anchor}`, and connection count, indented by depth. **No doc bodies.** | First. Orient before fetching full bodies; read before a big write (avoid dupes) and after (verify). |
| `project` | `architecture://project/{projectId}` | The full architecture: every Component with its authored docs, plus a Connections section. | When you need the docs, not just the shape. |
| `subtree` | `architecture://subtree/{projectId}/{nodeId}` | One Component and its descendants, with a Boundary context section naming external systems it connects to — a deep slice reads standalone. | To focus on one branch. Address `{nodeId}` by the `{#anchor}` ids from `index` or `project`. |
| `trace` | `architecture://trace/{traceId}` | One saved Trace: the Components and Connections on a path between its trace points, expanded across all layers. | Niche — only when working from a saved Trace. |

**Read ladder:** `index` → `project` → `subtree`. Start cheap; go deep only where you need it. `resources/list` enumerates the projects your token can read; only `index` and `project` enumerate one entry per project.

## Write tools

| Tool | Purpose | Key input fields |
| --- | --- | --- |
| `apply_graph` | **Default for building structure** — many Components and Connections in one atomic transaction. | `{ projectId, components[], connections[] }`. Each `components[]`: `{ clientId, parent?, kind?, title?, posX?, posY? }`. Each `connections[]`: `{ source, target, interaction?, label? }`. A `parent`/`source`/`target` ref is `{ref:"server", id}` (an existing id) OR `{ref:"client", clientId}` (a sibling in this batch). Response: `{ idMap, componentCount, connectionCount }`. **Not idempotent** — read before retrying a lost call. |
| `create_component` | A single new Component. | `{ projectId, parentId?, kind?, title?, posX?, posY? }`. `parentId` null/omitted = root Canvas. |
| `connect_components` | A single Connection between two existing Components. | `{ projectId, sourceId, targetId, interaction?, label? }`. Any scope; only self-link is rejected. |
| `update_component_docs` | Replace a Component's markdown docs. | `{ id, documentation }`. **FULL replace, not a patch.** Empty string clears. 100 KB UTF-8 cap. Plain markdown. |
| `move_component` | Reparent a Component (nest or un-nest). | `{ id, parentId }`. null = root Canvas. Rejects ONLY a cycle (onto itself or a descendant). Incident Connections simply become cross-scope. |
| `apply_spec` | Materialize derived child Components from a machine-readable Spec. | `{ ownerNodeId, kind, source, changed?, dropped? }`. `kind` selects the parser (`OPENAPI`, `SQL_DDL`, …). The server PARSES `source` server-side. SQL DDL adds directional `REQUEST` Connections for each foreign key. **Not idempotent.** |

## Decision rule

- Building structure (multiple Components/Connections at once) → **`apply_graph`**.
- A single edit to one existing thing → the surgical single-op tool (`create_component`, `connect_components`, `update_component_docs`, `move_component`).
- A machine-readable contract (OpenAPI, SQL DDL, …) → **`apply_spec`** — let the server parse it into a tree.

## There is no delete tool

Destructive operations live in the web client, never on the MCP surface. **Plan additively** — add and reparent, never assume you can remove. If something is wrong, leave it and document the correction; a human deletes in the app.

## clientId rules (apply_graph)

- You choose each `clientId`: any non-empty string, **unique across the whole batch**, ≤ 64 chars.
- It is a per-batch lookup key only — it **carries no authorization** and means nothing outside the one call (writes still authorize through your token).
- Refs are explicit: `{ref:"client", clientId:"…"}` for a sibling in this batch, `{ref:"server", id:"…"}` for an existing row. A typo surfaces as "no such clientId in this batch", never a silent rebind.
- The response `idMap` maps each `clientId` → its server-minted id. Keep it; pass those server ids to later tool calls. Connections carry no `clientId` (nothing references a Connection by one), and there is no `canvasNode` ref — Connections span scopes.

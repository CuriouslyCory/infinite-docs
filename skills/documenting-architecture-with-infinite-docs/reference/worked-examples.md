# Worked examples

Concrete calls for the workflow in `SKILL.md`. Ids shown (`node_1`, …) are illustrative of what the server returns.

## Example 1 — Build the root in one `apply_graph` call

Three top-level Components and the two Connections between them, in one atomic batch. Children and endpoints are chained by `clientId` — no intermediate reads.

```json
{
  "projectId": "proj_abc",
  "components": [
    {
      "clientId": "web",
      "parent": null,
      "kind": "APPLICATION",
      "title": "Web App"
    },
    {
      "clientId": "api",
      "parent": null,
      "kind": "SERVICE",
      "title": "API Service"
    },
    {
      "clientId": "db",
      "parent": null,
      "kind": "DATABASE",
      "title": "Postgres"
    }
  ],
  "connections": [
    {
      "source": { "ref": "client", "clientId": "web" },
      "target": { "ref": "client", "clientId": "api" },
      "interaction": "REQUEST",
      "label": "REST"
    },
    {
      "source": { "ref": "client", "clientId": "api" },
      "target": { "ref": "client", "clientId": "db" },
      "interaction": "REQUEST"
    }
  ]
}
```

Response:

```json
{
  "idMap": { "web": "node_1", "api": "node_2", "db": "node_3" },
  "componentCount": 3,
  "connectionCount": 2
}
```

Teaching points:

- `parent: null` puts a Component on the **root** Canvas.
- Connections reference Components by their batch `clientId` via `{ref:"client", …}` — the whole batch resolves together.
- It is **atomic** — the whole batch applies or rolls back; there is no partial graph.
- **Keep the `idMap`.** `api` is now `node_2` — you need that server id to descend into it next.

## Example 2 — Descend into the API and nest its interior

You want to document the API Service's interior Canvas. Its server id is `node_2` (from Example 1's `idMap`); if you didn't keep it, read `architecture://index/proj_abc` and find it by its `{#node_2}` anchor.

A second `apply_graph` nests two MODULE children under `node_2` (by **server** ref) and connects them:

```json
{
  "projectId": "proj_abc",
  "components": [
    {
      "clientId": "router",
      "parent": { "ref": "server", "id": "node_2" },
      "kind": "MODULE",
      "title": "HTTP Router"
    },
    {
      "clientId": "orders",
      "parent": { "ref": "server", "id": "node_2" },
      "kind": "MODULE",
      "title": "Orders Module"
    }
  ],
  "connections": [
    {
      "source": { "ref": "client", "clientId": "router" },
      "target": { "ref": "client", "clientId": "orders" },
      "interaction": "REQUEST"
    }
  ]
}
```

Then author docs on a child with a full-replace (response `idMap` mapped `orders` → `node_5`):

```json
{
  "id": "node_5",
  "documentation": "# Orders Module\n\nHandles cart checkout and order persistence. Writes to Postgres via the API's data layer.\n"
}
```

Verify with `architecture://subtree/proj_abc/node_2`.

Note: the `api`→`db` Connection from Example 1 now shows up inside `node_2`'s interior (and other Canvases it reaches) as a **read-only boundary proxy** for `db`. That is automatic — **do not recreate** the `db` Component or that Connection.

## A surgical Connection (for contrast)

When you have just one Connection to draw between two Components whose **server ids you already hold**, skip `apply_graph` and use `connect_components`:

```json
{
  "projectId": "proj_abc",
  "sourceId": "node_1",
  "targetId": "node_2",
  "interaction": "REQUEST",
  "label": "REST"
}
```

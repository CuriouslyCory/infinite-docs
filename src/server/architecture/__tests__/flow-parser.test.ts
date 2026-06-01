import { describe, expect, it } from "vitest";

import { parseFlowSpec } from "../flow-parser";

const SMALL_OPENAPI_YAML = `
openapi: 3.0.0
info:
  title: Petstore
  version: 1.0.0
paths:
  /pets:
    get:
      summary: List pets
      operationId: listPets
      responses:
        '200':
          description: OK
    post:
      summary: Create a pet
      operationId: createPet
      responses:
        '201':
          description: Created
  /pets/{id}:
    get:
      summary: Get a pet
      operationId: getPet
      parameters:
        - in: path
          name: id
          required: true
          schema:
            type: string
      responses:
        '200':
          description: OK
`;

const SMALL_OPENAPI_JSON = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "Petstore", version: "1.0.0" },
  paths: {
    "/pets": {
      get: { summary: "List pets", operationId: "listPets" },
      post: { summary: "Create a pet", operationId: "createPet" },
    },
  },
});

describe("parseFlowSpec", () => {
  describe("OPENAPI", () => {
    it("walks paths.*.{verbs} and produces one Flow per operation", () => {
      const result = parseFlowSpec("OPENAPI", SMALL_OPENAPI_YAML);
      if ("parseError" in result) {
        throw new Error(`expected flows, got parseError: ${result.parseError}`);
      }
      expect(result.flows).toHaveLength(3);
      const keys = result.flows.map((f) => f.key);
      expect(keys).toEqual(["GET /pets", "POST /pets", "GET /pets/{id}"]);
      // All flows from an OpenAPI spec are REQUEST (request/response endpoints the owner serves).
      for (const flow of result.flows) {
        expect(flow.interaction).toBe("REQUEST");
        expect(flow.kind).toBe("OPENAPI_OPERATION");
      }
    });

    it("auto-detects JSON vs YAML by leading character", () => {
      const yaml = parseFlowSpec("OPENAPI", SMALL_OPENAPI_YAML);
      const json = parseFlowSpec("OPENAPI", SMALL_OPENAPI_JSON);
      if ("parseError" in yaml || "parseError" in json) {
        throw new Error("expected both to parse");
      }
      expect(json.flows).toHaveLength(2);
      expect(yaml.flows[0]!.key).toBe("GET /pets");
      expect(json.flows[0]!.key).toBe("GET /pets");
    });

    it("uses operationId or path key as the title fallback", () => {
      const spec = `
openapi: 3.0.0
paths:
  /widgets:
    get:
      operationId: listWidgets
      responses: { '200': { description: OK } }
  /gadgets:
    delete:
      responses: { '204': { description: No Content } }
`;
      const result = parseFlowSpec("OPENAPI", spec);
      if ("parseError" in result) throw new Error("expected flows");
      expect(result.flows[0]!.title).toBe("listWidgets");
      expect(result.flows[1]!.title).toBe("DELETE /gadgets");
    });

    it("captures the signature shape verbatim (parameters, requestBody, responses)", () => {
      const result = parseFlowSpec("OPENAPI", SMALL_OPENAPI_YAML);
      if ("parseError" in result) throw new Error("expected flows");
      const getById = result.flows.find((f) => f.key === "GET /pets/{id}")!;
      const sig = getById.signature as Record<string, unknown>;
      expect(sig.method).toBe("GET");
      expect(sig.path).toBe("/pets/{id}");
      expect(Array.isArray(sig.parameters)).toBe(true);
    });

    it("returns empty flows when `paths` is absent (e.g. webhooks-only spec)", () => {
      const result = parseFlowSpec("OPENAPI", "openapi: 3.1.0\nwebhooks: {}\n");
      if ("parseError" in result) throw new Error("expected flows");
      expect(result.flows).toHaveLength(0);
    });

    it("rejects malformed YAML with a sanitized parseError (never throws)", () => {
      // A YAML block-mapping with an empty value at the wrong indent — invalid.
      const result = parseFlowSpec("OPENAPI", "openapi: 3.0.0\n  paths: {\n");
      if ("flows" in result) throw new Error("expected parseError");
      expect(result.parseError).toMatch(/Couldn't parse spec as OpenAPI/);
    });

    it("rejects oversized source (>1 MB)", () => {
      const oversized = "x".repeat(1_000_001);
      const result = parseFlowSpec("OPENAPI", oversized);
      if ("flows" in result) throw new Error("expected parseError");
      expect(result.parseError).toMatch(/1 MB cap/);
    });

    it("rejects a spec whose object nesting exceeds MAX_DEPTH", () => {
      // Build an object nested 40 levels deep (MAX_DEPTH = 32).
      const inner: Record<string, unknown> = {};
      let cursor = inner;
      for (let i = 0; i < 40; i++) {
        const next: Record<string, unknown> = {};
        cursor.x = next;
        cursor = next;
      }
      const spec = JSON.stringify({ openapi: "3.0.0", paths: { "/x": inner } });
      const result = parseFlowSpec("OPENAPI", spec);
      if ("flows" in result) throw new Error("expected parseError");
      expect(result.parseError).toMatch(/depth cap/);
    });

    it("rejects when operation count exceeds the cap", () => {
      // 501 paths × 1 method each = 501 operations (cap is 500).
      const paths: Record<string, unknown> = {};
      for (let i = 0; i < 501; i++) {
        paths[`/op${i}`] = { get: { responses: { "200": { description: "OK" } } } };
      }
      const spec = JSON.stringify({ openapi: "3.0.0", paths });
      const result = parseFlowSpec("OPENAPI", spec);
      if ("flows" in result) throw new Error("expected parseError");
      expect(result.parseError).toMatch(/operation count exceeds the cap/);
    });

    it("rejects when top-level is not an object", () => {
      const result = parseFlowSpec("OPENAPI", "[1, 2, 3]");
      if ("flows" in result) throw new Error("expected parseError");
      expect(result.parseError).toMatch(/top-level is not an object/);
    });

    it("ignores YAML alias bombs (yaml@2 default maxAliasCount)", () => {
      // A classic alias-bomb shape: a single anchor expanded many times. yaml@2
      // rejects past 100 expansions by default, so the parser should either
      // store an empty `paths` (no error) or reject with parseError — never
      // OOM or throw.
      const bomb = `
a: &a [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]
b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]
c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]
d: [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c]
openapi: 3.0.0
paths: {}
`;
      const result = parseFlowSpec("OPENAPI", bomb);
      // Don't care which branch — care that it never throws or hangs.
      if ("flows" in result) {
        expect(result.flows).toEqual([]);
      } else {
        expect(typeof result.parseError).toBe("string");
      }
    });

    it("does not extract from 3.1 `webhooks` or `callbacks` (deferred)", () => {
      const spec = `
openapi: 3.1.0
paths:
  /known:
    get: { responses: { '200': { description: OK } } }
webhooks:
  newPet:
    post: { responses: { '200': { description: OK } } }
`;
      const result = parseFlowSpec("OPENAPI", spec);
      if ("parseError" in result) throw new Error("expected flows");
      expect(result.flows).toHaveLength(1);
      expect(result.flows[0]!.key).toBe("GET /known");
    });
  });

  describe("CUSTOM (no parser — prose persisted verbatim)", () => {
    it("stores source with a parseError note", () => {
      const result = parseFlowSpec("CUSTOM", "any prose at all");
      if ("flows" in result) throw new Error("expected parseError");
      expect(result.parseError).toMatch(/no parser/);
    });
  });

  describe("ASYNCAPI", () => {
    it("maps v2 publish→SUBSCRIBE and subscribe→PUSH (owner-relative)", () => {
      const spec = `
asyncapi: 2.6.0
info: { title: Orders, version: 1.0.0 }
channels:
  orders/created:
    subscribe:
      operationId: onOrderCreated
      message: { payload: { type: object } }
  orders/submit:
    publish:
      operationId: submitOrder
      message: { payload: { type: object } }
`;
      const result = parseFlowSpec("ASYNCAPI", spec);
      if ("parseError" in result) {
        throw new Error(`expected flows: ${result.parseError}`);
      }
      const byKey = Object.fromEntries(
        result.flows.map((f) => [f.key, f]),
      );
      // subscribe = the application produces/sends → owner PUSHes.
      expect(byKey["subscribe orders/created"]!.interaction).toBe("PUSH");
      // publish = the application consumes what clients send → owner SUBSCRIBEs.
      expect(byKey["publish orders/submit"]!.interaction).toBe("SUBSCRIBE");
      for (const flow of result.flows) {
        expect(flow.kind).toBe("ASYNCAPI_CHANNEL");
      }
    });

    it("maps v3 send→PUSH and receive→SUBSCRIBE via explicit action", () => {
      const spec = JSON.stringify({
        asyncapi: "3.0.0",
        operations: {
          sendOrder: { action: "send", channel: { $ref: "#/channels/orders" } },
          recvOrder: { action: "receive", channel: "orders" },
        },
      });
      const result = parseFlowSpec("ASYNCAPI", spec);
      if ("parseError" in result) throw new Error("expected flows");
      const byKey = Object.fromEntries(result.flows.map((f) => [f.key, f]));
      expect(byKey["send #/channels/orders"]!.interaction).toBe("PUSH");
      expect(byKey["receive orders"]!.interaction).toBe("SUBSCRIBE");
    });

    it("rejects malformed input with a sanitized parseError (never throws)", () => {
      const result = parseFlowSpec("ASYNCAPI", "channels: {\n  bad");
      if ("flows" in result) throw new Error("expected parseError");
      expect(result.parseError).toMatch(/AsyncAPI/);
    });
  });

  describe("GRAPHQL", () => {
    const SDL = `
type Query {
  pets(limit: Int): [Pet!]!
  pet(id: ID!): Pet
}
type Mutation {
  createPet(name: String!): Pet!
}
type Subscription {
  petAdded: Pet!
}
type Pet { id: ID!, name: String! }
`;

    it("emits one Flow per root field with owner-relative interaction", () => {
      const result = parseFlowSpec("GRAPHQL", SDL);
      if ("parseError" in result) {
        throw new Error(`expected flows: ${result.parseError}`);
      }
      const byKey = Object.fromEntries(result.flows.map((f) => [f.key, f]));
      expect(Object.keys(byKey).sort()).toEqual([
        "Mutation.createPet",
        "Query.pet",
        "Query.pets",
        "Subscription.petAdded",
      ]);
      expect(byKey["Query.pets"]!.interaction).toBe("REQUEST");
      expect(byKey["Mutation.createPet"]!.interaction).toBe("REQUEST");
      // A subscription streams results outward — owner PUSHes.
      expect(byKey["Subscription.petAdded"]!.interaction).toBe("PUSH");
      for (const flow of result.flows) expect(flow.kind).toBe("GRAPHQL_FIELD");
    });

    it("does NOT extract non-root types (Pet is a payload, not a route)", () => {
      const result = parseFlowSpec("GRAPHQL", SDL);
      if ("parseError" in result) throw new Error("expected flows");
      expect(result.flows.some((f) => f.key.startsWith("Pet."))).toBe(false);
    });

    it("honors a custom root type name via the schema block", () => {
      const sdl = `
schema { query: RootQuery }
type RootQuery { ping: String }
`;
      const result = parseFlowSpec("GRAPHQL", sdl);
      if ("parseError" in result) throw new Error("expected flows");
      expect(result.flows.map((f) => f.key)).toEqual(["RootQuery.ping"]);
    });

    it("rejects invalid SDL with a sanitized parseError", () => {
      const result = parseFlowSpec("GRAPHQL", "type Query { !!! }");
      if ("flows" in result) throw new Error("expected parseError");
      expect(result.parseError).toMatch(/GraphQL/);
    });
  });

  describe("SQL_DDL", () => {
    const DDL = `
CREATE TABLE users (
  id INT PRIMARY KEY,
  email VARCHAR(255) NOT NULL,
  bio TEXT
);
CREATE TABLE orders (
  id INT PRIMARY KEY,
  user_id INT NOT NULL,
  CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users (id)
);
`;

    it("emits one DB_TABLE Flow per CREATE TABLE", () => {
      const result = parseFlowSpec("SQL_DDL", DDL);
      if ("parseError" in result) {
        throw new Error(`expected flows: ${result.parseError}`);
      }
      expect(result.flows.map((f) => f.key)).toEqual(["users", "orders"]);
      for (const flow of result.flows) {
        expect(flow.kind).toBe("DB_TABLE");
        expect(flow.interaction).toBe("REQUEST");
      }
    });

    it("captures columns, primary key, and foreign keys in the signature", () => {
      const result = parseFlowSpec("SQL_DDL", DDL);
      if ("parseError" in result) throw new Error("expected flows");
      const users = result.flows.find((f) => f.key === "users")!;
      const sig = users.signature as {
        columns: Array<{ name: string; nullable: boolean; key: string | null }>;
        primaryKey: string[];
      };
      expect(sig.columns.map((c) => c.name)).toEqual(["id", "email", "bio"]);
      expect(sig.primaryKey).toContain("id");
      expect(sig.columns.find((c) => c.name === "email")!.nullable).toBe(false);
      expect(sig.columns.find((c) => c.name === "bio")!.nullable).toBe(true);

      const orders = result.flows.find((f) => f.key === "orders")!;
      const orderSig = orders.signature as {
        foreignKeys: Array<{ columns: string[]; references: string | null }>;
      };
      expect(orderSig.foreignKeys[0]!.columns).toContain("user_id");
      expect(orderSig.foreignKeys[0]!.references).toBe("users");
    });

    it("rejects invalid SQL with a sanitized parseError (never throws)", () => {
      const result = parseFlowSpec("SQL_DDL", "CREATE TABLE (((");
      if ("flows" in result) throw new Error("expected parseError");
      expect(result.parseError).toMatch(/SQL/);
    });
  });

  describe("TS_SIGNATURE", () => {
    const SRC = `
export function getUser(id: string): Promise<User> { return db.find(id); }
export const listUsers = (limit: number): User[] => [];
interface Repo {
  save(user: User): void;
}
`;

    it("emits one FUNCTION_CALL Flow per callable (function, const, method)", () => {
      const result = parseFlowSpec("TS_SIGNATURE", SRC);
      if ("parseError" in result) {
        throw new Error(`expected flows: ${result.parseError}`);
      }
      const keys = result.flows.map((f) => f.key).sort();
      expect(keys).toEqual(["Repo.save", "getUser", "listUsers"]);
      for (const flow of result.flows) {
        expect(flow.kind).toBe("FUNCTION_CALL");
        expect(flow.interaction).toBe("REQUEST");
      }
    });

    it("captures parameters and return type in the signature", () => {
      const result = parseFlowSpec("TS_SIGNATURE", SRC);
      if ("parseError" in result) throw new Error("expected flows");
      const getUser = result.flows.find((f) => f.key === "getUser")!;
      const sig = getUser.signature as {
        parameters: string[];
        returnType: string | null;
      };
      expect(sig.parameters).toEqual(["id: string"]);
      expect(sig.returnType).toBe("Promise<User>");
    });

    it("returns empty flows for source with no callables (never throws)", () => {
      const result = parseFlowSpec("TS_SIGNATURE", "type X = number;");
      if ("parseError" in result) throw new Error("expected flows");
      expect(result.flows).toHaveLength(0);
    });
  });
});

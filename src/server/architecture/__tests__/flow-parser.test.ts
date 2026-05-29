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
      // All flows from an OpenAPI spec are INBOUND (the owner exposes them).
      for (const flow of result.flows) {
        expect(flow.polarity).toBe("INBOUND");
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

  describe("other kinds (Slice 1 defers parsers)", () => {
    for (const kind of ["ASYNCAPI", "TS_SIGNATURE", "GRAPHQL", "CUSTOM"] as const) {
      it(`stores source with parseError for ${kind}`, () => {
        const result = parseFlowSpec(kind, "anything at all");
        if ("flows" in result) throw new Error("expected parseError");
        expect(result.parseError).toMatch(/not implemented yet/);
      });
    }
  });
});

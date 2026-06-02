import { describe, expect, it } from "vitest";

import { openapiParser } from "../openapi";

describe("openapiParser", () => {
  it("emits an Endpoint per operation, anchored by operationId when present", () => {
    const result = openapiParser.parse(
      JSON.stringify({
        openapi: "3.0.0",
        info: { title: "Pets", version: "1" },
        paths: {
          "/pets": {
            get: {
              operationId: "listPets",
              summary: "List pets",
              parameters: [
                { name: "limit", in: "query", schema: { type: "integer" } },
              ],
            },
            post: {
              summary: "Create",
              requestBody: {
                content: {
                  "application/json": {
                    schema: { type: "object", properties: { name: {} } },
                  },
                },
              },
            },
          },
        },
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tree).toHaveLength(2);
    const list = result.tree.find((n) => n.specKey === "listPets");
    expect(list).toBeDefined();
    expect(list?.kind).toBe("ENDPOINT");
    expect(list?.children?.[0]?.specKey).toBe("listPets#query:limit");
    // No operationId → fall back to "METHOD path".
    const post = result.tree.find((n) => n.specKey === "POST /pets");
    expect(post).toBeDefined();
    expect(post?.metadata?.requestBody).toMatchObject({
      contentTypes: ["application/json"],
      properties: ["name"],
    });
  });

  it("accepts YAML", () => {
    const result = openapiParser.parse(`
openapi: 3.0.0
info: { title: Pets, version: "1" }
paths:
  /pets:
    get:
      operationId: listPets
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tree[0]?.specKey).toBe("listPets");
  });

  it("returns parseError on garbage", () => {
    const result = openapiParser.parse("this is not :: valid: : yaml:: or json");
    expect(result.ok).toBe(false);
  });

  it("returns parseError when paths is missing", () => {
    const result = openapiParser.parse(JSON.stringify({ openapi: "3.0" }));
    expect(result.ok).toBe(false);
  });
});

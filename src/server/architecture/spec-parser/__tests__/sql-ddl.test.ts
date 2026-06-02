import { describe, expect, it } from "vitest";

import { sqlDdlParser } from "../sql-ddl";

describe("sqlDdlParser", () => {
  it("emits a Table per CREATE TABLE with columns as GENERIC children", () => {
    const result = sqlDdlParser.parse(`
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        age INT,
        balance NUMERIC(10,2) DEFAULT 0
      );
      CREATE TABLE orgs ( id INT, name TEXT NOT NULL, PRIMARY KEY (id) );
    `);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tree.map((t) => t.specKey)).toEqual(["users", "orgs"]);

    const users = result.tree[0]!;
    expect(users.kind).toBe("TABLE");
    expect(users.children?.map((c) => c.specKey)).toEqual([
      "users.id",
      "users.email",
      "users.age",
      "users.balance",
    ]);
    const id = users.children?.[0];
    expect(id?.kind).toBe("GENERIC");
    expect(id?.metadata).toMatchObject({ primaryKey: true, nullable: false });
    const balance = users.children?.[3];
    expect(balance?.metadata).toMatchObject({ dataType: "NUMERIC(10,2)" });

    // Table-level PRIMARY KEY (id) marks orgs.id PK.
    const orgs = result.tree[1]!;
    const orgId = orgs.children?.find((c) => c.specKey === "orgs.id");
    expect(orgId?.metadata?.primaryKey).toBe(true);
  });

  it("returns parseError when no CREATE TABLE is found", () => {
    const result = sqlDdlParser.parse("SELECT 1;");
    expect(result.ok).toBe(false);
  });

  it("returns parseError on unparsable SQL", () => {
    const result = sqlDdlParser.parse("CREATE TABLE oops (");
    expect(result.ok).toBe(false);
  });
});

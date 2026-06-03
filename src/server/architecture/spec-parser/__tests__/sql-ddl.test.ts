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

  it("materializes out-of-line ALTER TABLE foreign keys as REQUEST connections", () => {
    const result = sqlDdlParser.parse(`
      CREATE TABLE "User" ( "id" TEXT NOT NULL, CONSTRAINT "User_pkey" PRIMARY KEY ("id") );
      CREATE TABLE "Post" ( "id" TEXT NOT NULL, "createdById" TEXT NOT NULL, CONSTRAINT "Post_pkey" PRIMARY KEY ("id") );
      ALTER TABLE "Post" ADD CONSTRAINT "Post_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    `);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Identity is the ordered table pair, not the constraint name (so multiple
    // FKs between the same pair collapse to one dependency arrow).
    expect(result.connections).toEqual([
      {
        specKey: "Post->User",
        sourceKey: "Post",
        targetKey: "User",
        interaction: "REQUEST",
        label: "createdById",
      },
    ]);
  });

  it("merges multiple FKs between the same table pair into one connection", () => {
    const result = sqlDdlParser.parse(`
      CREATE TABLE "Node" ( "id" TEXT NOT NULL, CONSTRAINT "Node_pkey" PRIMARY KEY ("id") );
      CREATE TABLE "Edge" ( "id" TEXT NOT NULL, "sourceId" TEXT NOT NULL, "targetId" TEXT NOT NULL, CONSTRAINT "Edge_pkey" PRIMARY KEY ("id") );
      ALTER TABLE "Edge" ADD CONSTRAINT "Edge_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Node"("id");
      ALTER TABLE "Edge" ADD CONSTRAINT "Edge_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "Node"("id");
    `);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.connections).toEqual([
      {
        specKey: "Edge->Node",
        sourceKey: "Edge",
        targetKey: "Node",
        interaction: "REQUEST",
        label: "sourceId, targetId",
      },
    ]);
  });

  it("skips a self-referential foreign key (no self-link connection)", () => {
    const result = sqlDdlParser.parse(`
      CREATE TABLE "Node" ( "id" TEXT NOT NULL, "parentId" TEXT, CONSTRAINT "Node_pkey" PRIMARY KEY ("id") );
      ALTER TABLE "Node" ADD CONSTRAINT "Node_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Node"("id");
    `);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.connections).toEqual([]);
  });

  it("materializes a column-level REFERENCES foreign key", () => {
    const result = sqlDdlParser.parse(`
      CREATE TABLE users ( id INT PRIMARY KEY );
      CREATE TABLE posts (
        id INT PRIMARY KEY,
        author_id INT REFERENCES users(id)
      );
    `);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.connections).toHaveLength(1);
    expect(result.connections[0]).toMatchObject({
      sourceKey: "posts",
      targetKey: "users",
      interaction: "REQUEST",
    });
  });

  it("materializes a table-level FOREIGN KEY constraint inside CREATE TABLE", () => {
    const result = sqlDdlParser.parse(`
      CREATE TABLE users ( id INT PRIMARY KEY );
      CREATE TABLE posts (
        id INT PRIMARY KEY,
        author_id INT NOT NULL,
        CONSTRAINT posts_author_fk FOREIGN KEY (author_id) REFERENCES users (id)
      );
    `);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.connections).toHaveLength(1);
    expect(result.connections[0]).toMatchObject({
      specKey: "posts->users",
      sourceKey: "posts",
      targetKey: "users",
      interaction: "REQUEST",
      label: "author_id",
    });
  });

  it("drops a foreign key that references a table absent from the parse", () => {
    const result = sqlDdlParser.parse(`
      CREATE TABLE "Post" ( "id" TEXT NOT NULL, "authorId" TEXT NOT NULL, CONSTRAINT "Post_pkey" PRIMARY KEY ("id") );
      ALTER TABLE "Post" ADD CONSTRAINT "Post_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id");
    `);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.connections).toEqual([]);
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

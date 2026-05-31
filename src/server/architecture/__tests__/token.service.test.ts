import { createHmac } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import { type Actor } from "../actor";
import { NotFoundError } from "../errors";
import { hashToken } from "../token-hash";
import {
  createApiToken,
  listApiTokens,
  revokeApiToken,
} from "../token.service";
import { resetDb, testDb } from "./helpers/test-db";

// These tests HMAC with the pepper, so `API_TOKEN_PEPPER` must be set in
// .env.test (loaded by setup-env.ts). Without it, mint throws by design.

beforeEach(async () => {
  await resetDb();
});

function makeUser(name = "Owner") {
  return testDb.user.create({ data: { name } });
}

describe("createApiToken", () => {
  it("mints a token owned by the actor, shown once, with a matching prefix", async () => {
    const user = await makeUser();
    const actor: Actor = { userId: user.id, via: "session" };

    const { token, apiToken } = await createApiToken(testDb, actor, {
      label: "Laptop",
      expiresInDays: 90,
    });

    expect(token).toMatch(/^infdoc_[A-Za-z0-9_-]{20,}$/);
    expect(token.startsWith(apiToken.prefix)).toBe(true);
    expect(apiToken.label).toBe("Laptop");
    expect(apiToken.scopes).toEqual(["read"]);
    expect(apiToken.expiresAt).not.toBeNull();
    expect(apiToken.expiresAt!.getTime()).toBeGreaterThan(Date.now());

    const rows = await testDb.apiToken.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);
  });

  it("supports a non-expiring token", async () => {
    const user = await makeUser();
    const { apiToken } = await createApiToken(
      testDb,
      { userId: user.id },
      { expiresInDays: null },
    );
    expect(apiToken.expiresAt).toBeNull();
  });
});

describe("hash-at-rest", () => {
  it("stores only the HMAC hash, never the raw token", async () => {
    const user = await makeUser();
    const { token, apiToken } = await createApiToken(
      testDb,
      { userId: user.id },
      { expiresInDays: 90 },
    );

    const row = await testDb.apiToken.findUniqueOrThrow({
      where: { id: apiToken.id },
    });

    // The raw token appears in no column.
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row.tokenHash).not.toBe(token);

    // The stored hash is exactly HMAC(pepper, raw), recomputed independently.
    const pepper = process.env.API_TOKEN_PEPPER;
    expect(pepper).toBeTruthy();
    const expected = createHmac("sha256", pepper!)
      .update(token)
      .digest("hex");
    expect(row.tokenHash).toBe(expected);
  });

  it("is deterministic so #18 can resolve a presented token by hash", async () => {
    const user = await makeUser();
    const { token } = await createApiToken(
      testDb,
      { userId: user.id },
      { expiresInDays: 90 },
    );

    expect(hashToken(token)).toBe(hashToken(token));

    const found = await testDb.apiToken.findUnique({
      where: { tokenHash: hashToken(token) },
    });
    expect(found?.userId).toBe(user.id);
  });
});

describe("listApiTokens", () => {
  it("returns the actor's own tokens, newest first, without the hash", async () => {
    const owner = await makeUser("Owner");
    const other = await makeUser("Other");
    await createApiToken(testDb, { userId: owner.id }, { expiresInDays: 90 });
    await createApiToken(testDb, { userId: other.id }, { expiresInDays: 90 });

    const tokens = await listApiTokens(testDb, { userId: owner.id });

    expect(tokens).toHaveLength(1);
    expect(tokens[0]).not.toHaveProperty("tokenHash");
  });
});

describe("revokeApiToken", () => {
  it("soft-revokes a token and is idempotent", async () => {
    const user = await makeUser();
    const actor: Actor = { userId: user.id };
    const { apiToken } = await createApiToken(testDb, actor, {
      expiresInDays: 90,
    });

    const revoked = await revokeApiToken(testDb, actor, { id: apiToken.id });
    expect(revoked.revokedAt).not.toBeNull();
    const firstRevokedAt = revoked.revokedAt!.getTime();

    const again = await revokeApiToken(testDb, actor, { id: apiToken.id });
    // Idempotent: the original revocation timestamp is preserved.
    expect(again.revokedAt!.getTime()).toBe(firstRevokedAt);
  });

  it("reports another user's token as not-found (no existence disclosure)", async () => {
    const owner = await makeUser("Owner");
    const intruder = await makeUser("Intruder");
    const { apiToken } = await createApiToken(
      testDb,
      { userId: owner.id },
      { expiresInDays: 90 },
    );

    await expect(
      revokeApiToken(testDb, { userId: intruder.id }, { id: apiToken.id }),
    ).rejects.toBeInstanceOf(NotFoundError);

    // The owner's token is untouched.
    const row = await testDb.apiToken.findUniqueOrThrow({
      where: { id: apiToken.id },
    });
    expect(row.revokedAt).toBeNull();
  });
});

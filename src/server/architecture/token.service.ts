import type { Actor, Db } from "./actor";
import { assertCanWrite } from "./access";
import { NotFoundError } from "./errors";
import { isPrismaUniqueViolation } from "./prisma-errors";
import {
  CURRENT_KEY_VERSION,
  generateRawToken,
  hashToken,
  tokenPrefix,
} from "./token-hash";
import {
  createApiTokenInput,
  revokeApiTokenInput,
  type CreateApiTokenInput,
  type RevokeApiTokenInput,
} from "~/lib/schemas";

const MAX_TOKEN_ATTEMPTS = 3;
const MS_PER_DAY = 86_400_000;

// Every token is minted with a single read scope. Scopes are STORED, not
// enforced — authorization derives only from the owning user (ADR-0001,
// ADR-0021); this column exists so the wire/DB shape is stable before any
// scope-gated capability (#19/#20) lands.
const DEFAULT_TOKEN_SCOPES = ["read"];

// The fields safe to return to the owner: never `tokenHash` (the secret's only
// at-rest form) and never `userId` (implied by the actor). #18 reads the full
// row by id; this shape is the UI/list contract.
const publicTokenSelect = {
  id: true,
  label: true,
  prefix: true,
  scopes: true,
  createdAt: true,
  expiresAt: true,
  revokedAt: true,
} as const;

export interface PublicApiToken {
  id: string;
  label: string | null;
  prefix: string;
  scopes: string[];
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

export interface MintedApiToken {
  /** The raw token, returned EXACTLY once — never persisted, never logged. */
  token: string;
  apiToken: PublicApiToken;
}

function computeExpiresAt(expiresInDays: number | null): Date | null {
  if (expiresInDays === null) return null;
  return new Date(Date.now() + expiresInDays * MS_PER_DAY);
}

/**
 * Mints an API token for the actor. Ownership comes only from the actor —
 * `input` never carries a userId — so a caller can only ever mint a token they
 * own. The raw token is generated, hashed, and returned exactly once; only its
 * keyed hash and non-secret prefix persist (ADR-0020). Retries on the
 * astronomically unlikely `tokenHash` collision (the only unique column written,
 * so any P2002 here is that collision — mirrors `createWithUniqueSlug`).
 */
export async function createApiToken(
  db: Db,
  actor: Actor,
  input: CreateApiTokenInput,
): Promise<MintedApiToken> {
  const { label, expiresInDays } = createApiTokenInput.parse(input);
  const expiresAt = computeExpiresAt(expiresInDays);

  for (let attempt = 0; attempt < MAX_TOKEN_ATTEMPTS; attempt++) {
    const raw = generateRawToken();
    try {
      const apiToken = await db.apiToken.create({
        data: {
          userId: actor.userId,
          label: label ?? null,
          tokenHash: hashToken(raw),
          prefix: tokenPrefix(raw),
          keyVersion: CURRENT_KEY_VERSION,
          scopes: DEFAULT_TOKEN_SCOPES,
          expiresAt,
        },
        select: publicTokenSelect,
      });
      return { token: raw, apiToken };
    } catch (error) {
      if (isPrismaUniqueViolation(error) && attempt < MAX_TOKEN_ATTEMPTS - 1) {
        continue;
      }
      throw error;
    }
  }
  // Unreachable: the loop returns on success or throws on the final attempt.
  throw new Error("Failed to generate a unique API token.");
}

/** Lists the actor's own tokens, newest first. Never returns the hash. */
export async function listApiTokens(
  db: Db,
  actor: Actor,
): Promise<PublicApiToken[]> {
  return db.apiToken.findMany({
    where: { userId: actor.userId },
    orderBy: { createdAt: "desc" },
    select: publicTokenSelect,
  });
}

/**
 * Revokes one of the actor's own tokens (soft — stamps `revokedAt`, keeping the
 * prefix/audit trail). The lookup is scoped to the actor, so a token belonging
 * to another user is reported as not-found, never forbidden — collapsing
 * "doesn't exist" and "exists but not yours" so existence never leaks (ADR-0002,
 * the same posture as `getProjectBySlug`). Idempotent: re-revoking is a no-op.
 */
export async function revokeApiToken(
  db: Db,
  actor: Actor,
  input: RevokeApiTokenInput,
): Promise<PublicApiToken> {
  const { id } = revokeApiTokenInput.parse(input);

  const token = await db.apiToken.findFirst({
    where: { id, userId: actor.userId },
  });
  if (!token) {
    throw new NotFoundError();
  }
  // Defense-in-depth: the scoped fetch above already guarantees ownership.
  assertCanWrite(actor, { ownerId: token.userId });

  return db.apiToken.update({
    where: { id: token.id },
    data: { revokedAt: token.revokedAt ?? new Date() },
    select: publicTokenSelect,
  });
}

/**
 * Resolves a presented raw bearer token to an {@link Actor}, or `null` if the
 * token is absent, unknown, revoked, or expired. The consumer side of #17's
 * mint (#18, the MCP path): it re-derives the same keyed HMAC the row was stored
 * under (`hashToken`, ADR-0020) and looks the token up by `tokenHash @unique`,
 * so the raw value is matched without ever being stored. No timing-safe compare
 * is needed — equality is a Postgres unique-index probe (no hash is compared in
 * JS) and the raw token is 256-bit CSPRNG entropy, so there is no guessing
 * surface to time-attack.
 *
 * Every rejection — missing, unknown hash, revoked, or expired — returns the
 * SAME `null`; the caller maps it to one indistinguishable 401 and never
 * discloses which check failed (ADR-0002 non-disclosure, the posture
 * `revokeApiToken` uses for foreign tokens). Once resolved, authorization still
 * derives ONLY from `userId`; `scopes` ride onto the Actor for shape stability
 * but never gate anything (ADR-0021).
 *
 * Single key version today: `hashToken` defaults to `CURRENT_KEY_VERSION`, and
 * every minted token is v1, so one lookup is exact. When the pepper rotates
 * (a new version in `pepperForVersion`), this becomes a lookup per live version
 * — a purely additive change to the hash step, no schema or caller change.
 */
export async function resolveActorFromToken(
  db: Db,
  rawToken: string | undefined | null,
): Promise<Actor | null> {
  if (!rawToken) return null;

  const row = await db.apiToken.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    select: { userId: true, scopes: true, revokedAt: true, expiresAt: true },
  });
  if (!row) return null;
  if (row.revokedAt !== null) return null;
  if (row.expiresAt !== null && row.expiresAt.getTime() <= Date.now()) {
    return null;
  }

  return { userId: row.userId, scopes: row.scopes, via: "token" };
}

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

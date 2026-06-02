import { createHmac, randomBytes } from "node:crypto";

/**
 * API-token generation and keyed hashing — the single, shared home for the
 * "raw token -> stored hash" transform.
 *
 * #18 (the MCP route that resolves a bearer token to an Actor) imports
 * {@link hashToken} verbatim and `findUnique({ where: { tokenHash } })`: the
 * load-bearing contract is that `hashToken(raw, keyVersion)` is deterministic
 * and byte-identical to the `ApiToken.tokenHash` column written at mint. The
 * algorithm therefore lives here once and is never re-implemented at the
 * consumer side.
 *
 * HMAC-SHA256 (not bcrypt/argon2) is correct here: the raw token is 256-bit
 * CSPRNG output, so there is no low-entropy brute-force surface that slow
 * password hashing would defend — and a deterministic keyed digest is exactly
 * what #18 needs to look a token up by hash. The pepper (a server-side secret)
 * means a database-only leak cannot confirm a guessed token. No per-row salt:
 * it would break lookup-by-hash, and the pepper plays salt's role globally
 * (ADR-0020).
 */

const TOKEN_PREFIX = "infdoc_";
const PREFIX_DISPLAY_LENGTH = 12;

/**
 * The pepper key version stamped on newly minted tokens. Bump this (and add the
 * matching entry to {@link pepperForVersion}) to rotate the pepper: existing
 * tokens keep verifying under their stored `keyVersion`, new tokens hash under
 * the current one — no hash migration (ADR-0020).
 */
export const CURRENT_KEY_VERSION = 1;

/**
 * Read the pepper for a given key version directly from `process.env` — NOT via
 * `~/env`. This mirrors `test-db.ts`'s direct `DATABASE_URL` read: importing
 * `~/env` here would force every service test that touches the token layer to
 * supply unrelated auth secrets just to load the module (ADR-0003). `~/env`
 * remains the single validation authority (it fails the production build if the
 * pepper is missing); this is only the consumption site. A deployment-wide
 * secret is config, not the per-request ambient context ADR-0001 forbids.
 */
function pepperForVersion(keyVersion: number): string {
  const pepper = keyVersion === 1 ? process.env.API_TOKEN_PEPPER : undefined;
  if (!pepper) {
    throw new Error(
      `API_TOKEN_PEPPER for key version ${keyVersion} is not set. ` +
        "Set API_TOKEN_PEPPER in the environment before minting or verifying tokens.",
    );
  }
  return pepper;
}

/**
 * Generates a fresh raw API token: a recognizable `infdoc_` issuer tag (greppable
 * in logs, registrable with secret scanners) followed by 32 bytes (256 bits) of
 * CSPRNG entropy, URL-safe base64. Shown to the user exactly once; never stored.
 */
export function generateRawToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

/**
 * The non-secret leading slice of a raw token, persisted (`prefix`) so the
 * owner can recognize a token in the Connect-an-agent list. Far too short to
 * recover the remaining entropy.
 */
export function tokenPrefix(raw: string): string {
  return raw.slice(0, PREFIX_DISPLAY_LENGTH);
}

/**
 * The only persisted representation of a token's secret: HMAC-SHA256 of the raw
 * token keyed by the version's pepper, hex-encoded. Deterministic by contract so
 * #18 can look a presented token up by this value.
 */
export function hashToken(
  raw: string,
  keyVersion: number = CURRENT_KEY_VERSION,
): string {
  return createHmac("sha256", pepperForVersion(keyVersion))
    .update(raw)
    .digest("hex");
}

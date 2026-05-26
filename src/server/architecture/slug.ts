import { randomBytes } from "node:crypto";

/**
 * Generates an unguessable, URL-safe capability slug: 16 bytes (128 bits) of
 * CSPRNG entropy encoded as ~22 base64url characters. This is the entire
 * read-capability security property of a Project, so it must be generated
 * server-side and never derived from user input (see docs/adr/0002).
 */
export function generateSlug(): string {
  return randomBytes(16).toString("base64url");
}

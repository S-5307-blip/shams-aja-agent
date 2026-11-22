import { createHash, randomBytes } from "node:crypto";

/** Keys look like `sak_live_<43 url-safe chars>`; only the SHA-256 is stored. */
export const KEY_PREFIX = "sak_live_";
const KEY_LENGTH = KEY_PREFIX.length + 43;

export function generateApiKey() {
  const key = `${KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { key, hash: hashApiKey(key), prefix: key.slice(0, KEY_PREFIX.length + 6) };
}

export function hashApiKey(key: string) {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/** Reads `Authorization: Bearer <key>` (or `x-api-key`) and rejects anything not shaped like our keys. */
export function readApiKey(headers: Headers) {
  const auth = headers.get("authorization");
  const raw = auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : headers.get("x-api-key")?.trim();
  if (!raw || !raw.startsWith(KEY_PREFIX) || raw.length !== KEY_LENGTH) return null;
  return raw;
}

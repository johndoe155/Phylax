import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Signed values and one-time tokens.
 *
 * Two different jobs, two different mechanisms:
 *
 *   SIGNED VALUES (HMAC)  The browser holds a value it can read but cannot change: which pending sign-up it is looking
 *                         at, and the OAuth `state`. The value is `base64url(payload).base64url(hmac)`. The payload
 *                         carries an expiry, so a captured cookie stops working on its own.
 *
 *   ONE-TIME TOKENS        The magic-link token is a plain random secret. Only its SHA-256 hash is stored, so the
 *                         database never holds anything that could be replayed, and the link works exactly once.
 */

const b64u = (buf: Buffer) => buf.toString("base64url");

/** Sign a payload with the session secret. */
export function sign(payload: Record<string, unknown>, secret: string): string {
  const body = b64u(Buffer.from(JSON.stringify(payload), "utf8"));
  const mac = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

/** Verify and decode a signed value. Returns null when the signature is wrong, the shape is wrong, or it expired. */
export function unsign(token: string | undefined | null, secret: string, now = Date.now()): Record<string, unknown> | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const exp = payload.exp;
  if (exp !== undefined && (typeof exp !== "number" || !Number.isFinite(exp) || now >= exp)) return null;
  return payload;
}

/** A fresh random secret, URL-safe. Used for session ids and one-time tokens. */
export const randomToken = (bytes = 32) => b64u(randomBytes(bytes));

/** The stored form of a one-time token: its SHA-256 hash. */
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * The stored form of a LOW-ENTROPY identifier: an HMAC, not a plain digest.
 *
 * An unsalted SHA-256 of `name@example.com`, `+2348012345678` or an IPv4 address is a rainbow-table lookup —
 * the space of each is small enough to enumerate. Keyed with a secret, the stored value is not invertible by
 * anybody without the key, and the key never leaves the process. High-entropy random tokens
 * (session ids, one-time links) keep the plain digest: there is nothing to brute-force in 256 random bits.
 *
 * `secret` is the deployment's identifier key (see `identifierKeys`), so the same address hashes to the same
 * value across processes and restarts, which is what makes suppressions and budget windows work.
 */
export const hashIdentifier = (value: string, secret: string) =>
  createHmac("sha256", secret).update("phylax-identifier-v1:").update(value).digest("hex");

/**
 * Every hash a stored identifier might be under, newest key first.
 *
 * THE PROBLEM THIS SOLVES. `delivery_suppressions` is keyed by this hash. It used to be keyed by SESSION_SECRET,
 * which made a secret rotation a silent data-loss event: rebuild the machine with a new SESSION_SECRET and every
 * existing suppression stops matching, so the people who replied STOP — or whose address hard-bounced — start
 * being texted and emailed again, with nothing in the log to say why. It is also a disaster-recovery trap, because
 * SESSION_SECRET is exactly the value that gets lost in a rebuild.
 *
 * So the key is now its own configuration (`IDENTIFIER_HASH_KEY`), it can be backed up independently of the
 * session secret, and a deliberate rotation is supported by keeping the previous keys on the LOOKUP side. Writes
 * always use the current key; reads accept any of them. Because these are intentionally one-way HMACs and the
 * plaintext address is never stored, existing rows CANNOT be rehashed under a new key. Keep every previous key
 * in the lookup set for as long as suppressions made with it may remain; `scripts/phylax-ops.mjs identifiers keys`
 * prints safe fingerprints and the retained-row count so operators can inventory that responsibility.
 *
 * @param value    the canonical identifier, e.g. `sms:+2348012345678`
 * @param keys     `identifierKeys(config)` — current key first, then any previous keys
 */
export function hashIdentifierAll(value: string, keys: readonly string[]): string[] {
  const out: string[] = [];
  for (const key of keys) {
    const hash = hashIdentifier(value, key);
    if (!out.includes(hash)) out.push(hash);
  }
  return out;
}

/**
 * The identifier keys for a configuration: the current one first, then any previous keys still honoured.
 *
 * Falls back to SESSION_SECRET when IDENTIFIER_HASH_KEY is unset, which is what keeps an existing deployment
 * matching the hashes it has already stored — the derivation is unchanged, only the ability to move it is new.
 */
export function identifierKeys(config: { identifierHashKey: string; identifierHashPreviousKeys: string[] }): string[] {
  return [config.identifierHashKey, ...config.identifierHashPreviousKeys];
}

/** The single hash new rows are written under. */
export function identifierHash(config: { identifierHashKey: string }, value: string): string {
  return hashIdentifier(value, config.identifierHashKey);
}

/** Constant-time comparison of two hex hashes. */
export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

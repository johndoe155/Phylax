import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { log } from "../log.js";

/**
 * Password hashing.
 *
 * scrypt from Node's own crypto: no native module to compile, nothing to approve in pnpm's
 * `ignoredBuiltDependencies`, and a memory-hard KDF that is the right tool for a password store.
 *
 * The stored format is self-describing, so the parameters can be raised later without invalidating old hashes:
 *
 *   scrypt$<N>$<r>$<p>$<salt base64url>$<hash base64url>
 *
 * `verify` is constant-time with respect to the hash bytes, and returns false (rather than throwing) for anything
 * that is not a hash this module produced.
 */

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem?: number },
) => Promise<Buffer>;

const N = 131072; // CPU/memory cost
const r = 8; // block size
const p = 1; // parallelisation
const KEYLEN = 64; // 512-bit output
const SALT_BYTES = 16;

/** scrypt's default maxmem is too small for N=16384, r=8; give it room. */
const MAXMEM = 160 * 1024 * 1024;

let active = 0;
let waiting = 0;
const MAX_CONCURRENT_KDF = 2;
const KDF_QUEUE_LIMIT = 16;
const KDF_WAIT_MS = 10000;
const queue: (() => void)[] = [];

/**
 * A small FIFO queue in front of the KDF.
 *
 * scrypt is deliberately expensive (N=2^17, ~128 MB each) and Node runs it on libuv's thread pool, which it
 * shares with DNS and file I/O. The old behaviour was to fail the THIRD concurrent operation with a 503 —
 * including ordinary sign-ins during a password change. Now the extra operations wait their turn (bounded), and
 * only a genuinely saturated service refuses work. The deployment also raises the pool with
 * UV_THREADPOOL_SIZE (see deploy/oci/phylax.service).
 */
async function boundedKdf<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT_KDF) {
    if (waiting >= KDF_QUEUE_LIMIT) throw Object.assign(new Error("Password service busy"), { code: "KDF_BUSY" });
    waiting++;
    let entry: (() => void) | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (entry) {
            const at = queue.indexOf(entry);
            if (at >= 0) queue.splice(at, 1);
          }
          reject(Object.assign(new Error("Password service busy"), { code: "KDF_BUSY" }));
        }, KDF_WAIT_MS);
        entry = () => { clearTimeout(timer); resolve(); };
        queue.push(entry);
      });
    } finally {
      waiting--;
    }
  }
  active++;
  try { return await fn(); } finally {
    active--;
    const next = queue.shift();
    if (next) next();
  }
}
/** Hash a password. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await boundedKdf(() => scrypt(password.normalize("NFKC"), salt, KEYLEN, { N, r, p, maxmem: MAXMEM }));
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

/** Check a password against a stored hash. Never throws: a malformed hash is simply "wrong". */
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const n = Number(parts[1]);
  const rr = Number(parts[2]);
  const pp = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(rr) || !Number.isInteger(pp)) return false;
  const salt = Buffer.from(parts[4]!, "base64url");
  const expected = Buffer.from(parts[5]!, "base64url");
  if (salt.length !== 16 || expected.length !== KEYLEN || ![16384, 32768, 65536, 131072].includes(n) || rr !== 8 || pp !== 1) return false;
  try {
    const actual = await boundedKdf(() => scrypt(password.normalize("NFKC"), salt, expected.length, {
      N: n,
      r: rr,
      p: pp,
      maxmem: MAXMEM,
    }));
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * Whether a stored hash was made with weaker parameters than the ones in force now.
 *
 * The stored format is self-describing, so the cost can be raised later without invalidating old hashes — but
 * nothing raised them. Sign-in now checks this and transparently re-hashes (see the sign-in route), so
 * accounts created under an older cost migrate the next time their owner signs in.
 */
export function needsRehash(stored: string | null | undefined): boolean {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return true; // not a hash we produced: replace it
  return Number(parts[1]) !== N;
}

/**
 * How strong a password is, as a score from 0 to 4.
 *
 * A length-first heuristic with a small penalty for the obvious passwords. It is a guide for the person, not a
 * gate: the server's real rule is a minimum length.
 */
export function passwordStrength(password: string): { score: 0 | 1 | 2 | 3 | 4; label: string } {
  const value = password;
  if (value.length === 0) return { score: 0, label: "Empty" };
  let score = 0;
  if (value.length >= 8) score++;
  if (value.length >= 12) score++;
  if (value.length >= 16) score++;
  if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score++;
  if (/\d/.test(value)) score++;
  if (/[^A-Za-z0-9]/.test(value)) score++;
  // A common password, however long, is not a strong password.
  const common = ["password", "12345678", "qwerty", "letmein", "welcome", "admin", "iloveyou", "phylax"];
  if (common.some((c) => value.toLowerCase().includes(c))) score = Math.min(score, 1);
  if (value.length < 8) score = Math.min(score, 1);
  const clamped = Math.max(0, Math.min(4, score)) as 0 | 1 | 2 | 3 | 4;
  const labels = ["Too short", "Weak", "Fair", "Good", "Strong"];
  return { score: clamped, label: labels[clamped]! };
}

/** The server's own minimum. Eight characters, the same floor the demo used. */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * The outcome of a breach-corpus check.
 *
 * `checked: false` means the deployment did not get an answer it can act on — the feature is off, or the provider
 * was unreachable, slow, or replied with something unparseable. In every one of those cases the password is
 * ALLOWED (fail-open): a third party being down must not lock people out of creating an account. `checked: true`
 * means the corpus answered definitively, and `breached` says whether this exact password is in it.
 */
export type BreachResult =
  | { checked: false; breached: false; reason: "disabled" | "timeout" | "network" | "http" | "malformed" }
  | { checked: true; breached: boolean; count: number };

/**
 * k-anonymity breach check against a Pwned-Passwords-style range endpoint (Have I Been Pwned by default).
 *
 * THE PRIVACY CONTRACT. The password is SHA-1'd locally and only the FIRST FIVE hex characters are sent. The
 * provider returns every suffix it holds for that prefix (tens of thousands of hashes, ~a few hundred KB); the
 * match is found on our side. Neither the provider nor anybody on the network path learns the password, its full
 * hash, or — with `Add-Padding: true` — even reliably which suffix we cared about, because the provider pads the
 * response with decoys. The full hash NEVER leaves this process.
 *
 * Fail-open by design and bounded by `timeoutMs` (an AbortController, not a socket default), so a slow or dead
 * provider degrades to "no answer" rather than a hung sign-up.
 */
export async function checkPasswordBreach(
  password: string,
  opts: { enabled: boolean; url: string; timeoutMs: number },
): Promise<BreachResult> {
  if (!opts.enabled) return { checked: false, breached: false, reason: "disabled" };
  const sha1 = createHash("sha1").update(password, "utf8").digest("hex").toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);
  const base = opts.url.endsWith("/") ? opts.url : `${opts.url}/`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const response = await fetch(`${base}${prefix}`, {
      signal: controller.signal,
      headers: {
        // Ask the provider to pad the response with decoy suffixes, so an observer cannot tell which hash (if any)
        // matched. Supported by the HIBP range API.
        "Add-Padding": "true",
      },
    });
    if (!response.ok) {
      log.warn("password breach check: non-200 from provider", { code: "breach_http", status: response.status });
      return { checked: false, breached: false, reason: "http" };
    }
    const body = await response.text();
    if (typeof body !== "string" || !body.trim()) {
      log.warn("password breach check: empty body from provider", { code: "breach_malformed" });
      return { checked: false, breached: false, reason: "malformed" };
    }
    for (const line of body.split(/\r?\n/)) {
      const sep = line.indexOf(":");
      if (sep <= 0) continue;
      const candidate = line.slice(0, sep).trim().toUpperCase();
      if (candidate.length !== suffix.length) continue;
      // Constant-time compare the suffix so a timing observer cannot walk the corpus one character at a time.
      if (candidate.length === 35 && suffix.length === 35 &&
          timingSafeEqual(Buffer.from(candidate, "utf8"), Buffer.from(suffix, "utf8"))) {
        const count = Number(line.slice(sep + 1).trim());
        return { checked: true, breached: true, count: Number.isFinite(count) ? count : 1 };
      }
    }
    return { checked: true, breached: false, count: 0 };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      log.warn("password breach check: provider timed out", { code: "breach_timeout", timeoutMs: opts.timeoutMs });
      return { checked: false, breached: false, reason: "timeout" };
    }
    log.warn("password breach check: provider unreachable", { code: "breach_network", error });
    return { checked: false, breached: false, reason: "network" };
  } finally {
    clearTimeout(timer);
  }
}

import type { Request, Response } from "express";
import { hashToken, randomToken } from "./tokens.js";
import { query, queryOne, execute, withTransaction } from "../db.js";
import { HttpError } from "../http.js";
import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";

/**
 * Sessions.
 *
 * The cookie holds an opaque random id. The id means nothing on its own: everything about the session (who it
 * belongs to, when it expires, when it was last used) is a row in the `sessions` table. That makes expiry exact,
 * makes "sign out everywhere" a single delete, and means a stolen cookie can be revoked.
 *
 * The cookie is httpOnly (JavaScript cannot read it), SameSite=Lax (a cross-site POST cannot ride it) and Secure in
 * production (it never crosses plaintext). The name comes from `shared/const.ts`, so the browser and the server
 * agree on it.
 */

export { COOKIE_NAME };

export type Session = {
  id: string;
  account_id: string;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
  reauthenticated_at?: Date | null;
};

/** The row the session lookup returns: the session's columns and the account's, side by side. */
type SessionRow = {
  id: string;
  account_id: string;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
  reauthenticated_at?: Date | null;
  account_created_at: Date;
};

export type Account = {
  id: string;
  display_name: string;
  email: string | null;
  email_verified: boolean;
  phone: string | null;
  created_at: Date;
  /** Set when an operator has suspended the account; `requireAuth` refuses a suspended account with 403. */
  suspended_at: Date | null;
};

export type SessionOptions = {
  secure: boolean;
  domain?: string;
  sameSite: "lax" | "strict" | "none";
  ttlMs: number;
};

/** The options for the session cookie, from the configuration. */
export function sessionCookieOptions(opts: {
  secure: boolean;
  domain?: string;
  sameSite: "lax" | "strict" | "none";
  ttlDays: number;
}): SessionOptions {
  return {
    secure: opts.secure,
    domain: opts.domain,
    sameSite: opts.sameSite,
    ttlMs: Math.min(opts.ttlDays * 24 * 60 * 60 * 1000, ONE_YEAR_MS),
  };
}

/** Set the session cookie on a response. */
export function setSessionCookie(res: Response, sessionId: string, opts: SessionOptions) {
  res.cookie(COOKIE_NAME, sessionId, {
    httpOnly: true,
    secure: opts.secure,
    sameSite: opts.sameSite,
    domain: opts.domain,
    path: "/",
    maxAge: opts.ttlMs,
  });
}

/** Remove the session cookie. */
export function clearSessionCookie(res: Response, opts: SessionOptions) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: opts.secure,
    sameSite: opts.sameSite,
    domain: opts.domain,
    path: "/",
  });
}

/** Create a session row and set the cookie. */
export async function createSession(
  res: Response,
  accountId: string,
  opts: SessionOptions & { userAgent?: string; ip?: string | null; proof?: { method: string; value: string } },
): Promise<string> {
  const id = randomToken(32);
  const expiresAt = new Date(Date.now() + opts.ttlMs);
  await withTransaction(async client => {
  const account = await client.query<{ suspended_at: Date | null }>("SELECT id, suspended_at FROM accounts WHERE id=$1 FOR UPDATE", [accountId]);
  if(!account.rowCount) throw new Error("Account no longer exists");
  // A suspended account cannot open a new session. createSession is the chokepoint every sign-in flows through
  // (password, magic link, OAuth, passkey), so refusing here covers all of them at once — and it is under the
  // account's row lock, so a suspension that lands mid-sign-in is seen rather than raced past.
  if (account.rows[0]!.suspended_at) {
    throw new HttpError(403, "account_suspended", "This account is suspended. Contact support if you believe this is a mistake.");
  }
  if(opts.proof) {
    const proof=opts.proof;
    const live=proof.method === "passkey" ? await client.query("SELECT id FROM passkeys WHERE account_id=$1 AND credential_id=$2",[accountId,proof.value]) : proof.method === "password" ? await client.query("SELECT id FROM auth_identities WHERE account_id=$1 AND method='password' AND password_hash=$2",[accountId,proof.value]) : await client.query("SELECT id FROM auth_identities WHERE account_id=$1 AND method=$2 AND provider_subject=$3",[accountId,proof.method,proof.value]);
    if(!live.rowCount) throw Object.assign(new Error("Credential changed during sign-in"),{code:"40001"});
  }
  await client.query(
    `INSERT INTO sessions (id, account_id, expires_at, user_agent, ip, reauthenticated_at)
     VALUES ($1, $2, $3, $4, $5, now())`,
    [hashToken(id), accountId, expiresAt.toISOString(), opts.userAgent?.slice(0, 300) ?? null, opts.ip ?? null],
  );
  });
  setSessionCookie(res, id, opts);
  return id;
}

/**
 * The idle-expiry cutoff for a session lookup, or null when idle expiry is off.
 *
 * `SESSION_IDLE_TIMEOUT_MINUTES` is a SEPARATE control from the absolute `expires_at` TTL: a session can be within
 * its 30-day life but abandoned on a shared machine, and an idle timeout signs it out after a period of no use.
 * `last_seen_at` is written by `touchSession`, which is throttled to once a minute per process, so the stored value
 * can be up to ~60s stale for a genuinely active user. The config floor (>= 2 minutes when enabled) keeps that
 * staleness from ever expiring an active session. The cutoff is computed once per call so a lookup and the touch
 * that follows agree on "now".
 */
function idleCutoff(idleTimeoutMinutes: number | undefined): string | null {
  if (!idleTimeoutMinutes || idleTimeoutMinutes <= 0) return null;
  return new Date(Date.now() - idleTimeoutMinutes * 60000).toISOString();
}

/** Look up a session and its account. Returns null when the id is unknown, expired, or idle for too long. */
export async function resolveSession(
  sessionId: string | undefined,
  opts?: { idleTimeoutMinutes?: number },
): Promise<{ session: Session; account: Account } | null> {
  if (!sessionId) return null;
  // $2 is the idle cutoff, or NULL to disable the check. A session last seen before the cutoff is treated exactly
  // like an expired one: the caller sees no account and requireAuth answers 401. The row is swept by pruneSessions.
  const row = await queryOne<SessionRow & { account_created_at: Date } & Omit<Account, "created_at">>(
    `SELECT s.id, s.account_id, s.created_at, s.last_seen_at, s.expires_at, s.reauthenticated_at,
            a.id AS account_id, a.display_name, a.email, a.email_verified, a.phone, a.created_at AS account_created_at,
            a.suspended_at
       FROM sessions s
       JOIN accounts a ON a.id = s.account_id
      WHERE s.id = $1 AND s.expires_at > now()
        AND ($2::timestamptz IS NULL OR s.last_seen_at >= $2::timestamptz)`,
    [hashToken(sessionId), idleCutoff(opts?.idleTimeoutMinutes)],
  );
  if (!row) return null;
  return {
    session: {
      id: row.id,
      account_id: row.account_id,
      created_at: row.created_at,
      last_seen_at: row.last_seen_at,
      expires_at: row.expires_at,
      reauthenticated_at: row.reauthenticated_at,
    },
    account: {
      id: row.account_id,
      display_name: row.display_name,
      email: row.email,
      email_verified: row.email_verified,
      phone: row.phone,
      created_at: row.account_created_at,
      suspended_at: row.suspended_at ?? null,
    },
  };
}

/**
 * Touch a session so `last_seen_at` reflects real use. Best effort: never fails a request.
 *
 * Throttled: this used to run an UPDATE on every single API request, which is a write per page view on a table
 * nobody reads in the request path. A session is touched at most once a minute (in this process), which is
 * precise enough for "where am I signed in?" and removes the per-request write entirely.
 */
const TOUCH_INTERVAL_MS = 60000;
const lastTouched = new Map<string, number>();

export async function touchSession(sessionId: string): Promise<void> {
  const now = Date.now();
  const previous = lastTouched.get(sessionId);
  if (previous !== undefined && now - previous < TOUCH_INTERVAL_MS) return;
  lastTouched.set(sessionId, now);
  // Keep the throttle map from growing without bound.
  if (lastTouched.size > 5000) {
    for (const [id, at] of lastTouched) if (now - at > TOUCH_INTERVAL_MS) lastTouched.delete(id);
  }
  try {
    await execute("UPDATE sessions SET last_seen_at = now() WHERE id = $1", [sessionId]);
  } catch {
    /* a failed touch is not worth failing the request over */
  }
}

/** Delete one session (sign out) and clear the cookie. */
export async function destroySession(res: Response, sessionId: string | undefined, opts: SessionOptions): Promise<void> {
  if (sessionId) await execute("DELETE FROM sessions WHERE id = $1", [hashToken(sessionId)]);
  clearSessionCookie(res, opts);
}

/**
 * Delete every session of an account.
 *
 * `exceptSessionId` keeps one session alive — the one making the request. That is what "sign out everywhere
 * else" means: the tab you are in stays signed in, the phone you left on the bus does not.
 */
export async function destroyAllSessions(accountId: string, exceptSessionId?: string | null): Promise<number> {
  if (exceptSessionId) {
    return execute("DELETE FROM sessions WHERE account_id = $1 AND id <> $2", [accountId, hashToken(exceptSessionId)]);
  }
  return execute("DELETE FROM sessions WHERE account_id = $1", [accountId]);
}

/**
 * The live sessions of an account, newest first.
 *
 * This is what the person sees when they ask "where am I signed in?". The address is the one the session was
 * created from, which is the proxy's address when the app is behind one.
 */
export async function listSessions(accountId: string, opts?: { idleTimeoutMinutes?: number }) {
  // The device list honours the same idle rule as the auth gate, so a session that idle-expired does not keep
  // showing up as "signed in" on the account page until its absolute TTL lapses.
  return query<{
    id: string;
    user_agent: string | null;
    ip: string | null;
    created_at: Date;
    last_seen_at: Date;
    expires_at: Date;
  reauthenticated_at?: Date | null;
  }>(
    `SELECT id, user_agent, ip, created_at, last_seen_at, expires_at
       FROM sessions WHERE account_id = $1 AND expires_at > now()
         AND ($2::timestamptz IS NULL OR last_seen_at >= $2::timestamptz)
       ORDER BY last_seen_at DESC`,
    [accountId, idleCutoff(opts?.idleTimeoutMinutes)],
  );
}

// NOTE: `destroyOneSession(accountId, sessionId)` was removed. It was dead — nothing called it — and broken: it
// matched `id = $2` against the RAW session id, but the table stores `hashToken(id)`, so it would delete nothing
// while appearing to sign a device out. Revoking one session is done from the /sessions route with the stored id.

/**
 * Remove sessions that have expired or idle-timed-out. Called by the scheduler.
 *
 * An idle-expired session is already unusable (resolveSession refuses it), but its row would otherwise sit until
 * the absolute TTL lapses. Sweeping it here reclaims the row and keeps `sessions_idle_idx` small.
 */
export async function pruneSessions(opts?: { idleTimeoutMinutes?: number }): Promise<number> {
  const cutoff = idleCutoff(opts?.idleTimeoutMinutes);
  return execute(
    "DELETE FROM sessions WHERE expires_at <= now() OR ($1::timestamptz IS NOT NULL AND last_seen_at < $1::timestamptz)",
    [cutoff],
  );
}

/** The number of live sessions for an account. */
export async function countSessions(accountId: string): Promise<number> {
  const row = await queryOne<{ n: string }>("SELECT count(*)::text AS n FROM sessions WHERE account_id = $1 AND expires_at > now()", [accountId]);
  return Number(row?.n ?? 0);
}

/** Re-export so routes can import the query helpers from one place. */
export { query, queryOne, execute };

/** The request's session id, from the cookie header. */
export function sessionIdFromRequest(req: Request, cookieName = COOKIE_NAME): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== cookieName) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return part.slice(eq + 1).trim();
    }
  }
  return undefined;
}

import type { Request, Response } from "express";
import { execute, queryOne } from "../db.js";
import { sign, unsign } from "./tokens.js";
import { parseCookies } from "../http.js";

/**
 * The sign-up in progress.
 *
 * When a sign-in finds no account, the server keeps what it learned in `pending_signups` and gives the browser a
 * signed cookie holding only the row's id. The browser therefore cannot read the pending sign-up, cannot change it,
 * and cannot replay it after it has expired.
 *
 * The row expires on its own (fifteen minutes).
 *
 * IT NO LONGER STORES A PASSWORD. This table used to carry `password_hash`, left over from the flow in which
 * typing a password at sign-in created an account. That flow was deliberately removed — password sign-in does not
 * create accounts, and every sign-up now begins with a proved email link, a provider verification claim or a
 * passkey ceremony — but the column stayed, so a scrypt hash of a password somebody had typed sat in a table with
 * a fifteen-minute expiry and no code path that could ever read it. A stored credential with no reader is only a
 * disclosure risk: it widens what a database leak exposes and buys nothing. Migration 015 drops the column.
 */

export const PENDING_COOKIE = "phylax_pending";
const PENDING_TTL_MS = 15 * 60 * 1000;

export type PendingSignup = {
  id: string;
  method: "password" | "link" | "apple" | "google" | "passkey";
  email: string | null;
  provider: string | null;
  provider_subject: string | null;
  /** Whether the provider says it has verified this address. */
  email_verified: boolean;
  display_name: string | null;
  created_at: Date;
  expires_at: Date;
};

/** Create a pending sign-up row and return it. */
export async function createPendingSignup(input: {
  method: PendingSignup["method"];
  email?: string | null;
  provider?: string | null;
  providerSubject?: string | null;
  displayName?: string | null;
  emailVerified?: boolean;
}): Promise<PendingSignup> {
  const expiresAt = new Date(Date.now() + PENDING_TTL_MS);
  const row = await queryOne<PendingSignup>(
    `INSERT INTO pending_signups
       (method, email, provider, provider_subject, display_name, email_verified, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      input.method,
      input.email ?? null,
      input.provider ?? null,
      input.providerSubject ?? null,
      input.displayName ?? null,
      input.emailVerified ?? false,
      expiresAt.toISOString(),
    ],
  );
  return row!;
}

/** Read a pending sign-up by id, if it is still alive. */
export async function getPendingSignup(id: string | undefined | null): Promise<PendingSignup | null> {
  if (!id) return null;
  return queryOne<PendingSignup>("SELECT * FROM pending_signups WHERE id = $1 AND expires_at > now()", [id]);
}

/** Remove a pending sign-up. Called once it has been turned into an account. */
export async function deletePendingSignup(id: string): Promise<void> {
  await execute("DELETE FROM pending_signups WHERE id = $1", [id]);
}

/** Remove pending sign-ups that have expired. Called by the scheduler. */
export async function prunePendingSignups(): Promise<number> {
  return execute("DELETE FROM pending_signups WHERE expires_at <= now()");
}

/** Set the pending sign-up cookie. */
export function setPendingCookie(res: Response, pendingId: string, secret: string, secure: boolean) {
  const value = sign({ pid: pendingId, exp: Date.now() + PENDING_TTL_MS }, secret);
  res.cookie(PENDING_COOKIE, value, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: PENDING_TTL_MS,
  });
}

/** Clear the pending sign-up cookie. */
export function clearPendingCookie(res: Response, secure: boolean) {
  res.clearCookie(PENDING_COOKIE, { httpOnly: true, secure, sameSite: "lax", path: "/" });
}

/** The pending sign-up this request is carrying, if any. */
export async function pendingFromRequest(req: Request, secret: string): Promise<PendingSignup | null> {
  const cookies = parseCookies(req.headers.cookie);
  const payload = unsign(cookies[PENDING_COOKIE], secret);
  const id = typeof payload?.pid === "string" ? payload.pid : undefined;
  return getPendingSignup(id);
}

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { execute, isDbEnabled, queryOne } from "../db.js";
import { identifierHash } from "../auth/tokens.js";
import { log } from "../log.js";
import type { Config } from "../config.js";

/**
 * One-click unsubscribe (RFC 8058).
 *
 * WHAT WAS WRONG. The `List-Unsubscribe` header pointed at `${APP_URL}/account` — the login-gated account page. So
 * the "unsubscribe" a mailbox provider offers in its own UI was a link to a sign-in form. Gmail and Yahoo have
 * required a working one-click for bulk senders since 2024, and a header that leads to an authentication wall is
 * not one: it is the reason a person marks the mail as spam instead, which then suppresses their TRANSACTIONAL
 * mail too (see control.ts). Text alerts had the same shape of problem, with the only route out being a reply of
 * STOP that only worked when the provider forwarded inbound messages.
 *
 * WHAT THIS DOES. A signed, expiring token that identifies the recipient hash and the channel, carried in the
 * message. `POST` with `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (what a mailbox provider sends) and a
 * plain `GET` (what a person clicking a link in the message body does) both land on a route that needs no session,
 * writes the suppression, and renders a confirmation.
 *
 * The token contains the recipient HASH, never the address: the suppression table is keyed by hash, so the route
 * can act without ever learning who the address belongs to, and a leaked token reveals nothing enumerable.
 */

export type UnsubscribeChannel = "email" | "sms";

/** Long enough for a mail that sat unread for weeks, short enough that a leaked token eventually dies. */
const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const PURPOSE = "phylax-unsubscribe-v1";

type TokenPayload = { channel: UnsubscribeChannel; recipientHash: string; exp: number; nonce: string };

/**
 * The key the token is signed with.
 *
 * Deliberately NOT SESSION_SECRET: rotating the session secret (a routine response to any suspicion of a leak)
 * would otherwise invalidate every unsubscribe link already sitting in somebody's inbox, and the person clicking
 * it would be told their request was invalid — which reads as "we ignored you" and produces a spam complaint.
 * UNSUBSCRIBE_TOKEN_KEY overrides; otherwise the identifier key is used, which is already required to be stable
 * across a rebuild for suppressions to keep matching.
 */
function signingKey(config: Config): string {
  return config.UNSUBSCRIBE_TOKEN_KEY?.trim() || config.identifierHashKey;
}

function sign(payload: TokenPayload, key: string): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const mac = createHmac("sha256", key).update(`${PURPOSE}:${body}`).digest("base64url");
  return `${body}.${mac}`;
}

function decode(token: string, key: string): TokenPayload | null {
  if (typeof token !== "string" || token.length > 512) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = createHmac("sha256", key).update(`${PURPOSE}:${body}`).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const p = payload as Partial<TokenPayload>;
  if (p.channel !== "email" && p.channel !== "sms") return null;
  if (typeof p.recipientHash !== "string" || !/^[a-f0-9]{64}$/.test(p.recipientHash)) return null;
  if (typeof p.exp !== "number" || !Number.isFinite(p.exp) || Date.now() >= p.exp) return null;
  return p as TokenPayload;
}

/**
 * Build the unsubscribe token for one recipient.
 *
 * Returns null when there is no database to record the suppression in, so callers omit the header rather than
 * emit a link that would answer "unavailable".
 */
export function unsubscribeToken(config: Config, channel: UnsubscribeChannel, to: string): string | null {
  if (!isDbEnabled()) return null;
  const address = to.trim().toLowerCase();
  if (!address) return null;
  return sign(
    {
      channel,
      recipientHash: identifierHash(config, `${channel}:${address}`),
      exp: Date.now() + TOKEN_TTL_MS,
      nonce: randomBytes(8).toString("base64url"),
    },
    signingKey(config),
  );
}

/** The URL a person, or a mailbox provider, is sent to. */
export function unsubscribeUrl(config: Config, token: string): string {
  return `${config.APP_URL.replace(/\/+$/, "")}/api/unsubscribe/${encodeURIComponent(token)}`;
}

/**
 * The headers an ALERT message carries. Transactional messages deliberately carry none: a password reset is not
 * something a person should be able to unsubscribe from, and RFC 8058 one-click is defined for bulk mail.
 */
export function unsubscribeHeaders(config: Config, channel: UnsubscribeChannel, to: string): Record<string, string> {
  const token = unsubscribeToken(config, channel, to);
  if (!token) return {};
  const url = unsubscribeUrl(config, token);
  const contact = config.SERVICE_CONTACT_EMAIL?.trim() || config.MAIL_REPLY_TO?.trim();
  const mailto = contact ? `<mailto:${contact}?subject=Unsubscribe>, ` : "";
  return {
    "List-Unsubscribe": `${mailto}<${url}>`,
    // RFC 8058: this is what turns the provider's UI button into a real one-click instead of a mailto draft.
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

/** The link to put in the message body, for clients that do not surface the header. */
export function unsubscribeLink(config: Config, channel: UnsubscribeChannel, to: string): string | null {
  const token = unsubscribeToken(config, channel, to);
  return token ? unsubscribeUrl(config, token) : null;
}

export type UnsubscribeResult =
  | { ok: true; channel: UnsubscribeChannel; alreadySuppressed: boolean }
  | { ok: false; code: "invalid_token" | "unavailable" };

/**
 * Apply an unsubscribe. Idempotent: doing it twice is not an error, and the second call reports that the
 * suppression was already there rather than pretending to have done work.
 *
 * Only a `stop` suppression is written. A `bounced` or `complained` row is the provider's word about the address
 * and must not be downgraded to a user preference by this route — but it is also not an error, because from the
 * person's point of view "stop emailing me" has been honoured either way.
 */
export async function applyUnsubscribe(config: Config, token: string): Promise<UnsubscribeResult> {
  const payload = decode(token, signingKey(config));
  if (!payload) return { ok: false, code: "invalid_token" };
  if (!isDbEnabled()) return { ok: false, code: "unavailable" };
  try {
    const existing = await queryOne<{ reason: string }>(
      "SELECT reason FROM delivery_suppressions WHERE recipient_hash = $1",
      [payload.recipientHash],
    );
    if (existing && existing.reason !== "stop") {
      return { ok: true, channel: payload.channel, alreadySuppressed: true };
    }
    await execute(
      `INSERT INTO delivery_suppressions(recipient_hash, reason) VALUES ($1, 'stop')
       ON CONFLICT (recipient_hash) DO UPDATE SET reason = 'stop'`,
      [payload.recipientHash],
    );
    log.info("recipient unsubscribed", { channel: payload.channel, source: "one_click" });
    return { ok: true, channel: payload.channel, alreadySuppressed: !!existing };
  } catch (err) {
    log.error("unsubscribe failed", { channel: payload.channel, error: err });
    return { ok: false, code: "unavailable" };
  }
}

/** Re-subscribe, from the confirmation page's "that wasn't me" / "I changed my mind" action. */
export async function applyResubscribe(config: Config, token: string): Promise<UnsubscribeResult> {
  const payload = decode(token, signingKey(config));
  if (!payload) return { ok: false, code: "invalid_token" };
  if (!isDbEnabled()) return { ok: false, code: "unavailable" };
  try {
    // Only a `stop` is reversible by the recipient. A hard bounce stays until an operator clears it, because the
    // alternative is resuming delivery to an address the provider has already told us twice is bad.
    const changed = await execute(
      "DELETE FROM delivery_suppressions WHERE recipient_hash = $1 AND reason = 'stop'",
      [payload.recipientHash],
    );
    log.info("recipient resubscribed", { channel: payload.channel, changed: !!changed });
    return { ok: true, channel: payload.channel, alreadySuppressed: !changed };
  } catch (err) {
    log.error("resubscribe failed", { channel: payload.channel, error: err });
    return { ok: false, code: "unavailable" };
  }
}

/** Validate a token without acting on it, so the confirmation page can say what it is about to do. */
export function inspectUnsubscribeToken(config: Config, token: string): { channel: UnsubscribeChannel } | null {
  const payload = decode(token, signingKey(config));
  return payload ? { channel: payload.channel } : null;
}

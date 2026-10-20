import { hashIdentifierAll, identifierHash, identifierKeys } from "../auth/tokens.js";
import { execute, isDbEnabled, queryOne } from "../db.js";
import type { Config } from "../config.js";

/**
 * Durable counters: one atomic increment shared by workers/restarts.
 *
 * The keys are opaque strings supplied by the caller. Anything derived from a person (an address, a number, an
 * IP) arrives here already reduced by `hashIdentifier`, so the table never holds a brute-forceable digest of a
 * low-entropy value.
 */
export type BudgetReservation = { key: string; bucket: number; units: number };

/**
 * Reserve `units` against a fixed-window budget.
 *
 * The window's bucket number is returned so the reservation can be refunded EXACTLY: refunding "the current
 * bucket" would quietly debit a different window if the clock rolled over between the send and its failure.
 */
export async function reserveBudget(key: string, max: number, seconds: number, units = 1): Promise<{ allowed: boolean; bucket: number }> {
  if (!isDbEnabled()) return { allowed: false, bucket: 0 };
  if (!Number.isInteger(units) || units < 1 || units > max) return { allowed: false, bucket: 0 };
  const bucket = Math.floor(Date.now() / (seconds * 1000));
  const row = await queryOne(`INSERT INTO rate_buckets(key,bucket,hits,expires_at) VALUES($1,$2,$5,now()+$3*interval '1 second')
    ON CONFLICT(key,bucket) DO UPDATE SET hits=rate_buckets.hits+$5 WHERE rate_buckets.hits+$5<=$4 RETURNING hits`,
    [key, bucket, seconds * 2, max, units]);
  return { allowed: !!row, bucket };
}

/** Reserve against a budget without needing the bucket back. */
export async function budget(key: string, max: number, seconds: number, units = 1): Promise<boolean> {
  return (await reserveBudget(key, max, seconds, units)).allowed;
}

/**
 * How much of a window is already spent, without spending any.
 *
 * This is what makes "count failures only" possible: the request is checked against what is already spent, and
 * the spend happens when the response turns out to be a failure. Checking by spending would make every request
 * a spend, which is exactly what the failure-only counter exists to avoid.
 */
export async function budgetSpent(key: string, seconds: number): Promise<number> {
  if (!isDbEnabled()) return 0;
  const bucket = Math.floor(Date.now() / (seconds * 1000));
  const row = await queryOne<{ hits: number }>("SELECT hits FROM rate_buckets WHERE key=$1 AND bucket=$2", [key, bucket]);
  return row?.hits ?? 0;
}

/**
 * Give back a reservation that was not spent.
 *
 * A failed send must not consume the budget: with up to 48 retries, a few hours of provider outage would
 * otherwise exhaust a recipient's daily cap (and the global cap) on messages that were never delivered. The
 * bucket is the one the reservation was taken from, so the refund is exact even across a window boundary.
 */
export async function refundBudget(key: string, bucket: number, units = 1): Promise<void> {
  if (!isDbEnabled()) return;
  if (!Number.isInteger(units) || units < 1) return;
  await execute(`UPDATE rate_buckets SET hits = GREATEST(hits - $3, 0) WHERE key=$1 AND bucket=$2`, [key, bucket, units])
    .catch(() => { /* a refund is best-effort; a missed one is an under-count, never an over-count */ });
}

/** What a delivery check decided: the reservations taken (to refund on failure), or the reason it was refused. */
export type DeliveryDecision =
  | { ok: true; reservations: BudgetReservation[] }
  | { ok: false; reason: string };

/**
 * The suppression lookup, across every identifier key the deployment has used.
 *
 * `delivery_suppressions` is keyed by an HMAC of the recipient. When the key rotates, the OLD rows do not stop
 * being true — an address that hard-bounced is still bad — so a lookup that only tried the current key would
 * silently resume sending to everybody who had opted out or bounced. Every configured key is tried. See
 * `hashIdentifierAll` in auth/tokens.ts for why this is not keyed by SESSION_SECRET any more.
 */
async function findSuppression(config: Config, channel: "email" | "sms", to: string): Promise<string | null> {
  const hashes = hashIdentifierAll(`${channel}:${to.trim().toLowerCase()}`, identifierKeys(config));
  if (!hashes.length) return null;
  const row = await queryOne<{ reason: string }>(
    "SELECT reason FROM delivery_suppressions WHERE recipient_hash = ANY($1::text[]) LIMIT 1",
    [hashes],
  );
  return row?.reason ?? null;
}

/**
 * Whether a suppression blocks THIS class of traffic.
 *
 * A spam complaint used to lock a person out of their own account. `deliveryAllowed` applied `complained` and
 * `bounced` suppression to transactional mail as well as to alerts, so a user who marked one alert as spam could
 * no longer receive a sign-in link or a password reset — and `resubscribe` only cleared `stop`, so there was no
 * way back except an operator computing an HMAC they had no tool for.
 *
 * The distinction that matters is WHY the address is suppressed:
 *
 *   stop        the person asked. Blocks everything, and is reversible by them (resubscribe, or texting START).
 *   complained  the person marked an ALERT as spam. That is an answer about marketing-style mail, not about
 *               "is this address reachable" — so it blocks alerts but NOT the transactional mail they are
 *               actively waiting for. Blocking it turns a preference into a lockout.
 *   bounced     the address does not work. Blocks everything: sending to it is pointless and, for a hard bounce,
 *               damages the sending domain's reputation with every mailbox provider.
 */
function suppressionBlocks(reason: string, kind: "alert" | "transactional"): boolean {
  if (reason === "bounced" || reason === "stop") return true;
  if (reason === "complained") return kind === "alert";
  // An unknown reason is treated as the most restrictive: a suppression nobody recognises is still a suppression.
  return true;
}

/**
 * Whether a message may be sent, and against which budgets it is counted.
 *
 * `kind` separates two very different traffic classes. `alert` is the reminder scheduler: a bounded number of
 * messages per account per hour, per-recipient and global daily caps. `transactional` is everything a person is
 * waiting for RIGHT NOW — a sign-in link, a password reset, a security notice, a verification code. They used to
 * share one budget, which meant a burst of alerts (or one abusive account) could stop people signing in. They
 * now have their own recipient and global budgets.
 */
export async function deliveryAllowed(
  config: Config,
  channel: "email" | "sms",
  to: string,
  units = 1,
  kind: "alert" | "transactional" = "alert",
): Promise<DeliveryDecision> {
  // The target hash is computed under the CURRENT key. Budget windows are deliberately not multi-key: a rotation
  // resets a day's counters, which is an under-count, never an over-count, and the alternative (a reservation per
  // key) would let an attacker who could force a rotation clear their own budget.
  const target = identifierHash(config, `${channel}:${to.trim().toLowerCase()}`);

  const suppressed = await findSuppression(config, channel, to);
  if (suppressed && suppressionBlocks(suppressed, kind)) {
    // `recipient_suppressed_stop` and friends are distinguishable in the log and in the reminder's error column,
    // which is what makes "why did my alerts stop?" answerable without reading the database.
    return { ok: false, reason: `recipient_suppressed_${suppressed}` };
  }
  if (channel === "sms" && config.SMS_ALLOWED_PREFIXES.length && !config.SMS_ALLOWED_PREFIXES.some(p => to.startsWith(p))) return { ok: false, reason: "country_not_allowed" };

  const recipientKey = `delivery:${kind}:${channel}:${target}`;
  const recipientMax = kind === "transactional"
    ? (channel === "sms" ? config.SMS_TRANSACTIONAL_RECIPIENT_DAILY_LIMIT : config.MAIL_TRANSACTIONAL_RECIPIENT_DAILY_LIMIT)
    : (channel === "sms" ? config.SMS_RECIPIENT_DAILY_LIMIT : 30);
  const recipientWindow = channel === "sms" ? 86400 : 3600;
  const recipient = await reserveBudget(recipientKey, recipientMax, recipientWindow, units);
  if (!recipient.allowed) return { ok: false, reason: "recipient_rate_limited" };

  const globalKey = `global-delivery:${kind}:${channel}`;
  const globalMax = kind === "transactional"
    ? (channel === "sms" ? config.SMS_TRANSACTIONAL_DAILY_LIMIT : config.MAIL_TRANSACTIONAL_DAILY_LIMIT)
    : (channel === "sms" ? config.SMS_DAILY_LIMIT : config.MAIL_DAILY_LIMIT);
  const global = await reserveBudget(globalKey, globalMax, 86400, units);
  if (!global.allowed) {
    await refundBudget(recipientKey, recipient.bucket, units);
    return { ok: false, reason: "daily_budget_exceeded" };
  }

  return {
    ok: true,
    reservations: [
      { key: recipientKey, bucket: recipient.bucket, units },
      { key: globalKey, bucket: global.bucket, units },
    ],
  };
}

/** Refund every reservation of a failed delivery. */
export async function refundDelivery(reservations: readonly BudgetReservation[]): Promise<void> {
  for (const r of reservations) await refundBudget(r.key, r.bucket, r.units);
}

export async function trackDelivery(provider: string, providerId: string | undefined, channel: "email" | "sms", to: string, config: Config, context?: { reminderId?: string; accountId?: string }) {
  if (!providerId) return;
  await execute(`INSERT INTO notification_deliveries(provider,provider_id,channel,recipient_hash,reminder_id,account_id)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(provider,provider_id) DO NOTHING`,
    [provider, providerId, channel, identifierHash(config, `${channel}:${to.trim().toLowerCase()}`), context?.reminderId ?? null, context?.accountId ?? null]);
}

import { log } from "./log.js";
import type { Config } from "./config.js";

/**
 * Cloudflare Turnstile.
 *
 * WHY IT IS HERE. The endpoints that turn an anonymous or freshly-created account into an outbound message are
 * the ones that cost real money and leak real information: requesting a phone verification code sends an SMS to a
 * number the caller chooses, and requesting a sign-in link sends mail to an address the caller chooses. Both are
 * reachable by a script.
 *
 * Per-account and per-network budgets bound how MUCH one source can spend, and they are the primary defence —
 * this is the second one. A budget says "you have had your three"; a bot check says "you are not a person", and
 * it does so before the first message is ever queued. SMS pumping in particular is profitable inside minutes of
 * an account being created, which is faster than any daily budget can react to.
 *
 * THE DEGRADATION RULES MATTER MORE THAN THE CHECK:
 *
 *   - no secret configured: the check is skipped entirely. Development, and any deployment that fronts the origin
 *     with something else, keeps working. Nothing about this is required to run the product.
 *   - the verification call fails (network, timeout, Cloudflare down): FAIL OPEN, and log it. A captcha provider
 *     outage must not take down sign-in. The budgets behind it are still enforcing, so failing open degrades to
 *     the defence that was already there rather than to nothing.
 *   - Cloudflare answers and says the token is bad: fail CLOSED when TURNSTILE_ENFORCE is true, and log-only when
 *     it is false. That flag exists so the widget can be rolled out in observe mode — deployed, measured, and only
 *     then switched to rejecting — instead of going straight from "no check" to "real people are locked out".
 */

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Why a check failed. `missing_token` is "no widget answer arrived"; `rejected` is "Cloudflare said no". */
export type Failure = { ok: false; reason: "missing_token" | "rejected" };

export type TurnstileOutcome = { required: false } | { ok: true } | Failure;

/** Whether this deployment asks for a Turnstile token at all. Published to the client by /api/auth/providers. */
export function turnstileEnabled(config: Config): boolean {
  return !!config.TURNSTILE_SECRET_KEY?.trim() && !!config.TURNSTILE_SITE_KEY?.trim();
}

/**
 * Verify a Turnstile token.
 *
 * @param token    the `turnstileToken` from the request body
 * @param clientIp the caller's address, passed to Cloudflare so it can correlate with its own telemetry. It is
 *                 advisory: Turnstile does not reject on a mismatch, and behind a proxy it may well be absent.
 */
export async function verifyTurnstile(config: Config, token: unknown, clientIp?: string | null): Promise<TurnstileOutcome> {
  if (!turnstileEnabled(config)) return { required: false };

  if (typeof token !== "string" || token.length === 0 || token.length > 4096) {
    return enforce(config, "missing_token", { tokenPresent: false });
  }

  const body = new URLSearchParams({ secret: config.TURNSTILE_SECRET_KEY!.trim(), response: token });
  // `remoteip` is optional in Cloudflare's API and must be a valid address; sending a proxy's or a malformed one
  // is worse than sending nothing.
  if (clientIp && /^[\d.]+$|^[0-9a-fA-F:]+$/.test(clientIp)) body.set("remoteip", clientIp);

  let response: Response;
  try {
    response = await fetch(VERIFY_URL, {
      method: "POST",
      signal: AbortSignal.timeout(5000),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch (err) {
    // FAIL OPEN. A captcha provider being unreachable is not a reason to stop people signing in, and the
    // per-account and per-network budgets are still enforcing behind this.
    log.warn("turnstile verification could not be reached; allowing the request", { code: "turnstile_unreachable", error: err });
    return { ok: true };
  }

  if (!response.ok) {
    log.warn("turnstile verification returned an error status; allowing the request", { code: "turnstile_http_error", status: response.status });
    return { ok: true };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (err) {
    log.warn("turnstile verification returned a body that was not JSON; allowing the request", { code: "turnstile_bad_body", error: err });
    return { ok: true };
  }

  const result = payload as { success?: unknown; "error-codes"?: unknown };
  if (result.success === true) return { ok: true };

  return enforce(config, "rejected", { errorCodes: Array.isArray(result["error-codes"]) ? result["error-codes"] : undefined });
}

/**
 * Turn a failed verification into either a refusal or a log line, according to TURNSTILE_ENFORCE.
 *
 * Observe mode (`TURNSTILE_ENFORCE=false`) records exactly what enforcing would have refused, which is how an
 * operator finds out whether the widget is breaking real people BEFORE it starts doing so.
 */
function enforce(config: Config, reason: Failure["reason"], detail: Record<string, unknown>): TurnstileOutcome {
  const record = { code: `turnstile_${reason}`, enforced: config.TURNSTILE_ENFORCE, ...detail };
  if (config.TURNSTILE_ENFORCE) {
    log.warn("turnstile verification refused the request", record);
    return { ok: false, reason };
  }
  log.warn("turnstile verification failed but enforcement is off; allowing the request", record);
  return { ok: true };
}

/**
 * Throw the caller-facing error for a failed check, or return when the check passed or was not required.
 *
 * The message tells the person what to DO. "Human check failed" on its own reads as an accusation, and the two
 * real cases are different: a widget that never rendered (stale bundle, script blocked) needs a reload, and a
 * token Cloudflare rejected needs a retry.
 */
export function assertTurnstile(outcome: TurnstileOutcome): void {
  if ("required" in outcome) return;
  if (outcome.ok) return;
  const err = new Error(
    outcome.reason === "missing_token"
      ? "Complete the human check and try again. If no check appeared, reload the page."
      : "That human check did not pass. Reload the page and try again.",
  ) as Error & { status: number; code: string; reason: string };
  err.status = 400;
  err.code = "human_check_failed";
  err.reason = outcome.reason;
  throw err;
}

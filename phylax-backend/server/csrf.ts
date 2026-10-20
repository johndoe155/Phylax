import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { parseCookies } from "./http.js";
import { forbidden } from "./http.js";
import { log } from "./log.js";

/**
 * Cross-site request forgery protection.
 *
 * The session cookie is `SameSite=Lax`, which already stops a form on another site from riding it on a POST.
 * That is the primary defence and it is a good one. But `SameSite` is configuration, and `COOKIE_SAME_SITE=none`
 * is a legal setting: if somebody sets it (for a legitimate reason, such as an embedded view), the protection
 * silently disappears. So there is a second, explicit defence that does not depend on the cookie's settings.
 *
 * THE PATTERN is the double-submit cookie:
 *
 *   - the server puts a random value in a cookie that JavaScript CAN read;
 *   - the browser sends that value back in the `X-CSRF-Token` header on every request that changes something;
 *   - the server checks that the two match.
 *
 * An attacker on another site can make the browser SEND the cookie (a form does that automatically) but cannot
 * READ it, so it cannot put the right value in the header. A cross-site request therefore fails the check, and
 * a request from the site itself always passes.
 *
 * The same value is put in the OAuth `state`, which binds the provider's callback to the browser that started
 * it. Without that, an attacker could complete a sign-in with their own Google account in the victim's browser.
 */

export const CSRF_COOKIE = "phylax_csrf";
export const CSRF_HEADER = "x-csrf-token";
const SIGN_PURPOSE = "phylax-csrf-v1";
const RAW_TOKEN_BYTES = 32;
/** base64url(32 bytes) = 43 chars; the signature adds 43 more plus a separator. */
const MIN_SIGNED_LENGTH = 43 + 1 + 20;

/**
 * A fresh token: 32 random bytes, signed, as `value.signature`.
 *
 * THE SIGNATURE IS THE POINT. A bare double-submit token is defeated by cookie tossing: a script on a SIBLING
 * subdomain (`anything.phylax.example.com`, which on a shared host or a lapsed subdomain takeover is not ours) can
 * set `document.cookie = "phylax_csrf=X; domain=.phylax.example.com"`. The victim's browser then sends that cookie
 * to the real origin, the attacker's own page reads the value it planted, puts it in the `X-CSRF-Token` header, and
 * the two match — so the check passes even though the attacker never read a cookie the server issued.
 *
 * With the signature, the planted value has to carry an HMAC the attacker cannot compute, and a cookie without a
 * valid signature is not accepted as "existing" at all: the server simply replaces it with a signed one.
 */
export function newCsrfToken(secret: string): string {
  return signCsrfToken(randomBytes(RAW_TOKEN_BYTES).toString("base64url"), secret);
}

/** Sign a token value. Exported for tests that need to mint a token the middleware will accept. */
export function signCsrfToken(value: string, secret: string): string {
  const mac = createHmac("sha256", secret).update(`${SIGN_PURPOSE}:${value}`).digest("base64url");
  return `${value}.${mac}`;
}

/** Whether a cookie value was issued by this server, and not planted by a sibling subdomain. */
export function isSignedCsrfToken(token: string | undefined, secret: string): boolean {
  if (!token || token.length < MIN_SIGNED_LENGTH) return false;
  const dot = token.lastIndexOf(".");
  if (dot <= 0 || dot === token.length - 1) return false;
  const value = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(`${SIGN_PURPOSE}:${value}`).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Compare two tokens without leaking their contents through the time they take.
 *
 * Unsigned tokens are still accepted HERE, so long as they match the cookie exactly: a request that presents the
 * same value in both places has satisfied the double-submit property regardless of who issued it, and refusing it
 * would break every client holding a cookie from before the signature existed (they get a signed cookie on the
 * next response and recover transparently). The signature is what stops a PLANTED cookie from being usable at
 * all — see `csrfMiddleware`, which refuses to adopt one.
 */
function sameToken(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

/**
 * Make sure the browser has a CSRF cookie, and remember the value on the request.
 *
 * The cookie is NOT httpOnly: the browser has to be able to read it and put it in the header. That is safe,
 * because a script on another origin cannot read this origin's cookies either. What is NOT safe is a script on a
 * sibling subdomain WRITING one, which is why an unsigned cookie is never adopted as this browser's token.
 */
export function csrfMiddleware(options: { secure: boolean; sameSite: "lax" | "strict" | "none"; secret: string }) {
  return (req: Request, res: Response, next: NextFunction) => {
    const cookies = parseCookies(req.headers.cookie);
    const existing = cookies[CSRF_COOKIE];
    // An unsigned cookie is treated as absent. That is what defeats cookie tossing: the attacker's planted value
    // is replaced by a signed one before it can ever be compared against a header.
    const accepted = isSignedCsrfToken(existing, options.secret) ? existing : undefined;
    const token = accepted ?? newCsrfToken(options.secret);
    if (token !== existing) {
      res.cookie(CSRF_COOKIE, token, {
        httpOnly: false,
        secure: options.secure,
        sameSite: options.sameSite,
        path: "/",
        maxAge: 24 * 60 * 60 * 1000,
      });
      if (existing && !accepted) {
        // Worth a log line: an unsigned CSRF cookie arriving at this origin means something on a sibling
        // subdomain is writing cookies for the parent domain, which is either a misconfiguration or an attack.
        log.warn("rejected an unsigned CSRF cookie", { code: "csrf_cookie_tossed" });
      }
    }
    (req as Request & { csrfToken?: string }).csrfToken = token;
    next();
  };
}

/** The token this request is carrying. */
export function csrfTokenFromRequest(req: Request): string | undefined {
  return (req as Request & { csrfToken?: string }).csrfToken;
}

/** The token the browser sent in the header. */
export function csrfTokenFromHeader(req: Request): string | undefined {
  const given = req.headers[CSRF_HEADER];
  const value = Array.isArray(given) ? given[0] : given;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Check the token on a request that changes something.
 *
 * The methods that only read are not checked: they cannot change anything, and checking them would break the
 * browser's prefetching and any link a person follows from a message.
 */
export function requireCsrf() {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
      next();
      return;
    }
    const cookie = csrfTokenFromRequest(req);
    const header = csrfTokenFromHeader(req);
    if (!sameToken(cookie, header)) {
      next(forbidden("csrf_failed", "That request could not be verified. Reload the page and try again."));
      return;
    }
    next();
  };
}

/**
 * Check that the request came from this site.
 *
 * A belt to the braces' braces: a request that carries an `Origin` header from somewhere else is refused,
 * whatever the token says. A request with no `Origin` (a form post from an old browser, say) is allowed
 * through, because the token check has already covered it.
 */
export function requireSameOrigin(allowedOrigins: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
      next();
      return;
    }
    const origin = req.headers.origin;
    if (!origin) {
      next();
      return;
    }
    if (allowedOrigins.includes(origin)) {
      next();
      return;
    }
    next(forbidden("cross_origin", "That request came from somewhere else, so it was not carried out."));
  };
}

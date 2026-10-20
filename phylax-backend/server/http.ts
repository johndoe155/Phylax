import type { NextFunction, Request, RequestHandler, Response } from "express";
import {requestLocks} from "./requestLocks.js";
import { randomUUID } from "node:crypto";
import { log } from "./log.js";

/**
 * Small HTTP helpers shared by the API routes.
 *
 * The error shape is fixed and documented, because the browser has to read it:
 *
 *   { "error": { "code": "invalid_credentials", "message": "That email and password don't match.", "field": "password" } }
 *
 * `field` is optional and pins the message under one input on the sign-in form (the browser's `AuthError` takes the
 * same three field names). `message` is always written as what the person should do, never as a stack trace.
 */

/** An error with an HTTP status and a stable machine-readable code. */
export class HttpError extends Error {
  status: number;
  code: string;
  field?: "email" | "password" | "displayName";
  /** Extra details that are safe to show (never internals). */
  details?: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    options?: { field?: "email" | "password" | "displayName"; details?: Record<string, unknown> },
  ) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.field = options?.field;
    this.details = options?.details;
  }
}

export const badRequest = (code: string, message: string, field?: HttpError["field"]) =>
  new HttpError(400, code, message, { field });
export const unauthorized = (code: string, message: string) => new HttpError(401, code, message);
export const forbidden = (code: string, message: string) => new HttpError(403, code, message);
export const notFound = (code: string, message: string) => new HttpError(404, code, message);
export const tooManyRequests = (message: string) => new HttpError(429, "too_many_requests", message);
export const unavailable = (message: string) => new HttpError(503, "unavailable", message);
export const conflict = (code: string, message: string) => new HttpError(409, code, message);

/** Wrap an async handler so a rejected promise reaches the error middleware. */
export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    const release=requestLocks.get(req);let forwarded=false;
    fn(req,res,(error)=>{forwarded=true;next(error);}).catch(next).finally(()=>{if(!forwarded)return release?.();}).catch(()=>{});
  };
}

/** Parse a Cookie header into a plain object. Small enough not to need a dependency. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    const value = part.slice(eq + 1).trim();
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

/**
 * The bucket a client address belongs to, for rate limiting.
 *
 * An IPv4 address is its own bucket. An IPv6 address is not: a single subscriber is routinely handed a whole /64
 * (2^64 addresses), so keying per address lets one person spend the budget of a million "clients" and, worse,
 * lets one abuser rotate through a fresh budget per request. Addresses in the same /64 are one bucket. The
 * address is still normalised: IPv4-mapped IPv6 (`::ffff:1.2.3.4`) is treated as IPv4.
 */
export function rateLimitBucket(address: string | null | undefined): string {
  if (!address) return "unknown";
  const value = address.replace(/^::ffff:/i, "");
  if (value.includes(":")) {
    const parts = value.split(":");
    return `${parts.slice(0, 4).join(":")}::/64`;
  }
  return value;
}

/**
 * The client's address.
 *
 * The address has to be the person's, not the proxy's, or the rate limiter counts every visitor as one person.
 * But the forwarded header is only trustworthy when it came from the proxy we put in front of the app: anybody
 * else can send `X-Forwarded-For: 1.2.3.4` and pretend to be a different visitor, which would make the rate
 * limiter useless.
 *
 * So: when the socket is one of our own proxies, the forwarded header is believed. When it is not, the socket
 * address is used and the header is ignored. Express's own `req.ip` does the same thing, once `trust proxy` has
 * been set to the right value — this function is the explicit version, used by the limiter.
 */
export function clientIp(req: Request, trustedProxies?: (ip: string) => boolean): string | null {
  const socketAddress = req.socket.remoteAddress ?? null;

  if (trustedProxies) {
    const forwarded = req.headers["x-forwarded-for"];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const claimed = first?.split(",")[0]?.trim();
    if (claimed && socketAddress && trustedProxies(socketAddress)) return claimed;
    return socketAddress;
  }

  // Without a list of trusted proxies, fall back to Express's own answer, which honours `app.set("trust proxy")`.
  return req.ip ?? socketAddress;
}

/** The error middleware. Everything the API throws ends up here. */
export function errorMiddleware() {
  return (err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) { _next(err); return; }
    if (err instanceof HttpError) {
      // A 4xx is the person's input, not a fault on our side, so it is not worth a stack trace. It is still
      // worth a line in the log: a burst of 401s is a sign of something.
      res.setHeader("x-error-code", err.code);
      if (err.status >= 500) {
        log.error("request failed", { path: req.path, method: req.method, code: err.code, error: err.stack ?? err.message });
      } else {
        log.debug("request rejected", { path: req.path, method: req.method, code: err.code, status: err.status });
      }
      res.status(err.status).json({
        error: {
          code: err.code,
          message: err.message,
          ...(err.field ? { field: err.field } : {}),
          ...(err.details ?? {}),
        },
      });
      return;
    }

    const dbCode = typeof err === "object" && err ? String((err as { code?: unknown }).code ?? "") : "";
    const mapped: Record<string, [number, string, string]> = {
      "23505": [409,"conflict","This record already exists. Refresh and try again."],
      "23503": [409,"record_changed","A related record changed. Refresh and try again."],
      "23514": [400,"invalid_input","The record does not satisfy the required constraints."],
      // A missing required value or a value too long for its column is the request's fault, not the server's.
      "23502": [400,"invalid_input","A required value is missing."],
      "22001": [400,"invalid_input","One of the values is too long."],
      "22003": [400,"invalid_input","One of the values is out of range."],
      "22007": [400,"date_invalid","Choose a valid calendar date."], "22008": [400,"date_invalid","Choose a valid calendar date."],
      "22P02": [400,"invalid_input","Check the supplied values."],
      "40001": [409,"retry","The record changed concurrently. Retry."], "40P01": [409,"retry","The record changed concurrently. Retry."],
      "57014": [503,"busy","Storage is busy. Retry shortly."], "55P03": [409,"busy","This record is currently busy. Retry shortly."],
      "KDF_BUSY": [503,"busy","Password service is busy. Retry shortly."]
    };
    const safe = mapped[dbCode] ?? (/^(08|53|57P)/.test(dbCode) ? [503,"unavailable","Storage is temporarily unavailable."] as const : null);
    if (safe) { res.setHeader("x-error-code", safe[1]); res.status(safe[0]).json({ error: { code: safe[1], message: safe[2] } }); return; }
    // A body that is not valid JSON. Express raises this as a SyntaxError with the raw body attached.
    if (err instanceof SyntaxError && "body" in err) {
      res.setHeader("x-error-code", "invalid_json");
      res.status(400).json({ error: { code: "invalid_json", message: "That request wasn't valid JSON." } });
      return;
    }

    // Express raises its own errors with a status: a body over the limit is 413, an unsupported media type is
    // 415, and so on. They used to be reported as 500s, which sent people looking in the wrong place.
    const status = typeof (err as { status?: unknown })?.status === "number" ? (err as { status: number }).status : undefined;
    if (status && status >= 400 && status < 500) {
      const code =
        status === 413
          ? "payload_too_large"
          : status === 415
            ? "unsupported_media_type"
            : status === 429
              ? "too_many_requests"
              : "bad_request";
      const message =
        status === 413
          ? "That was too big to send."
          : status === 415
            ? "That kind of request isn't supported."
            : "That request wasn't valid.";
      res.setHeader("x-error-code", code);
      res.status(status).json({ error: { code, message } });
      return;
    }

    log.error("unhandled error", {
      path: req.path,
      method: req.method,
      requestId: res.getHeader("x-request-id"),
      error: err instanceof Error ? err.stack ?? err.message : String(err),
    });
    res.setHeader("x-error-code", "internal_error");
    res.status(500).json({ error: { code: "internal_error", message: "Something went wrong on our side. Try again." } });
  };
}

/**
 * A fixed-window rate limiter, in memory.
 *
 * It is per-process, which is exactly right for the single-VM deployment this app targets, and it resets on a
 * restart, which is the right behaviour for a limiter whose job is to blunt a burst rather than to count forever.
 *
 * The key is the client's address bucket (see `rateLimitBucket`: an IPv6 /64 is ONE bucket, not 2^64 of them), so
 * the limit is per person rather than per route. The map is bounded: when it is full, expired entries go first and
 * then the oldest entries are evicted. It never refuses a client just because the map is full — that would turn a
 * memory guard into a denial of service.
 *
 * `countStatuses` makes the limiter count only certain outcomes. The sign-in limiter uses [401]: a person who
 * signs in and out twenty times is not locked out, while somebody guessing passwords still hits the wall.
 */
export function rateLimiter(options: {
  windowMs: number;
  max: number;
  key?: (req: Request) => string;
  message?: string;
  trustedProxies?: (ip: string) => boolean;
  /** Only count a request when its response status is one of these (default: count every request). */
  countStatuses?: number[];
}) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  const MAX_KEYS = 5000;
  const countStatuses = options.countStatuses;
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = options.key ? options.key(req) : rateLimitBucket(clientIp(req, options.trustedProxies));

    // Bound the map. Expired entries first; then, only if it is somehow still full, the oldest entries.
    if (hits.size >= MAX_KEYS) {
      for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
      while (hits.size >= MAX_KEYS) {
        const oldest = hits.keys().next();
        if (oldest.done) break;
        hits.delete(oldest.value);
      }
    }

    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) entry = { count: 0, resetAt: now + options.windowMs };
    hits.set(key, entry); // re-inserting moves the key to the end: the eviction order stays fair

    const refuse = () => {
      const retryAfter = Math.max(1, Math.ceil((entry!.resetAt - Date.now()) / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      res.setHeader("x-error-code", "too_many_requests");
      res.status(429).json({
        error: { code: "too_many_requests", message: options.message ?? "Too many attempts. Wait a moment and try again." },
      });
    };

    if (countStatuses) {
      // The count is decided when the response ends, so a successful sign-in costs nothing.
      if (entry.count >= options.max) {
        refuse();
        return;
      }
      let settled = false;
      const count = () => {
        if (settled) return;
        settled = true;
        if (countStatuses.includes(res.statusCode)) entry!.count += 1;
      };
      res.on("finish", count);
      res.on("close", count);
      next();
      return;
    }

    entry.count += 1;
    if (entry.count > options.max) {
      refuse();
      return;
    }
    next();
  };
}

/**
 * Give every request an id, and put it in the response.
 *
 * It is what makes a report from a person ("it failed at 14:32") findable in the log.
 */
export function requestId() {
  return (req: Request, res: Response, next: NextFunction) => {
    const id = randomUUID();
    res.setHeader("X-Request-Id", id);
    next();
  };
}

/**
 * Log one line per request.
 *
 * The API is otherwise invisible in the log, and an API you cannot see is an API you cannot debug. The static
 * files are not logged: they are served by nginx in production, and in development they are noise.
 *
 * `x-error-code` is set by the error middleware (and by the limiter) for every failed request, so the log line
 * carries the machine-readable reason, not just the status. Query strings are deliberately never logged.
 */
export function requestLogger(options: { skip?: (req: Request) => boolean } = {}) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (options.skip?.(req)) {
      next();
      return;
    }
    const startedAt = process.hrtime.bigint();
    res.on("finish", () => {
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const line = {
        method: req.method,
        path: req.originalUrl.split("?")[0],
        status: res.statusCode,
        ms: Math.round(ms * 10) / 10,
        requestId: res.getHeader("x-request-id"),
        ...(res.statusCode >= 400 ? { error: res.getHeader("x-error-code") } : {}),
      };
      if (res.statusCode >= 500) log.error("request", line);
      else if (res.statusCode >= 400) log.warn("request", line);
      else log.info("request", line);
    });
    next();
  };
}

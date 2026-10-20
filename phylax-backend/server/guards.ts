import { requestLocks } from "./requestLocks.js";
import type { RequestHandler } from "express";
import { acquireLockConnection } from "./db.js";
import { HttpError } from "./http.js";
import { log } from "./log.js";

/**
 * Serialize account writes with outbound rendering/delivery. A busy send is a retryable conflict.
 *
 * The guard is released when the RESPONSE closes, not when it finishes. `finish` fires when the response has been
 * handed to the OS; it does not fire at all when the client disconnects mid-request, which used to leak the
 * advisory lock (and the pool connection behind it) until the process restarted — after a handful of abandoned
 * writes the lock pool was exhausted and every mutation returned 503. `close` fires in both cases.
 *
 * Two distinct failures are now told apart (B24):
 *
 *   - the lock pool has no free connection within `DATABASE_LOCK_ACQUIRE_TIMEOUT_MS` — ordinary contention. The
 *     answer is a RETRYABLE 409 `lock_pool_busy` with `Retry-After`, because a 503 reads like a database outage
 *     and trips outage alerting for something that is not one.
 *   - the connection attempt itself failed (the database is unreachable) — a genuine 503.
 *
 * Waiting for a connection is bounded, and how long it took (and how often it timed out) is recorded, so
 * contention is a number on the ops health endpoint instead of a mystery hang.
 */
export function accountWriteGuard(): RequestHandler {
  return async (req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method) || !req.account) { next(); return; }
    const timeoutMs = req.ctx.config.DATABASE_LOCK_ACQUIRE_TIMEOUT_MS;
    const acquired = await acquireLockConnection(timeoutMs);
    if (!acquired.ok) {
      if (acquired.reason === "timeout") {
        log.warn("account write guard: lock pool saturated", {
          code: "lock_pool_busy", waitedMs: acquired.waitedMs, timeoutMs, accountId: req.account.id,
        });
        res.setHeader("Retry-After", "2");
        next(new HttpError(409, "lock_pool_busy", "The service is busy. Retry in a moment."));
        return;
      }
      log.error("account write guard: could not reach the lock pool", {
        code: "lock_pool_unreachable", waitedMs: acquired.waitedMs, error: acquired.error,
      });
      next(new HttpError(503, "unavailable", "Storage is temporarily unavailable."));
      return;
    }
    const c = acquired.client;
    if (acquired.waitedMs > 250) {
      // Not an error, but a slow acquisition is the early signal that the pool is undersized for the load.
      log.info("account write guard: slow lock acquisition", { code: "lock_pool_slow", waitedMs: acquired.waitedMs, accountId: req.account.id });
    }
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      requestLocks.delete(req);
      try {
        await c.query("SELECT pg_advisory_unlock(hashtextextended($1,123))", [req.account!.id]);
        c.release();
      } catch { c.release(true); }
    };
    try {
      const result = await c.query<{ ok: boolean }>("SELECT pg_try_advisory_lock(hashtextextended($1,123)) AS ok", [req.account.id]);
      if (!result.rows[0]?.ok) {
        c.release();
        res.setHeader("Retry-After", "2");
        next(new HttpError(409, "account_busy", "An alert or another change is in progress. Retry shortly."));
        return;
      }
      requestLocks.set(req, release);
      // `close` covers normal completion and client aborts; `finish` is the fast path when it fires first.
      res.on("close", () => { void release().catch(() => {}); });
      res.once("finish", () => { void release().catch(() => {}); });
      next();
    } catch (error) { await release(); next(error); }
  };
}

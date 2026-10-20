import type { NextFunction, Request, Response } from "express";
import type { Config } from "./config.js";
import { resolveSession, sessionIdFromRequest, touchSession, type Account, type Session, type SessionOptions } from "./auth/sessions.js";
import { isDbEnabled } from "./db.js";
import { HttpError } from "./http.js";

/**
 * The request context, and the middleware that fills it in.
 *
 * Every request carries the configuration and, once it is known, the signed-in account. The account is looked up
 * once per request and attached to it, so the routes do not each have to read the cookie.
 */

export type AppContext = {
  config: Config;
  cookieOpts: SessionOptions;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /**
       * The request context: the configuration and the cookie options.
       *
       * It is called `ctx` and not `app` because Express already uses `req.app` for the application instance.
       */
      ctx: AppContext;
      account?: Account;
      session?: Session;
    }
  }
}

/** Attach the context to every request. */
export function contextMiddleware(ctx: AppContext) {
  return (req: Request, _res: Response, next: NextFunction) => {
    req.ctx = ctx;
    next();
  };
}

/**
 * Look up the session, if there is one.
 *
 * This never fails a request: a request without a session is simply an anonymous request. The routes that need a
 * person use `requireAuth`.
 */
export function sessionMiddleware() {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (!req.path.startsWith("/api/") || req.path === "/api/health") return next();
      const id = sessionIdFromRequest(req);
      if (!id || !isDbEnabled()) return next();
      const found = await resolveSession(id, { idleTimeoutMinutes: req.ctx.config.SESSION_IDLE_TIMEOUT_MINUTES });
      if (found) {
        req.account = found.account;
        req.session = found.session;
        // Touch it in the background: a failed touch must not delay the response.
        void touchSession(found.session.id);
      }
    } catch {
      return next(new HttpError(503, "unavailable", "Session storage is temporarily unavailable. Try again shortly."));
    }
    next();
  };
}

/** Require a signed-in account. */
export function requireAuth() {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.account) {
      next(new HttpError(401, "not_signed_in", "Sign in to continue."));
      return;
    }
    // A suspension takes effect for sessions that are ALREADY signed in, not only for new sign-ins. The operator's
    // suspend call also destroys every session, but this closes the race (a request in flight at the moment of
    // suspension) and makes the answer an explicit 403 rather than a mysterious 401.
    if (req.account.suspended_at) {
      next(new HttpError(403, "account_suspended", "This account is suspended. Contact support if you believe this is a mistake."));
      return;
    }
    next();
  };
}

/** Require a recent sign-in for irreversible or identity-changing operations. */
export function requireRecentAuth() {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.session || Date.now() - (req.session.reauthenticated_at?.getTime() ?? 0) > 10 * 60 * 1000) return next(new HttpError(403, "reauthentication_required", "Reauthenticate from Account & alerts before changing account security."));
    next();
  };
}

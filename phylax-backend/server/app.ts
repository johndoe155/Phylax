import { webhookRoutes } from "./routes/webhooks.js";
import { unsubscribeRoutes } from "./routes/unsubscribe.js";
import { LEGAL_VERSION } from "@shared/legal";
import express, { type Express, type Request, type Response } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { contextMiddleware, sessionMiddleware, type AppContext } from "./middleware.js";
import { errorMiddleware, asyncHandler, notFound, rateLimiter, requestId, requestLogger } from "./http.js";
import { csrfMiddleware, requireCsrf, requireSameOrigin } from "./csrf.js";
import { isDbEnabled, query } from "./db.js";
import { validateBody } from "./validation.js";
import { trustedProxyCheck, configureCloudflareRanges } from "./net.js";
import { authRoutes } from "./routes/auth.js";
import { accountRoutes } from "./routes/account.js";
import { shiftRoutes } from "./routes/shifts.js";
import { healthRoutes } from "./routes/health.js";
import { sessionCookieOptions } from "./auth/sessions.js";
import { log } from "./log.js";
import type { Config } from "./config.js";
import type { Scheduler } from "./scheduler.js";

/**
 * The Express application.
 *
 * ONE process serves everything: the API and the built frontend. That is the whole point of the deployment — the
 * browser talks to the same origin it loaded the page from, so the session cookie is a first-party cookie, the
 * passkey's origin check has one value, and there is no CORS to get wrong.
 *
 * The order of the middleware matters, and it is the order below:
 *
 *   1. security headers
 *   2. body parsing (small limit; this API never receives a file)
 *   3. the request context (configuration, cookie options)
 *   4. the session lookup
 *   5. the API routes, under /api
 *   6. the static files
 *   7. the single-page fallback, which must NOT swallow the API
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Where the built frontend lives. */
export function staticPath(_config: Config): string {
  const candidates = [
    // production: dist/index.js sits next to dist/public
    path.resolve(__dirname, "public"),
    // development: the source tree
    path.resolve(__dirname, "..", "dist", "public"),
    path.resolve(process.cwd(), "dist", "public"),
  ];
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, "index.html"))) return candidate;
  }
  return candidates[0]!;
}

export type AppOptions = {
  config: Config;
  scheduler?: Scheduler;
  startedAt?: number;
};

export function createApp(opts: AppOptions): Express {
  const { config } = opts;
  // Refresh the proxy trust list in the background. The bootstrap list is available synchronously; the first
  // successful fetch atomically replaces it, and a network failure retains the compiled/last-good list.
  if (config.TRUST_PROXY) configureCloudflareRanges(config);
  const app = express();
  const startedAt = opts.startedAt ?? Date.now();
  const root = staticPath(config);
  const hasBuild = existsSync(path.join(root, "index.html"));
  const inlineScriptHashes = hasBuild ? [...readFileSync(path.join(root, "index.html"), "utf8").matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .filter(match => match[1].trim()).map(match => `'sha256-${createHash("sha256").update(match[1]).digest("base64")}'`).join(" ") : "";

  // Behind Cloudflare, the client IP and the protocol come from the proxy. Express needs to be told to believe
  // them, or the rate limiter would count every request as coming from the proxy.
  //
  // `trust proxy` is set to a FUNCTION, not to a number. A number means "the last N hops are trusted", which
  // is only right if nothing can reach the app except the proxy. A function is asked about the actual socket
  // address, so a request that arrived from somewhere else is not believed, however many headers it carries.
  if (config.TRUST_PROXY) app.set("trust proxy", trustedProxyCheck);
  app.disable("x-powered-by");
  app.set("etag", "strong");

  // ---- 1. security headers ---------------------------------------------------------------------
  app.use((_req: Request, res: Response, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=(), interest-cohort=()");
    // Google Fonts and (when configured) Cloudflare Turnstile are the only cross-origin browser resources.
    // Turnstile is absent by default; its script/frame/connect origins are opened only when both secret and public
    // site keys are configured, so a deployment without the widget keeps the narrower policy.
    const turnstileOrigins = config.TURNSTILE_SECRET_KEY?.trim() && config.TURNSTILE_SITE_KEY?.trim()
      ? " https://challenges.cloudflare.com"
      : "";
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        `script-src 'self' ${inlineScriptHashes}${turnstileOrigins}`,
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com data:",
        "img-src 'self' data: blob:",
        `connect-src 'self'${turnstileOrigins}`,
        ...(turnstileOrigins ? [`frame-src${turnstileOrigins}`] : []),
        "frame-ancestors 'self'", 
        "base-uri 'self'",
        "form-action 'self'",
      ].join("; "),
    );
    if (config.isProd) {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    next();
  });

  // ---- 2. the request id, and the log line ----------------------------------------------------
  //
  // The id goes in the response and in the log line, so a person reporting a failure can be matched to the
  // exact request. The logger skips the static files, which are served by nginx in production and are noise
  // in development.
  app.use(requestId());
  app.use(requestLogger({ skip: (req) => !req.path.startsWith("/api/") }));

  // ---- 3. bodies ------------------------------------------------------------------------------
  app.use("/api/webhooks", webhookRoutes(config));
  // The one-click unsubscribe (RFC 8058) is mounted with the webhooks, for the same reason: it is called by
  // somebody who is not the signed-in browser. Gmail's and Yahoo's unsubscribe buttons POST from the provider's
  // own infrastructure with no cookies, no Origin and no CSRF token, and a person clicking the link in the message
  // body may not be signed in at all. Making opt-out conditional on authentication would be the same compliance
  // failure as making account deletion conditional on accepting new terms — so this route sits above the session,
  // CSRF, same-origin and database-guard middleware, and its authority is the signed token in its path instead.
  app.use("/api/unsubscribe", unsubscribeRoutes(config));
  app.use(express.json({ limit: "64kb" }));
  app.use(express.urlencoded({ extended: false, limit: "64kb" }));

  // ---- 4. the request context ------------------------------------------------------------------
  const ctx: AppContext = {
    config,
    cookieOpts: sessionCookieOptions({
      secure: config.COOKIE_SECURE,
      domain: config.COOKIE_DOMAIN,
      sameSite: config.COOKIE_SAME_SITE,
      ttlDays: config.SESSION_TTL_DAYS,
    }),
  };
  app.use(contextMiddleware(ctx));

  // ---- 5. the session --------------------------------------------------------------------------
  app.use("/api",rateLimiter({windowMs:60000,max:300}));
  app.use(sessionMiddleware());

  // ---- 6. cross-site request forgery -----------------------------------------------------------
  //
  // The session cookie is SameSite, which is the main defence. This is the second one: a token in a cookie the
  // browser can read, echoed back in a header, checked on every request that changes something. It does not
  // depend on the cookie's settings, so it still works if SameSite is ever set to `none`.
  app.use("/api",
    csrfMiddleware({
      secure: config.COOKIE_SECURE,
      sameSite: config.COOKIE_SAME_SITE === "none" ? "none" : config.COOKIE_SAME_SITE,
      secret: config.SESSION_SECRET,
    }),
  );
  app.use((req, res, next) => {
    if (req.path === "/api/auth/oauth/callback") return next();
    return requireSameOrigin([new URL(config.APP_URL).origin])(req, res, next);
  });

  app.use("/api", validateBody);

  // ---- 7. the API ------------------------------------------------------------------------------
  // The health and operations routes live under /api too, and are mounted first so that /api/health and
  // /api/ops/* are answered before the catch-all below claims anything under /api.
  app.use("/api", (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  // The legal posture, in public.
  //
  // It answers three questions a person is entitled to ask before they hand over their schedule: who runs this,
  // how do I reach them, and whose law governs. `approved` is the one the release gate reads: a deployment whose
  // documents have not been approved by the operator is a pre-launch draft, and the browser says so on the page.
  // `currentVersion` and `approvedVersion` let the release gate confirm the code is running the version that was
  // actually signed off, rather than trusting that they happen to match.
  app.get("/api/legal", (_req,res)=>res.json({
    version:LEGAL_VERSION,
    currentVersion:LEGAL_VERSION,
    approvedVersion:config.LEGAL_APPROVED_VERSION??null,
    operator:config.SERVICE_OPERATOR??null,
    contact:config.SERVICE_CONTACT_EMAIL??null,
    jurisdiction:config.SERVICE_JURISDICTION??null,
    approved:config.LEGAL_APPROVED_VERSION===LEGAL_VERSION,
  }));
  // The account timezone picker must offer only names that BOTH this Node/ICU build and this PostgreSQL accept.
  // `Intl.supportedValuesOf("timeZone")` alone included ICU aliases that PostgreSQL's AT TIME ZONE throws on
  // (e.g. Europe/Kiev); those could stall the scheduler. This route is public metadata, not personalized data.
  app.get("/api/meta/timezones", asyncHandler(async (_req, res) => {
    if (!isDbEnabled()) return res.status(503).json({ error: { code: "unavailable", message: "Timezone data is temporarily unavailable." } });
    const rows = await query<{ name: string }>("SELECT name FROM valid_timezones ORDER BY name");
    const timezones = rows.map(({ name }) => name).filter((name) => {
      try { new Intl.DateTimeFormat("en-US", { timeZone: name }); return true; }
      catch { return false; }
    });
    res.json({ timezones });
  }));
  app.use("/api", healthRoutes({ scheduler: opts.scheduler, startedAt }));

  // The sign-in routes are mounted before the CSRF check, because the first request a person makes has no
  // token yet: the browser has to have been given the cookie. The check is applied to the routes below.
  app.use("/api", (req, res, next) => {
    if (!isDbEnabled() && !["/auth/session", "/auth/providers"].includes(req.path)) return res.status(503).json({ error: { code: "unavailable", message: "Database is not configured." } });
    next();
  });
  app.use("/api/auth", (req, res, next) => {
    if (req.path === "/oauth/callback") return next();
    return requireCsrf()(req, res, next);
  }, authRoutes());

  // Everything that changes something has to carry the token. The read-only routes do not, so a link or a
  // prefetch is not broken by it.
  app.use("/api", requireCsrf());
  app.use("/api/account", accountRoutes());
  app.use("/api/shifts", shiftRoutes());

  // Anything else under /api is a mistake, and is answered as JSON rather than as the page.
  app.use(
    "/api",
    asyncHandler(async (req: Request, _res: Response) => {
      throw notFound("not_found", `There is no ${req.method} ${req.path}.`);
    }),
  );

  // ---- 8. the frontend -------------------------------------------------------------------------
  if (hasBuild) {
    // Hashed assets can be cached for a year; index.html must never be, or a deploy would not reach anybody.
    app.use(
      express.static(root, {
        index: false,
        setHeaders(res, filePath) {
          if (path.basename(filePath) === "index.html") { res.setHeader("Cache-Control", "no-cache"); }
          else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          } else {
            res.setHeader("Cache-Control", "public, max-age=3600");
          }
        },
      }),
    );
  } else {
    log.warn("no built frontend found", { lookedIn: root });
  }

  // ---- 9. the single-page fallback --------------------------------------------------------------
  // The client-side router owns every path that is not an API path and not a file, so the app must answer them
  // with index.html. This is deliberately AFTER the API routes: an /api path that no route claimed must be a
  // JSON 404, not the HTML page.
  app.get("*", (req: Request, res: Response, next) => {
    if (req.path.startsWith("/api/")) {
      next(notFound("not_found", `There is no ${req.method} ${req.path}.`));
      return;
    }
    if (req.path.startsWith("/assets/") || path.extname(req.path)) { next(notFound("not_found", "File not found.")); return; }
    if (!hasBuild) {
      next(notFound("not_built", "The site has not been built yet. Run `npm run build`."));
      return;
    }
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(path.join(root, "index.html"), (err) => {
      if (err) next(err);
    });
  });

  // ---- errors -----------------------------------------------------------------------------------
  app.use(errorMiddleware());

  return app;
}

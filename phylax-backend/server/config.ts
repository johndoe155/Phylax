import { z } from "zod";
import { accessSync, constants as fsConstants } from "node:fs";

/**
 * Every environment variable the server reads, parsed once at start-up.
 *
 * The rule here is: fail loudly and early. A server that boots with a half-configured environment and then fails
 * on the first request is far harder to diagnose than one that refuses to start with a list of what is missing.
 *
 * Development is the one exception: `DATABASE_URL` may be absent, which puts the API in "local mode" (the routes
 * that need the database answer 503 and the browser falls back to its local storage). In production it is required.
 */

/** A comma-separated list, turned into a trimmed, non-empty array. */
const csv = () =>
  z
    .string()
    .optional()
    .transform((v) =>
      (v ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );

/**
 * A boolean, written the way a shell writes one.
 *
 * Only "1", "true", "yes" and "on" are true. Everything else is false, including a typo, and including an
 * empty value — so `COOKIE_SECURE=` in a .env file means "off", not "the default". A variable that is not in
 * the environment at all gets the default.
 */
const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined) return fallback;
      return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
    });

const int = (fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? fallback : Number(v)))
    .pipe(z.number().int().min(min).max(max));

const schema = z.object({
  SERVICE_OPERATOR: z.string().optional(),
  SERVICE_CONTACT_EMAIL: z.string().email().optional(),
  SERVICE_JURISDICTION: z.string().optional(),
  LEGAL_APPROVED_VERSION: z.string().optional(),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: int(3000, 1, 65535),
  HOST: z.string().default("0.0.0.0"),

  // ---- database -------------------------------------------------------------------------------
  DATABASE_URL: z.string().optional(),
  /**
   * Optional, strictly separate DSN used only by explicit migration commands (`--migrate-only` / `pnpm migrate`).
   *
   * The service environment MUST NOT contain this credential. Production migration runners load it from a root-only
   * `/etc/phylax/migrator.env`; the long-running app connects with DATABASE_URL (DML only) and starts with
   * `--no-migrate`. In production, `migrate()` refuses to run unless this distinct DSN is present.
   */
  DATABASE_MIGRATION_URL: z.string().optional(),
  DATABASE_POOL_MAX: int(10, 1, 100),
  /**
   * The size of the SEPARATE advisory-lock pool.
   *
   * Advisory locks are session-scoped in PostgreSQL, so a connection that holds one cannot hand it to anybody
   * else: the scheduler's leadership lock, each dispatch worker's account guard and each account-mutating HTTP
   * request all hold a connection for as long as they hold the lock. This pool therefore has to be sized for the
   * sum of them, not for "a few short statements". The number of scheduler dispatch workers is derived from it
   * (see db.ts `dispatchWorkerBudget`), so the two can never be configured into starving each other.
   */
  DATABASE_LOCK_POOL_MAX: int(16, 4, 100),
  /**
   * How long an account-write guard waits for a lock-pool connection before giving up.
   *
   * `pg` queues `connect()` indefinitely when the pool is saturated, so without a bound a burst of writes would
   * pile up waiting behind each other and look like a hang. On timeout the guard answers a RETRYABLE 409
   * (`lock_pool_busy`) with a `Retry-After` header — not an opaque 503, which reads like a database outage and
   * trips outage alerting for what is ordinary contention. A real connection failure (the database is down) still
   * answers 503.
   */
  DATABASE_LOCK_ACQUIRE_TIMEOUT_MS: int(4000, 100, 60000),
  DATABASE_SSL: bool(false),
  /** PEM file for a private database CA (a managed database with its own authority). TLS is still verified. */
  DATABASE_CA_CERT: z.string().optional(),
  DATABASE_STATEMENT_TIMEOUT_MS: int(15000, 1000),
  /**
   * The key the pre-migration backup receipt is HMAC'd with.
   *
   * The receipt has to be readable by the service user (it runs the boot-time migration gate) and it carries a
   * digest of DATABASE_URL. A bare sha256 of a low-entropy database password in a world-readable file is a
   * brute-force target, so in production the digest is an HMAC under this key and the key is REQUIRED. The same
   * value must be in the app environment and in the root-only backup environment; deploy/db-hash.mjs is the one
   * derivation and `npm test` pins it against server/db.ts.
   */
  DATABASE_HASH_KEY: z.string().optional(),
  /**
   * The key the RECIPIENT identifiers are HMAC'd with (delivery suppressions, per-recipient budgets).
   *
   * This used to be SESSION_SECRET, which made a secret rotation a silent data-loss event: `delivery_suppressions`
   * rows are keyed by the hash, so a rebuilt machine with a new SESSION_SECRET stops matching every existing
   * suppression and starts texting people who replied STOP. Decoupling it means the session secret can be rotated
   * freely, and this key can be rotated deliberately with `IDENTIFIER_HASH_PREVIOUS_KEYS` covering the transition.
   * Unset falls back to SESSION_SECRET, so an existing deployment keeps matching its stored hashes.
   */
  IDENTIFIER_HASH_KEY: z.string().optional(),
  /** Comma-separated earlier identifier keys, still honoured for LOOKUPS during a rotation. */
  IDENTIFIER_HASH_PREVIOUS_KEYS: csv(),

  // ---- sessions & cookies ---------------------------------------------------------------------
  /** HMAC key for signed tokens (sessions, magic links, pending sign-ups). Must be long and random. */
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters").default("dev-only-insecure-secret-change-me-0123456789"),
  SESSION_TTL_DAYS: int(365, 1, 3650),
  /**
   * Idle session timeout, in minutes. 0 means "no idle timeout" (the absolute TTL still applies).
   *
   * Sessions were fixed at up to 365 days with no inactivity bound, so a cookie lifted from a machine stayed
   * valid for a year whether or not anybody was using it. `last_seen_at` is already maintained (throttled to one
   * write per minute per session), so enforcing this costs no extra queries.
   */
  SESSION_IDLE_TIMEOUT_MINUTES: int(0, 0, 525600),
  COOKIE_SECURE: bool(true),
  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SAME_SITE: z.enum(["lax", "strict", "none"]).default("lax"),

  // ---- public origin --------------------------------------------------------------------------
  /** The site as the public sees it, e.g. https://phylax.app. Used for OAuth redirects and links in emails. */
  APP_URL: z.string().url().default("http://localhost:3000"),

  // ---- webauthn / passkeys ---------------------------------------------------------------------
  /** The domain the passkey is bound to. Usually the registrable domain (phylax.app, not app.phylax.app). */
  RP_ID: z.string().optional(),
  RP_NAME: z.string().default("Phylax"),
  RP_ORIGIN: z.string().optional(),

  // ---- oauth providers -------------------------------------------------------------------------
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  APPLE_CLIENT_ID: z.string().optional(),
  APPLE_CLIENT_SECRET: z.string().optional(),
  APPLE_TEAM_ID: z.string().optional(),
  APPLE_KEY_ID: z.string().optional(),
  /** The Apple .p8 private key, with literal "\n" for newlines (as it comes out of a secret store). */
  APPLE_PRIVATE_KEY: z.string().optional(),

  // ---- mail ------------------------------------------------------------------------------------
  MAIL_PROVIDER: z.enum(["disabled", "log", "resend", "postmark", "smtp"]).default("log"),
  /**
   * The address messages come from. Validated, not just defaulted.
   *
   * It was accepted as any string, and `deploy/oci/provision.sh` wrote `no-reply@phylax.example.com` into the
   * generated environment — so a provisioned host booted cleanly and then failed at runtime on the first send,
   * because no provider will relay mail from an example domain it does not own. The shape is checked here and the
   * example-domain case is refused in production.
   */
  MAIL_FROM: z.string().default("Phylax <no-reply@phylax.app>"),
  MAIL_REPLY_TO: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  POSTMARK_API_KEY: z.string().optional(),
  POSTMARK_MESSAGE_STREAM: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: int(587, 1, 65535),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_SECURE: bool(false),
  /**
   * Require an upgraded TLS session before any mail is handed to the SMTP relay.
   *
   * Without it, nodemailer on port 587 uses opportunistic STARTTLS: a relay (or anything on the path) that does
   * not advertise STARTTLS gets the message in clear text, and nothing says so. Production defaults to requiring
   * it; set false only for a relay on a trusted private network that genuinely has no TLS.
   */
  SMTP_REQUIRE_TLS: bool(true),
  /**
   * How delivery evidence is produced for the release gate.
   *
   * `callback` requires an authenticated provider webhook (Resend's Svix signature, Postmark's token). `probe`
   * accepts an operator-confirmed `/api/ops/probe` delivery instead. SMTP was effectively unusable in production
   * because the gate demanded `SMTP_WEBHOOK_TOKEN` — a callback endpoint that no SMTP relay provides — so a
   * perfectly good relay could never be accepted. The token is now optional and the evidence mode says which
   * proof the deployment actually has.
   */
  MAIL_DELIVERY_EVIDENCE: z.enum(["callback", "probe"]).default("callback"),

  // ---- sms -------------------------------------------------------------------------------------
  SMS_PROVIDER: z.enum(["disabled", "log", "twilio", "webhook"]).default("log"),
  SMS_FROM: z.string().optional(),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  SMS_WEBHOOK_URL: z.string().optional(),

  SMS_ALLOWED_PREFIXES: csv(),
  SMS_DAILY_LIMIT: int(100, 1, 100000),
  SMS_RECIPIENT_DAILY_LIMIT: int(10, 1, 100),
  MAIL_DAILY_LIMIT: int(1000, 1, 1000000),
  // Transactional traffic (sign-in links, password resets, security notices, verification codes) has its OWN
  // budgets. It used to share the alert budgets, so a burst of reminders — or one abusive account — could stop
  // people signing in. These are deliberately generous for a single person and bounded in aggregate.
  SMS_TRANSACTIONAL_RECIPIENT_DAILY_LIMIT: int(20, 1, 1000),
  MAIL_TRANSACTIONAL_RECIPIENT_DAILY_LIMIT: int(10, 1, 1000),
  SMS_TRANSACTIONAL_DAILY_LIMIT: int(1000, 1, 100000),
  MAIL_TRANSACTIONAL_DAILY_LIMIT: int(5000, 1, 1000000),
  /**
   * Per-IP ceiling on phone-verification SMS, per day.
   *
   * The account-scoped budget (3/day) was the only per-actor limit, and a passkey-only sign-up needs no email —
   * so a fresh, legitimately-authenticated account could spend 3 SMS a day to ANY allowed-prefix number, and the
   * only backstop was the 1,000/day global transactional cap, which an attacker could also use to deny real
   * phone verification to everybody. This is the missing per-source budget.
   */
  SMS_VERIFICATION_IP_DAILY_LIMIT: int(10, 1, 1000),
  /**
   * Minimum account age before SMS may be requested, in hours. 0 disables the check.
   *
   * SMS pumping is profitable within minutes of an account being created, and the cost is real money. An account
   * that has existed for less than this long — and has not verified an email — cannot request a verification code
   * at all, which removes the cheap bulk-registration attack without touching a real person's second day.
   */
  SMS_MIN_ACCOUNT_AGE_HOURS: int(0, 0, 8760),
  SMS_WEBHOOK_TOKEN: z.string().optional(),
  RESEND_WEBHOOK_SECRET: z.string().optional(),
  POSTMARK_WEBHOOK_TOKEN: z.string().optional(),
  SMTP_WEBHOOK_TOKEN: z.string().optional(),

  // ---- abuse controls ---------------------------------------------------------------------------
  /**
   * Cloudflare Turnstile, for the anonymous endpoints that cost money or unlock an enumeration oracle.
   *
   * Secret unset = the check is skipped (development, and any deployment that fronts the origin differently).
   * Secret set = every anonymous auth POST that can trigger an outbound message must carry a valid token.
   * `TURNSTILE_ENFORCE` decides whether a verification FAILURE refuses the request or only logs it, so the widget
   * can be rolled out in observe mode before it starts rejecting real people.
   */
  TURNSTILE_SECRET_KEY: z.string().optional(),
  /** Public site key, published by /api/auth/providers so the client renders the widget only when it is needed. */
  TURNSTILE_SITE_KEY: z.string().optional(),
  TURNSTILE_ENFORCE: bool(true),
  /** Reject a password that appears in a public breach corpus. Off by default: it is a third-party call. */
  PASSWORD_BREACH_CHECK: bool(false),
  /** Fail-open on provider error by design; this bounds how long a sign-up waits for the answer. */
  PASSWORD_BREACH_TIMEOUT_MS: int(3000, 250, 10000),
  /**
   * The k-anonymity range endpoint. Defaults to Have I Been Pwned; point it at a self-hosted mirror or an egress
   * proxy when the box may not call the public internet. Only the first 5 hex characters of the SHA-1 are ever
   * sent, so the provider (or anyone on the path) cannot recover the password.
   */
  PASSWORD_BREACH_URL: z.string().url().default("https://api.pwnedpasswords.com/range/"),
  /**
   * Signing key for one-click unsubscribe tokens.
   *
   * Not SESSION_SECRET: rotating the session secret is a routine response to a suspected leak, and it would
   * otherwise invalidate every unsubscribe link already sitting in an inbox — the person clicks it, is told it is
   * invalid, and marks the next message as spam instead. Defaults to IDENTIFIER_HASH_KEY, which is already
   * required to survive a rebuild for suppressions to keep matching.
   */
  UNSUBSCRIBE_TOKEN_KEY: z.string().optional(),

  // ---- scheduler --------------------------------------------------------------------------------
  SCHEDULER_ENABLED: bool(true),
  SCHEDULER_BATCH_SIZE: int(80, 1, 80),
  SCHEDULER_ACCOUNT_BATCH: int(100, 1, 500),
  SCHEDULER_INTERVAL_MS: int(60000, 5000),
  /** How long before a cancellation window closes the reminder is sent, in minutes. */
  REMINDER_LEAD_MINUTES: int(180, 0, 10080),

  // ---- misc ------------------------------------------------------------------------------------
  TRUST_PROXY: bool(true),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),
  /** Shared secret for the operational endpoints (e.g. forcing a backup over HTTP). */
  OPS_TOKEN: z.string().optional(),
  /** Renders the "no database" mode instead of 503s. Only for the static preview. */
  ALLOW_DB_LESS: bool(false),
  /**
   * Refresh Cloudflare's published IP ranges at runtime instead of trusting the compiled-in list.
   *
   * The compiled list in server/net.ts drifts: Cloudflare adds and withdraws ranges, and a stale list either
   * stops believing real client addresses or — worse — keeps believing a range that is no longer theirs. When
   * this is on, the list is fetched, cached and validated; the compiled list remains the fallback so a failed
   * fetch can never lock the app out of its own proxy.
   */
  CLOUDFLARE_IPS_REFRESH: bool(true),
  CLOUDFLARE_IPS_URL_V4: z.string().url().default("https://www.cloudflare.com/ips-v4"),
  CLOUDFLARE_IPS_URL_V6: z.string().url().default("https://www.cloudflare.com/ips-v6"),
  CLOUDFLARE_IPS_REFRESH_MS: int(86400000, 3600000, 604800000),
  /**
   * Require Cloudflare Authenticated Origin Pulls (mTLS) at the proxy.
   *
   * Trusting only Cloudflare's IP ranges is not enough on its own: those ranges are shared by EVERY Cloudflare
   * tenant, so any other customer of Cloudflare can reach the origin and send a forged CF-Connecting-IP. With AOP
   * the origin additionally demands a client certificate signed by Cloudflare's origin CA. This flag makes the
   * app refuse to start in production unless the operator has confirmed nginx is configured for it, because the
   * app cannot verify nginx's configuration from inside.
   */
  REQUIRE_AUTHENTICATED_ORIGIN_PULLS: bool(false),
  /** PEM of Cloudflare's origin CA, for the operator's own reference/validation tooling. */
  CF_ORIGIN_CA_CERT: z.string().optional(),
  /** Public HTTPS origin to probe from the host monitor; defaults to APP_URL in the shell tooling. */
  MONITOR_PUBLIC_URL: z.string().url().optional(),
  MONITOR_DISK_WARN_PERCENT: int(85, 50, 99),
  MONITOR_CERT_MIN_DAYS: int(14, 1, 90),
  MONITOR_PG_MAX_CONN_PERCENT: int(80, 50, 99),
  /** Production monitor requires an external dead-man ping so host failure is visible from outside the VM. */
  REQUIRE_EXTERNAL_PING: bool(true),
});

export type Config = z.infer<typeof schema> & {
  isProd: boolean;
  /** Origins the browser may call the API from, derived from APP_URL. */
  allowedOrigins: string[];
  /** The effective WebAuthn relying-party id. */
  rpId: string;
  /** The effective WebAuthn origin. */
  rpOrigin: string;
  /** The address inside MAIL_FROM, without any display name. */
  mailFromAddress: string;
  /** The key recipient identifiers are HMAC'd with: IDENTIFIER_HASH_KEY, else SESSION_SECRET. */
  identifierHashKey: string;
  /** Earlier identifier keys still honoured for lookups, newest first. Never includes the current key. */
  identifierHashPreviousKeys: string[];
};

/**
 * A secret that is obviously a placeholder.
 *
 * `.env.example` shipped `SESSION_SECRET=CHANGE_ME_to_a_long_random_string_at_least_32_characters`, which is 56
 * characters long — so it sailed through the length rule, and the only rejection was the `dev-only-insecure`
 * prefix used by the built-in development default. A deployment that copied the example file and forgot one line
 * was running in production with a secret that is in the public repository, which means anybody could forge the
 * signed pending-signup cookie, the OAuth state and the recipient hashes.
 *
 * Length is not entropy. These are the shapes that say "a human has not been here yet".
 */
const PLACEHOLDER_SECRET =
  /(change[_-]?me|changeme|replace[_-]?me|placeholder|your[_-]?secret|your[_-]?key|xxx{3,}|todo|fixme|not[_-]?set|dummy|example[_-]?secret|secret[_-]?here|lorem|keyboard[_-]?cat|hunter2|password123)/i;

/** True when a value looks like something a template shipped rather than something an operator generated. */
export function isPlaceholderSecret(value: string): boolean {
  const v = value.trim();
  if (!v) return true;
  if (PLACEHOLDER_SECRET.test(v)) return true;
  // Low entropy: a long string of one repeated character, or fewer than 8 distinct characters, is not a secret.
  if (new Set(v.toLowerCase()).size < 8) return true;
  // Only decimal digits: an all-numeric "secret" of any realistic length is not one. `openssl rand -hex 32`
  // gives 64 hexadecimal characters and `openssl rand -base64 32` gives 44 with letters in it, so requiring 64
  // before accepting a digits-only value costs no legitimate deployment anything.
  if (/^\d+$/.test(v) && v.length < 64) return true;
  return false;
  // NOTE: a "character class diversity" rule was tried here and removed on purpose. `openssl rand -hex 32`, the
  // command this file tells operators to run, produces 64 LOWERCASE HEXADECIMAL characters — one character class.
  // Any rule that demands mixed case would reject the exact output of the documented generator, which is worse
  // than the false negative it prevents.
}

/** The RFC-5322 shape of a From header we are willing to hand to a provider: `Name <a@b>` or `a@b`. */
const MAIL_FROM_RE = /^(?:[^<>"@]{0,64}<)?[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}>?$/;

/** The bare address inside a From header. Returns "" when the header is not shaped like one. */
export function mailFromAddress(value: string): string {
  const match = value.trim().match(/<([^>]+)>$/) ?? value.trim().match(/^([^\s@]+@[^\s@]+)$/);
  return (match?.[1] ?? "").trim();
}

/**
 * Hosts that can never be a real sending domain.
 *
 * Two families: the RFC 2606 reserved TLDs (`example.com` and friends, plus `.invalid`, `.test`, `.local`), and
 * a hostname that IS one of the reserved labels on its own — `mail.localhost` is the shape a template produces
 * and no provider will relay from it either.
 */
/**
 * Whether a MAIL_FROM host is one that can never be a real sending domain.
 *
 * Three families, because a single regex kept getting one of them wrong:
 *
 *   1. the RFC 2606 example domains — `example.com`, `example.org`, `example.net`, and anything under
 *      `*.example.*`. This is the one `provision.sh` used to write into the generated environment.
 *   2. the RFC 6761 reserved special-use TLDs — `.localhost`, `.invalid`, `.local` — whether bare or as a suffix.
 *      `mail.localhost` is exactly the shape a template produces, and no provider will relay from it.
 *   3. a single-label hostname with no dot at all (`no-reply@localhost`), which is not a routable domain.
 *
 * `.test` is deliberately NOT here: it is reserved too, but it is the conventional domain for fixtures and test
 * suites, and refusing it would make this rule fire on every development and CI environment. The production gate
 * that matters is "will a provider accept this", and a single-label host or a reserved TLD is the answer to that.
 */
const EXAMPLE_HOST_RE = /(^|\.)example\.(com|org|net|local|test|invalid)$/i;
const RESERVED_TLD_RE = /(^|\.)(localhost|invalid|local)$/i;
export function isNonRoutableMailHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  if (!h) return true;
  if (!h.includes(".")) return true;
  return EXAMPLE_HOST_RE.test(h) || RESERVED_TLD_RE.test(h);
}

function derive(raw: z.infer<typeof schema>): Config {
  const appUrl = raw.APP_URL.replace(/\/+$/, "");
  let origin = appUrl;
  try {
    origin = new URL(appUrl).origin;
  } catch {
    /* APP_URL is not a URL; fall back to the raw string */
  }
  const rpOrigin = raw.RP_ORIGIN?.replace(/\/+$/, "") || origin;
  let rpId = raw.RP_ID;
  if (!rpId) {
    try {
      rpId = new URL(rpOrigin).hostname;
    } catch {
      rpId = "localhost";
    }
  }
  // The identifier key defaults to SESSION_SECRET so an existing deployment keeps matching the hashes it has
  // already stored; setting IDENTIFIER_HASH_KEY decouples suppression matching from session-secret rotation.
  const identifierHashKey = raw.IDENTIFIER_HASH_KEY?.trim() || raw.SESSION_SECRET;
  // Previous keys are for LOOKUPS only. The current key is filtered out of the list so a rotation that forgets to
  // remove the old value from the "previous" list cannot silently make it a second write key.
  const identifierHashPreviousKeys = raw.IDENTIFIER_HASH_PREVIOUS_KEYS.filter(
    (k) => k.length > 0 && k !== identifierHashKey && k !== raw.SESSION_SECRET,
  );
  return {
    ...raw,
    isProd: raw.NODE_ENV === "production",
    allowedOrigins: [origin],
    rpId,
    rpOrigin,
    mailFromAddress: mailFromAddress(raw.MAIL_FROM),
    identifierHashKey,
    identifierHashPreviousKeys,
  };
}

/**
 * Parse and validate the environment.
 *
 * @param env the environment to read (defaults to `process.env`), so tests can pass their own.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join("\n")}`);
  }
  const cfg = derive(parsed.data);
  if (cfg.COOKIE_SAME_SITE === "none" && !cfg.COOKIE_SECURE) throw new Error("SameSite=None requires COOKIE_SECURE=true.");
  if (cfg.isProd && cfg.rpOrigin !== new URL(cfg.APP_URL).origin) throw new Error("RP_ORIGIN must match APP_URL for same-origin passkeys.");
  if (cfg.isProd && !cfg.DATABASE_URL && !cfg.ALLOW_DB_LESS) {
    throw new Error("DATABASE_URL is required in production. Refusing to start without a database.");
  }
  if (cfg.isProd && cfg.SESSION_SECRET.startsWith("dev-only-insecure")) {
    throw new Error("SESSION_SECRET is still the development default. Set a real one before deploying.");
  }
  // ---- placeholder secrets ---------------------------------------------------------------------
  //
  // Length is not entropy. `.env.example` shipped a 56-character SESSION_SECRET that began "CHANGE_ME_", and a
  // length-only rule accepted it, so a deployment that copied the example and missed one line ran in production
  // with a secret that is in the public repository — which is enough to forge the signed pending-signup cookie,
  // the OAuth state and every recipient hash.
  if (cfg.isProd && isPlaceholderSecret(cfg.SESSION_SECRET)) {
    throw new Error(
      "SESSION_SECRET looks like an unreplaced placeholder. Generate a real one: openssl rand -hex 32",
    );
  }
  if (cfg.isProd && cfg.OPS_TOKEN && isPlaceholderSecret(cfg.OPS_TOKEN)) {
    throw new Error("OPS_TOKEN looks like an unreplaced placeholder. Generate a real one: openssl rand -hex 24");
  }
  if (cfg.isProd && cfg.DATABASE_HASH_KEY && isPlaceholderSecret(cfg.DATABASE_HASH_KEY)) {
    throw new Error("DATABASE_HASH_KEY looks like an unreplaced placeholder. Generate a real one: openssl rand -hex 32");
  }
  if (cfg.isProd && cfg.IDENTIFIER_HASH_KEY && isPlaceholderSecret(cfg.IDENTIFIER_HASH_KEY)) {
    throw new Error("IDENTIFIER_HASH_KEY looks like an unreplaced placeholder. Generate a real one: openssl rand -hex 32");
  }
  if (cfg.isProd && cfg.TURNSTILE_SECRET_KEY && isPlaceholderSecret(cfg.TURNSTILE_SECRET_KEY)) {
    throw new Error("TURNSTILE_SECRET_KEY looks like an unreplaced placeholder.");
  }

  // ---- the backup receipt hash key ----------------------------------------------------------------
  //
  // The receipt has to be readable by the SERVICE user (it runs the boot-time migration gate) and it carries a
  // digest of DATABASE_URL. As a bare sha256 of a low-entropy database password in a world-readable file that is a
  // brute-force target; as an HMAC under this key it is not. Production therefore requires the key.
  if (cfg.isProd && !cfg.DATABASE_HASH_KEY?.trim()) {
    throw new Error(
      "DATABASE_HASH_KEY is required in production: the pre-migration backup receipt is world-readable and its " +
        "databaseHash must be an HMAC, not a bare digest of the connection string. Generate one with " +
        "`openssl rand -hex 32` and set the SAME value in /etc/phylax/phylax.env and /etc/phylax/backup.env.",
    );
  }

  // ---- MAIL_FROM -----------------------------------------------------------------------------------
  //
  // It was accepted as any string, and provision.sh wrote `no-reply@phylax.example.com`, so a provisioned host
  // booted cleanly and then failed on the first real send: no provider relays mail from an example domain it does
  // not own. Fail at start-up, where the message is actionable, instead of at 3 a.m. inside a sign-in link.
  if (cfg.MAIL_PROVIDER !== "disabled") {
    if (!MAIL_FROM_RE.test(cfg.MAIL_FROM.trim())) {
      throw new Error(
        `MAIL_FROM is not a valid From header (it is "${cfg.MAIL_FROM}"). Use "Phylax <no-reply@your-domain>" or "no-reply@your-domain".`,
      );
    }
    const fromHost = cfg.mailFromAddress.split("@")[1] ?? "";
    if (cfg.isProd && isNonRoutableMailHost(fromHost)) {
      throw new Error(
        `MAIL_FROM uses an example/test domain (${cfg.mailFromAddress}). No provider will relay mail from a domain ` +
          `you do not own, and every send would fail at runtime. Set it to a real address on your sending domain.`,
      );
    }
  }
  if (cfg.MAIL_REPLY_TO && !MAIL_FROM_RE.test(cfg.MAIL_REPLY_TO.trim())) {
    throw new Error(`MAIL_REPLY_TO is not a valid address (it is "${cfg.MAIL_REPLY_TO}").`);
  }

  // ---- Turnstile -----------------------------------------------------------------------------------
  if (cfg.TURNSTILE_SECRET_KEY && !cfg.TURNSTILE_SITE_KEY) {
    throw new Error("TURNSTILE_SECRET_KEY is set but TURNSTILE_SITE_KEY is not: the browser would have no widget to render.");
  }
  if (cfg.isProd && !cfg.COOKIE_SECURE) {
    throw new Error("COOKIE_SECURE must be true in production (the app is served over HTTPS).");
  }
  if (cfg.isProd && !cfg.APP_URL.startsWith("https://")) {
    throw new Error(
      `APP_URL must start with https:// in production (it is ${cfg.APP_URL}). ` +
        `The session cookie is marked Secure, so it would never be sent over plain HTTP.`,
    );
  }
  if (cfg.isProd && /(^|\.)example\.(com|org|net)$/.test(new URL(cfg.APP_URL).hostname)) throw new Error("Set an actual public APP_URL, not an example domain.");
  if (cfg.isProd) {
    // The passkey's relying party id has to be the domain the site is actually served from. A subdomain cannot
    // register a passkey for its parent domain, so a mismatch here is a silent failure: the browser would
    // refuse every passkey, and the person would have no way to sign in.
    let appHost = "";
    try {
      appHost = new URL(cfg.APP_URL).hostname;
    } catch {
      throw new Error(`APP_URL is not a URL (it is ${cfg.APP_URL}).`);
    }
    const rpHost = cfg.rpId.replace(/^\*\./, "");
    if (rpHost !== appHost && !appHost.endsWith(`.${rpHost}`)) {
      throw new Error(
        `RP_ID (${cfg.rpId}) does not match APP_URL (${cfg.APP_URL}). ` +
          `The passkey's relying party id must be the domain the site is served from.`,
      );
    }
  }
  if (cfg.MAIL_PROVIDER === "resend" && !cfg.RESEND_API_KEY) {
    throw new Error("MAIL_PROVIDER=resend requires RESEND_API_KEY.");
  }
  if (cfg.MAIL_PROVIDER === "postmark" && !cfg.POSTMARK_API_KEY) {
    throw new Error("MAIL_PROVIDER=postmark requires POSTMARK_API_KEY.");
  }
  if (cfg.MAIL_PROVIDER === "smtp" && !cfg.SMTP_HOST) {
    throw new Error("MAIL_PROVIDER=smtp requires SMTP_HOST.");
  }
  if (cfg.SMS_PROVIDER === "twilio" && (!cfg.TWILIO_ACCOUNT_SID || !cfg.TWILIO_AUTH_TOKEN || !cfg.SMS_FROM)) {
    throw new Error("SMS_PROVIDER=twilio requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and SMS_FROM.");
  }
  if (cfg.SMS_PROVIDER === "webhook" && !cfg.SMS_WEBHOOK_URL) {
    throw new Error("SMS_PROVIDER=webhook requires SMS_WEBHOOK_URL.");
  }
  if (cfg.isProd && (cfg.MAIL_PROVIDER === "log" || cfg.SMS_PROVIDER === "log")) throw new Error("Production mail/SMS providers must be real or explicitly disabled, never log.");
  if (cfg.isProd && cfg.SMS_PROVIDER !== "disabled" && !cfg.SMS_ALLOWED_PREFIXES.length) throw new Error("Set SMS_ALLOWED_PREFIXES explicitly to control SMS pumping/costs.");
  if (cfg.SMS_ALLOWED_PREFIXES.some(p => !/^\+[1-9]\d{0,5}$/.test(p))) throw new Error("SMS_ALLOWED_PREFIXES must contain international prefixes, e.g. +234.");
  if (cfg.SMS_PROVIDER === "webhook" && (!cfg.SMS_WEBHOOK_TOKEN || !cfg.SMS_WEBHOOK_URL?.startsWith("https://"))) throw new Error("SMS webhook requires HTTPS and SMS_WEBHOOK_TOKEN.");
  if (cfg.isProd && cfg.MAIL_PROVIDER === "resend" && cfg.MAIL_DELIVERY_EVIDENCE === "callback" && !cfg.RESEND_WEBHOOK_SECRET) throw new Error("Resend delivery tracking requires RESEND_WEBHOOK_SECRET (or set MAIL_DELIVERY_EVIDENCE=probe).");
  if (cfg.isProd && cfg.MAIL_PROVIDER === "postmark" && cfg.MAIL_DELIVERY_EVIDENCE === "callback" && !cfg.POSTMARK_WEBHOOK_TOKEN) throw new Error("Postmark tracking requires POSTMARK_WEBHOOK_TOKEN (or set MAIL_DELIVERY_EVIDENCE=probe).");
  // SMTP used to be unusable in production: the gate demanded SMTP_WEBHOOK_TOKEN, an authenticated delivery
  // callback that NO SMTP relay provides, so a perfectly good relay could never be accepted and `release-check`
  // could never pass. The token is now what it always should have been — an optional extra for a relay that
  // genuinely posts back — and MAIL_DELIVERY_EVIDENCE=probe is the supported way to prove an SMTP deployment
  // delivers: an operator-confirmed /api/ops/probe send instead of a callback that will never arrive.
  if (cfg.isProd && cfg.MAIL_PROVIDER === "smtp" && cfg.MAIL_DELIVERY_EVIDENCE === "callback" && !cfg.SMTP_WEBHOOK_TOKEN) {
    throw new Error(
      "MAIL_PROVIDER=smtp with MAIL_DELIVERY_EVIDENCE=callback requires SMTP_WEBHOOK_TOKEN, and ordinary SMTP relays " +
        "do not post delivery callbacks. Set MAIL_DELIVERY_EVIDENCE=probe and confirm delivery with POST /api/ops/probe, " +
        "or keep the token if your relay really does call back.",
    );
  }
  if (cfg.isProd && cfg.MAIL_PROVIDER === "smtp" && !cfg.SMTP_SECURE && !cfg.SMTP_REQUIRE_TLS) {
    throw new Error(
      "MAIL_PROVIDER=smtp is configured to send in clear text (SMTP_SECURE=false and SMTP_REQUIRE_TLS=false). " +
        "Set SMTP_REQUIRE_TLS=true for STARTTLS, or SMTP_SECURE=true for implicit TLS on port 465.",
    );
  }
  if(cfg.isProd && (!cfg.OPS_TOKEN || cfg.OPS_TOKEN.length<32 || cfg.OPS_TOKEN===cfg.SESSION_SECRET)) throw new Error("Production requires an independent OPS_TOKEN of at least 32 characters.");
  if(cfg.isProd && (!cfg.SERVICE_OPERATOR?.trim() || !cfg.SERVICE_CONTACT_EMAIL || !cfg.SERVICE_JURISDICTION?.trim() || cfg.LEGAL_APPROVED_VERSION!=="2026-10-17.2")) throw new Error("Production requires SERVICE_OPERATOR, SERVICE_CONTACT_EMAIL, SERVICE_JURISDICTION and operator-approved LEGAL_APPROVED_VERSION=2026-10-17.2.");
  // An idle timeout longer than the absolute TTL is a no-op that looks like a control; say so rather than let an
  // operator believe sessions expire on inactivity when they do not.
  if (cfg.SESSION_IDLE_TIMEOUT_MINUTES > 0 && cfg.SESSION_IDLE_TIMEOUT_MINUTES > cfg.SESSION_TTL_DAYS * 24 * 60) {
    throw new Error("SESSION_IDLE_TIMEOUT_MINUTES is longer than SESSION_TTL_DAYS, so it would never fire.");
  }
  // `last_seen_at` is written by a touch that is throttled to once a minute per process, so an active user's stored
  // value can be up to ~60s stale. An idle timeout at or below that would sign out people who are actively using
  // the app. Require a floor that leaves real margin above the throttle.
  if (cfg.SESSION_IDLE_TIMEOUT_MINUTES > 0 && cfg.SESSION_IDLE_TIMEOUT_MINUTES < 2) {
    throw new Error("SESSION_IDLE_TIMEOUT_MINUTES must be at least 2 when enabled: session activity is recorded at most once a minute, so a shorter idle window would expire active sessions.");
  }
  if (cfg.isProd && cfg.DATABASE_LOCK_POOL_MAX < cfg.DATABASE_POOL_MAX) {
    // Not fatal, but the scheduler's dispatch workers and the HTTP account-write guards share this pool; sizing it
    // below the query pool makes lock starvation the normal case rather than the exceptional one.
    throw new Error("DATABASE_LOCK_POOL_MAX must be at least DATABASE_POOL_MAX: advisory locks are session-scoped, so every held lock pins a connection for the whole operation.");
  }
  if (cfg.isProd && cfg.TRUST_PROXY) {
    // Cloudflare's IP ranges are shared by every tenant, so source-IP trust alone lets any other Cloudflare customer
    // reach the origin and forge CF-Connecting-IP. Production therefore requires the second factor: nginx mTLS with
    // Cloudflare's Authenticated Origin Pull CA. Provisioning installs that CA and the nginx directives together;
    // the app refuses to start if its operator-facing confirmation or CA path is missing, rather than logging a
    // warning and running in the vulnerable mode by accident.
    if (!cfg.REQUIRE_AUTHENTICATED_ORIGIN_PULLS) {
      throw new Error("Production with TRUST_PROXY=true requires REQUIRE_AUTHENTICATED_ORIGIN_PULLS=true and nginx ssl_verify_client on.");
    }
    if (!cfg.CF_ORIGIN_CA_CERT?.trim()) {
      throw new Error("Production with Authenticated Origin Pulls requires CF_ORIGIN_CA_CERT to name the installed Cloudflare origin-pull CA file.");
    }
    try {
      accessSync(cfg.CF_ORIGIN_CA_CERT, fsConstants.R_OK);
    } catch {
      throw new Error(`CF_ORIGIN_CA_CERT is not readable: ${cfg.CF_ORIGIN_CA_CERT}`);
    }
  }
  return cfg;
}

import { securityEvent } from "../auth/securityEvents.js";
import { budget, budgetSpent } from "../notifications/control.js";
import { establishEmailOwnership } from "../auth/emailOwnership.js";
import { randomInt } from "node:crypto";
import { sendSms } from "../notifications/sms.js";
import { validateId } from "../validation.js";
import { Router, type Request, type Response } from "express";
import { asyncHandler, badRequest, clientIp, conflict, parseCookies, HttpError, rateLimitBucket, rateLimiter, unauthorized } from "../http.js";
import { isTrustedProxy } from "../net.js";
import { assertTurnstile, turnstileEnabled, verifyTurnstile } from "../turnstile.js";
import { createSession, destroySession, destroyAllSessions, listSessions, sessionIdFromRequest } from "../auth/sessions.js";
import {
  clearPendingCookie,
  createPendingSignup,
  deletePendingSignup,
  pendingFromRequest,
  setPendingCookie,
} from "../auth/pending.js";
import { hashPassword, needsRehash, verifyPassword, checkPasswordBreach, MIN_PASSWORD_LENGTH } from "../auth/passwords.js";
import { identifierHash, hashToken, randomToken, sign, unsign } from "../auth/tokens.js";
import {
  authenticationOptions,
  credentialIdsOf,
  listPasskeys,
  registrationOptions,
  renamePasskey,
  revokePasskey,
  storePasskey,
  verifyAuthentication,
  verifyRegistrationResponse,
} from "../auth/webauthn.js";
import {
  authorizeUrl,
  exchangeCode,
  isProviderConfigured,
  readCallback,
  redirectUri,
  type Provider,
} from "../auth/oauth.js";
import {
  createAccount,
  identitiesOf,
  signInMethods,
  findAccountByEmail,
  findAccountByProvider,
  findAccountByCredential,
} from "../accounts.js";
import { execute, query, queryOne, withTransaction } from "../db.js";
import { sendMail, magicLinkEmail, reauthLinkEmail, welcomeEmail, passwordResetEmail, emailVerificationEmail } from "../notifications/mail.js";
import { log } from "../log.js";
import { requireAuth, requireRecentAuth } from "../middleware.js";

/**
 * The sign-in routes.
 *
 * The contract with the browser is the one the browser's `lib/auth.ts` describes, and it has three outcomes:
 *
 *   signed-in      the session cookie is set; the browser goes to the dashboard
 *   link-sent      a one-time link is on its way
 *   needs-account  the credentials were fine but nobody is registered with them yet; a pending sign-up is created
 *                  and the browser starts the account sequence
 *
 * A "needs-account" answer never says more than that. It does not reveal whether the address exists, and it does
 * not create an account on its own.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Refuse to SET a password that appears in a public breach corpus.
 *
 * Applied on the three paths that choose a new password — change, add, reset — and never on sign-in: a person who
 * already has a weak password must not be locked out of using it (they change it from inside the account), and
 * checking on every sign-in would hammer the provider on the hot path. Fail-open: when the check is disabled, or
 * the provider is slow/down/unparseable, the password is allowed, because a third party being unreachable must not
 * stop somebody creating an account. Only a definitive "yes, this is breached" refuses.
 *
 * The `config` parameter is structurally typed so this stays independent of the full Config shape.
 */
async function rejectIfBreached(
  config: { PASSWORD_BREACH_CHECK: boolean; PASSWORD_BREACH_URL: string; PASSWORD_BREACH_TIMEOUT_MS: number },
  password: string,
  field: HttpError["field"] = "password",
): Promise<void> {
  const result = await checkPasswordBreach(password, {
    enabled: config.PASSWORD_BREACH_CHECK,
    url: config.PASSWORD_BREACH_URL,
    timeoutMs: config.PASSWORD_BREACH_TIMEOUT_MS,
  });
  if (result.checked && result.breached) {
    throw badRequest(
      "password_breached",
      "That password has appeared in a known data breach. Choose a different one.",
      field,
    );
  }
}

export function authRoutes(): Router {
  const router = Router();
  // The attempt ceiling.
  //
  // Three things were wrong with the old one: it counted every request against the global 10,000/day ceiling
  // (so signing out or listing your sessions pushed the whole instance toward a 429), it had no per-identifier
  // component, and it spent budget on requests that were going to succeed anyway. Now:
  //
  //   * reads and housekeeping are not attempts at all;
  //   * the global ceiling counts FAILED attempts only, checked against what is already spent;
  //   * a signed-in caller has their own ceiling, so one attacker cannot exhaust everybody else's.
  const UNCOUNTED_PATHS = new Set(["/logout", "/passkey/options", "/providers", "/session", "/pending", "/sessions/others"]);
  /**
   * The status codes that mean "somebody guessed a credential and got it wrong".
   *
   * The global ceiling used to count EVERY response of 400 or above. That made it a service-wide denial of
   * service with two trivial triggers:
   *
   *   - a 400 is a validation failure. One broken client — a stale cached bundle, a monitor with a bad payload,
   *     somebody's script — retrying a malformed POST 10,000 times a day switched off password sign-in for
   *     EVERY user of the instance. Nothing about that is credential guessing.
   *   - a 429 is the per-IP limiter firing, which is the defence WORKING. Counting it against the global ceiling
   *     means one attacker being rate-limited accelerated the shutdown of the whole service: the more
   *     effectively the per-IP limit worked, the faster the global breaker tripped.
   *   - a 403 is a CSRF or same-origin rejection, and a 5xx is our own failure. Neither is the caller guessing.
   *
   * Only a 401 says "wrong credentials". That is the signal the global breaker exists to aggregate, and at
   * 10,000/day it now genuinely means a distributed credential-stuffing attack rather than one broken client.
   */
  const CREDENTIAL_FAILURE_STATUSES = new Set([401]);
  router.use(asyncHandler(async(req,res,next)=>{
    if(req.method !== "POST" || req.path === "/oauth/callback") { next(); return; }
    // A signed-in caller is limited per ACCOUNT (one person, whatever address they roam across). An anonymous
    // caller is limited per NETWORK, not per address.
    //
    // `req.ip` raw was the bypass: a single IPv6 allocation is normally a /64, which is 2^64 addresses that one
    // person controls and can rotate through freely. At 120 attempts/hour per address that is not a limit, it is
    // an invitation — and the whole point of the anonymous ceiling is to bound credential guessing from one
    // source. `rateLimitBucket` reduces an IPv6 address to its /64 (and leaves IPv4 alone), so the budget covers
    // the network the attacker actually controls. It already existed in http.ts and was simply not used here.
    const perIp = req.account
      ? `auth-ip-account:${req.account.id}`
      : `auth-ip:${rateLimitBucket(clientIp(req, isTrustedProxy) ?? req.ip)}`;
    if(!await budget(perIp, req.account ? 600 : 120, 3600)) throw new HttpError(429,"too_many_attempts","Too many attempts. Try again later.");
    if(UNCOUNTED_PATHS.has(req.path)) { next(); return; }
    const globalKey = req.account ? `auth-global-auth:${req.account.id}` : "auth-global";
    const globalMax = req.account ? 2000 : 10000;
    if(await budgetSpent(globalKey, 86400) >= globalMax) throw new HttpError(429,"too_many_attempts","Too many attempts. Try again later.");
    let counted = false;
    const count = () => { if(counted || !CREDENTIAL_FAILURE_STATUSES.has(res.statusCode)) return; counted = true; void budget(globalKey, globalMax, 86400); };
    res.on("finish", count);
    res.on("close", count);
    next();
  }));
  router.param("id", (req, res, next) => validateId(req, res, next));

  // ---- which providers are available -------------------------------------------------------
  router.get(
    "/providers",
    asyncHandler(async (req: Request, res: Response) => {
      const providers: Provider[] = ["apple", "google"];
      const out: Record<string, boolean> = {};
      for (const p of providers) out[p] = isProviderConfigured(p, req.ctx.config);
      res.json({
        providers: out,
        passkey: true,
        email: req.ctx.config.MAIL_PROVIDER !== "disabled",
        sms: req.ctx.config.SMS_PROVIDER !== "disabled",
        // The Turnstile SITE key is public by design — it is embedded in every page that renders the widget. It
        // is published here rather than baked into the client bundle so that enabling or disabling the check is a
        // server-side configuration change and not a rebuild, and so the browser only loads Cloudflare's script
        // on the endpoints that will actually demand a token.
        turnstile: turnstileEnabled(req.ctx.config) ? { siteKey: req.ctx.config.TURNSTILE_SITE_KEY } : null,
      });
    }),
  );

  // ---- the current session ----------------------------------------------------------------
  router.get(
    "/session",
    asyncHandler(async (req: Request, res: Response) => {
      res.json({
        account: req.account
          ? {
              id: req.account.id,
              displayName: req.account.display_name,
              email: req.account.email,
              emailVerified: req.account.email_verified,
            }
          : null,
      });
    }),
  );

  // ---- the pending sign-up ----------------------------------------------------------------
  //
  // The browser keeps the pending sign-up in `sessionStorage`, which is lost when the tab is closed and when
  // the page is reloaded. The server holds the same thing in the `phylax_pending` cookie and in the database,
  // so it can hand it back. Without this, somebody who reloads halfway through the account sequence is told
  // their sign-in timed out and has to start again.
  router.get(
    "/pending",
    asyncHandler(async (req: Request, res: Response) => {
      const pending = await pendingFromRequest(req, req.ctx.config.SESSION_SECRET);
      if (!pending) {
        res.json({ pending: null });
        return;
      }
      res.json({
        pending: {
          id: pending.id,
          method: pending.method,
          email: pending.email,
          provider: pending.provider,
          displayName: pending.display_name,
          expiresAt: pending.expires_at,
        },
      });
    }),
  );

  // ---- give up a pending sign-up ----------------------------------------------------------
  //
  // The row is deleted, not just the cookie. A pending sign-up that is abandoned has to go, or it sits in the
  // table until it expires and the person can still come back to it.
  router.post(
    "/pending/discard",
    asyncHandler(async (req: Request, res: Response) => {
      const pending = await pendingFromRequest(req, req.ctx.config.SESSION_SECRET);
      if (pending) await deletePendingSignup(pending.id);
      clearPendingCookie(res, req.ctx.config.COOKIE_SECURE);
      res.json({ status: "discarded" });
    }),
  );

  // ---- sign out ----------------------------------------------------------------------------
  router.post(
    "/logout",
    asyncHandler(async (req: Request, res: Response) => {
      const id = sessionIdFromRequest(req);
      await destroySession(res, id, req.ctx.cookieOpts);
      clearPendingCookie(res, req.ctx.config.COOKIE_SECURE);
      res.json({ status: "signed-out" });
    }),
  );

  // ---- sign in with a password -------------------------------------------------------------
  router.post(
    "/password",
    // Only failures count. A shared office or mobile-carrier address spends one budget between everybody behind
    // it; an attacker guessing at one address must not spend a real person's allowance, and a person who signs
    // in and out twenty times must not be told to wait. The precise control is the per-address budget below.
    rateLimiter({ windowMs: 10 * 60 * 1000, max: 20, countStatuses: [401, 429], message: "Too many sign-in attempts. Wait a few minutes and try again." }),
    asyncHandler(async (req: Request, res: Response) => {
      const { email, password } = (req.body ?? {}) as { email?: string; password?: string };
      const address = (email ?? "").trim();
      if (!address) throw badRequest("email_required", "Enter your email address.", "email");
      if (!EMAIL_RE.test(address)) throw badRequest("email_invalid", "Enter a valid email, like name@work.com.", "email");
      if (typeof password !== "string" || password.length === 0) {
        throw badRequest("password_required", "Enter your password.", "password");
      }

      const account = await findAccountByEmail(address);

      // Password sign-in never implicitly registers an address. New accounts use a verified email link
      // or a provider/passkey; add a password after proof. This removes the account-enumerating branch.
      if (!(await budget(`password:${address.toLowerCase()}`,20,600))) throw new HttpError(429,"too_many_attempts","Try again later.");
      if (!account) {
        await hashPassword(password); // same expensive KDF as the existing-account path
        throw unauthorized("invalid_credentials", "That email and password don't match. New here? Create your account with an email link.");
      }

      const identity = await queryOne<{ password_hash: string | null }>(
        `SELECT password_hash FROM auth_identities WHERE account_id = $1 AND method = 'password'`,
        [account.id],
      );
      if(!identity?.password_hash)await hashPassword(password);
      const ok = await verifyPassword(password, identity?.password_hash);
      if (!ok) {
        // Deliberately vague: it must not reveal whether the address is registered.
        throw unauthorized("invalid_credentials", "That email and password don't match. New here? Create your account with an email link.");
      }

      // The cost parameters can be raised later; this is what raises an old hash on its next sign-in. It runs
      // after the password has been verified, so it can never lock anybody out.
      if (needsRehash(identity!.password_hash)) {
        const upgraded = await hashPassword(password);
        await execute("UPDATE auth_identities SET password_hash=$2, last_used_at = now() WHERE account_id = $1 AND method = 'password'", [account.id, upgraded]);
      } else {
        await execute("UPDATE auth_identities SET last_used_at = now() WHERE account_id = $1 AND method = 'password'", [account.id]);
      }
      await createSession(res, account.id, {
        ...req.ctx.cookieOpts,
        proof: { method: "password", value: identity!.password_hash! },
        userAgent: req.headers["user-agent"],
        ip: req.ip ?? null,
      });
      res.json({ status: "signed-in" });
    }),
  );

  // ---- change the password ----------------------------------------------------------------
  //
  // The current password is required, so a person who left their phone unlocked cannot lock the account out.
  // Every other session is ended afterwards, because the point of changing a password is that the old one
  // stops working everywhere.
  router.post(
    "/password/change",
    requireAuth(),
    rateLimiter({ windowMs: 10 * 60 * 1000, max: 10, message: "Too many attempts. Wait a few minutes and try again." }),
    asyncHandler(async (req: Request, res: Response) => {
      const { currentPassword, newPassword } = (req.body ?? {}) as {
        currentPassword?: string;
        newPassword?: string;
      };
      if (typeof currentPassword !== "string" || currentPassword.length === 0) {
        throw badRequest("password_required", "Enter your current password.", "password");
      }
      if (typeof newPassword !== "string" || newPassword.length < MIN_PASSWORD_LENGTH) {
        throw badRequest("password_too_short", `Use at least ${MIN_PASSWORD_LENGTH} characters.`, "password");
      }

      const identity = await queryOne<{ password_hash: string | null }>(
        `SELECT password_hash FROM auth_identities WHERE account_id = $1 AND method = 'password'`,
        [req.account!.id],
      );
      if (!identity?.password_hash) {
        throw badRequest("no_password_set", "This account doesn't use a password. Add one first.");
      }
      if (!(await verifyPassword(currentPassword, identity.password_hash))) {
        throw unauthorized("invalid_credentials", "That current password isn't right.");
      }
      if (await verifyPassword(newPassword, identity.password_hash)) {
        throw badRequest("password_unchanged", "That's the same password. Choose a different one.", "password");
      }
      // After the current-password proof (so this is not a breach oracle for somebody who does not know it) and
      // before the expensive KDF (so a breached password is refused without wasting a scrypt).
      await rejectIfBreached(req.ctx.config, newPassword);

      const hash = await hashPassword(newPassword);
      await withTransaction(async client => {
        const updated = await client.query(`UPDATE auth_identities SET password_hash = $2, last_used_at = now()
          WHERE account_id = $1 AND method = 'password' AND password_hash = $3 RETURNING id`, [req.account!.id, hash, identity.password_hash]);
        if (!updated.rows[0]) throw conflict("password_changed", "Your password changed during this request. Sign in again.");
        await client.query("DELETE FROM sessions WHERE account_id = $1 AND id <> $2", [req.account!.id, req.session!.id]);
        await client.query("DELETE FROM password_reset_tokens WHERE account_id = $1", [req.account!.id]);
        await securityEvent(req.ctx.config,req.account!.id,"password_changed",undefined,client);
      });
      res.json({ status: "changed" });
    }),
  );

  router.post("/password/add", requireAuth(), requireRecentAuth(), rateLimiter({ windowMs: 600000, max: 5 }), asyncHandler(async (req, res) => {
    if (!req.account!.email_verified) throw badRequest("email_not_verified", "Verify email ownership before adding a password.");
    const password = req.body.newPassword;
    if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) throw badRequest("password_too_short", "Use at least eight characters.");
    if (password.length > 1024) throw badRequest("password_too_long", "Use no more than 1,024 characters.");
    if ((await identitiesOf(req.account!.id)).includes("password")) throw conflict("password_exists", "This account already has a password. Use Change password instead.");
    await rejectIfBreached(req.ctx.config, password);
    const hash=await hashPassword(password);
    await withTransaction(async c=>{await c.query("INSERT INTO auth_identities(account_id,method,password_hash) VALUES($1,'password',$2)",[req.account!.id,hash]);await securityEvent(req.ctx.config,req.account!.id,"password_added",undefined,c);});
    res.json({ status: "added" });
  }));

  // Prove it is still you, using a method this account actually has.
  //
  // This used to be password-only, which locked out every passkey, magic-link and OAuth-only account: they were
  // asked for a password they never had. A passkey assertion is an equally good proof of presence, so it is
  // accepted here. An account with neither signs in again with its provider — a fresh session is a fresh proof.
  router.post("/reauthenticate/passkey/options", requireAuth(), rateLimiter({ windowMs: 600000, max: 10 }), asyncHandler(async (req: Request, res: Response) => {
    const credentialIds = await credentialIdsOf(req.account!.id);
    if (!credentialIds.length) throw badRequest("passkey_required", "This account has no passkey to use for confirmation.");
    const options = await authenticationOptions(req.ctx.config, { credentialIds });
    res.json(options);
  }));

  router.post("/reauthenticate",requireAuth(),rateLimiter({windowMs:600000,max:5}),asyncHandler(async(req,res)=>{
    const method=req.body.method === "passkey" ? "passkey" : "password";
    if(method === "password") {
      const password=req.body.password;
      const identity=await queryOne<{password_hash:string|null}>("SELECT password_hash FROM auth_identities WHERE account_id=$1 AND method='password'",[req.account!.id]);
      if(typeof password!=="string" || !await verifyPassword(password,identity?.password_hash))throw unauthorized("invalid_credentials","That password is not correct.");
    } else {
      const credential=req.body.credential;
      if(!credential)throw badRequest("credential_required","That passkey response was missing.");
      let result;
      try { result = await verifyAuthentication(req.ctx.config, credential); }
      catch (err) {
        if (err instanceof HttpError && err.code === "unknown_credential") throw unauthorized("unknown_credential","That passkey is not on this account.");
        throw err;
      }
      // The assertion proves possession of A passkey; it has to be one of THIS account's.
      const owned=await queryOne("SELECT id FROM passkeys WHERE account_id=$1 AND id=$2",[req.account!.id,result.passkey.id]);
      if(!owned)throw unauthorized("unknown_credential","That passkey is not on this account.");
    }
    await execute("UPDATE sessions SET reauthenticated_at=now() WHERE id=$1 AND account_id=$2",[req.session!.id,req.account!.id]);
    res.json({status:"reauthenticated"});
  }));

  // Step-up by EMAIL LINK, for an account whose way in is a link (no password and no passkey to present above).
  //
  // The password/passkey ceremony cannot be satisfied by a magic-link-only or provider-only account, and
  // `requireRecentAuth` gates account deletion, password changes and provider linking — so without this those
  // accounts were locked out of their own security settings. The link is bound at BOTH ends: creating it requires
  // the current session (requireAuth), and the redeem (see /magic-link/redeem) requires the SAME account's session
  // and steps it up rather than creating a new one. A per-account ceiling sits under the per-IP limiter so a
  // signed-in user cannot bury the inbox or run up mail cost.
  router.post("/reauthenticate/link", requireAuth(), rateLimiter({ windowMs: 600000, max: 5 }), asyncHandler(async (req: Request, res: Response) => {
    const account = req.account!;
    if (!account.email) throw badRequest("email_required", "This account has no email address to send a confirmation link to.");
    if (!account.email_verified) throw badRequest("email_not_verified", "Verify your email address before using a link to confirm it's you.");
    if (!await budget(`reauth-link:${account.id}`, 5, 900)) {
      throw new HttpError(429, "too_many_attempts", "Too many confirmation links requested. Wait a few minutes and try again.");
    }
    // Bind to THIS browser like the sign-in link. The redeem needs the session cookie, which is only in the
    // browser that asked; the nonce makes the "wrong browser" answer precise instead of a generic failure.
    const browserNonce = randomToken(32);
    res.cookie("phylax_link", browserNonce, {
      httpOnly: true,
      secure: req.ctx.config.COOKIE_SECURE,
      sameSite: "lax",
      path: "/",
      maxAge: 15 * 60 * 1000,
    });
    const token = randomToken(32);
    await execute(
      `INSERT INTO magic_links (email, token_hash, browser_hash, purpose, account_id, expires_at)
       VALUES ($1, $2, $3, 'reauth', $4, now() + interval '15 minutes')`,
      [account.email, hashToken(token), hashToken(browserNonce), account.id],
    );
    const link = `${req.ctx.config.APP_URL.replace(/\/+$/, "")}/api/auth/magic-link?token=${encodeURIComponent(token)}`;
    const mail = reauthLinkEmail(req.ctx.config.APP_URL, link);
    const sent = await sendMail(req.ctx.config, { to: account.email, subject: mail.subject, text: mail.text, kind: "transactional" });
    if (!sent.ok) log.warn("reauthentication link could not be sent", { error: sent.error });
    res.json({ status: "link-sent" });
  }));
  router.get("/security-events",requireAuth(),asyncHandler(async(req,res)=>{
    const events=await query("SELECT id,kind,created_at FROM security_events WHERE account_id=$1 ORDER BY created_at DESC LIMIT 50",[req.account!.id]);res.json({events});
  }));

  // ---- forgot the password ----------------------------------------------------------------
  //
  // The answer is the same whether or not the address has an account: saying "we sent you a link" to an address
  // that is not registered would tell a stranger who is guessing addresses which ones exist.
  router.post(
    "/password/forgot",
    rateLimiter({ windowMs: 10 * 60 * 1000, max: 10, message: "Too many requests. Wait a few minutes and try again." }),
    asyncHandler(async (req: Request, res: Response) => {
      const { email } = (req.body ?? {}) as { email?: string };
      const address = (email ?? "").trim();
      if (!address) throw badRequest("email_required", "Enter your email address.", "email");
      if (!EMAIL_RE.test(address)) throw badRequest("email_invalid", "Enter a valid email, like name@work.com.", "email");

      // A per-address ceiling as well as the per-IP one: an attacker who rotates addresses must not be able to
      // bury one inbox in reset links.
      if (!await budget(`password-reset:${identifierHash(req.ctx.config, address.toLowerCase())}`, 5, 3600)) {
        throw new HttpError(429, "too_many_attempts", "Too many requests for this address. Wait a few minutes and try again.");
      }

      const account = await findAccountByEmail(address);
      if (account) {
        const identity = await queryOne<{ password_hash: string | null }>(
          `SELECT password_hash FROM auth_identities WHERE account_id = $1 AND method = 'password'`,
          [account.id],
        );
        if (identity?.password_hash) {
          const token = randomToken(32);
          await execute(
            `INSERT INTO password_reset_tokens (account_id, token_hash, email, expires_at)
             VALUES ($1, $2, $3, now() + interval '60 minutes')`,
            [account.id, hashToken(token), address],
          );
          const link = `${req.ctx.config.APP_URL.replace(/\/+$/, "")}/reset-password?token=${encodeURIComponent(token)}`;
          const mail = passwordResetEmail(req.ctx.config.APP_URL, link);
          // Sent after the answer, not before it. Awaiting the provider here made this response take as long as
          // the provider did (up to the 15s timeout) whenever the address had a password — and only then. That
          // difference in timing is an enumeration oracle, and it also made a slow provider look like an outage.
          void sendMail(req.ctx.config, { to: address, subject: mail.subject, text: mail.text, kind: "transactional" })
            .then(sent => { if (!sent.ok) log.warn("password reset email could not be sent", { error: sent.error }); })
            .catch(() => { /* sendMail already logs what went wrong */ });
        }
      }

      res.json({ status: "link-sent" });
    }),
  );

  // ---- set a new password from the reset link ----------------------------------------------
  router.post(
    "/password/reset",
    rateLimiter({ windowMs: 10 * 60 * 1000, max: 10, message: "Too many attempts. Wait a few minutes and try again." }),
    asyncHandler(async (req: Request, res: Response) => {
      const { token, newPassword } = (req.body ?? {}) as { token?: string; newPassword?: string };
      if (typeof token !== "string" || !token) throw badRequest("token_required", "That link is not valid.");
      if (typeof newPassword !== "string" || newPassword.length < MIN_PASSWORD_LENGTH) {
        throw badRequest("password_too_short", `Use at least ${MIN_PASSWORD_LENGTH} characters.`, "password");
      }
      // Before the token is consumed below: a breached password is refused without burning the reset link, so the
      // person can retry with a different password on the same email.
      await rejectIfBreached(req.ctx.config, newPassword);

      const hash = await hashPassword(newPassword);
      await withTransaction(async client => {
        const result = await client.query<{ account_id: string; email: string }>(
          `UPDATE password_reset_tokens SET consumed_at = now()
           WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now() RETURNING account_id,email`, [hashToken(token)]);
        const row = result.rows[0];
        if (!row) throw badRequest("token_invalid", "That link has expired or already been used.");
        const current=await client.query<{email:string|null}>("SELECT email FROM accounts WHERE id=$1 FOR UPDATE",[row.account_id]);
        if(current.rows[0]?.email?.toLowerCase()!==row.email.toLowerCase())throw badRequest("token_invalid","This reset link belongs to an old email address.");
        await establishEmailOwnership(client,row.account_id,row.email);
        await client.query(`INSERT INTO auth_identities (account_id, method, password_hash) VALUES ($1, 'password', $2)
          ON CONFLICT (account_id, method) WHERE method <> 'passkey' DO UPDATE SET password_hash = EXCLUDED.password_hash`, [row.account_id, hash]);
        await client.query("DELETE FROM sessions WHERE account_id = $1", [row.account_id]);
        await client.query("DELETE FROM password_reset_tokens WHERE account_id = $1", [row.account_id]);
        await securityEvent(req.ctx.config,row.account_id,"password_reset",undefined,client);
      });

      res.json({ status: "reset" });
    }),
  );

  // ---- sign in with a one-time link --------------------------------------------------------
  router.post(
    "/magic-link",
    rateLimiter({ windowMs: 10 * 60 * 1000, max: 10, message: "Too many link requests. Wait a few minutes and try again." }),
    asyncHandler(async (req: Request, res: Response) => {
      const { email } = (req.body ?? {}) as { email?: string };
      const address = (email ?? "").trim();
      if (!address) throw badRequest("email_required", "Enter your email address.", "email");
      if (!EMAIL_RE.test(address)) throw badRequest("email_invalid", "Enter a valid email, like name@work.com.", "email");

      // A per-address ceiling as well as the per-IP one, for the same reason as the reset link.
      if (!await budget(`magic-link:${identifierHash(req.ctx.config, address.toLowerCase())}`, 5, 3600)) {
        throw new HttpError(429, "too_many_attempts", "Too many link requests for this address. Wait a few minutes and try again.");
      }

      // Bind the link to THIS browser.
      //
      // A magic link used to be a bearer token with no idea who asked for it. An attacker could request one for
      // their own address and feed the link to a victim's browser: the victim would be signed into the
      // attacker's account — login CSRF, and every file the victim then imported landed in the attacker's
      // account. The link now only redeems in a browser holding the nonce it was issued to, which is the same
      // signed-cookie pattern the pending sign-up and the OAuth state already use.
      const browserNonce = randomToken(32);
      // SameSite=Lax, not None.
      //
      // It was `none` whenever COOKIE_SECURE was on. Nothing needs that: the nonce is read on a same-site POST to
      // /api/auth/magic-link/redeem, which Lax permits — Lax withholds cookies from CROSS-site subresource
      // requests, and this is not one. `none` buys no functionality here and costs the cookie's contribution to
      // the site's overall posture, so the stricter setting is the correct one.
      res.cookie("phylax_link", browserNonce, {
        httpOnly: true,
        secure: req.ctx.config.COOKIE_SECURE,
        sameSite: "lax",
        path: "/",
        maxAge: 15 * 60 * 1000,
      });

      // No account lookup here. Whether or not this address belongs to anybody, the request does the same work
      // and takes the same time — a lookup would only add a query, and the response is identical either way.
      const token = randomToken(32);
      await execute(
        `INSERT INTO magic_links (email, token_hash, browser_hash, expires_at) VALUES ($1, $2, $3, now() + interval '15 minutes')`,
        [address, hashToken(token), hashToken(browserNonce)],
      );
      const link = `${req.ctx.config.APP_URL.replace(/\/+$/, "")}/api/auth/magic-link?token=${encodeURIComponent(token)}`;
      const mail = magicLinkEmail(req.ctx.config.APP_URL, link);
      const sent = await sendMail(req.ctx.config, { to: address, subject: mail.subject, text: mail.text, kind: "transactional" });
      if (!sent.ok) {
        log.warn("magic link could not be sent", { error: sent.error });
      }
      res.json({ status: "link-sent" });
    }),
  );

  // ---- redeem a one-time link --------------------------------------------------------------
  router.get("/magic-link", (req, res) => {
    const token = typeof req.query.token === "string" ? req.query.token : "";
    res.redirect(token ? `/redeem-link?token=${encodeURIComponent(token)}` : "/login?error=link");
  });
  router.post(
    "/magic-link/redeem",
    asyncHandler(async (req: Request, res: Response) => {
      const token = typeof req.body.token === "string" ? req.body.token : "";
      if (!token) throw badRequest("link_invalid", "That link is not valid.");

      // ---- the browser-binding check happens BEFORE the token is consumed --------------------------------
      //
      // It used to happen after: a single `UPDATE ... SET consumed_at = now() ... RETURNING browser_hash` both
      // burned the link and read the binding, and only then was the nonce compared. So the failure mode was
      // self-inflicted and total — open the link in the wrong browser (the mail app's internal webview, a
      // different profile, a phone when you asked on the desktop) and the token is destroyed. The message says
      // "ask for a new link in this browser", which is right, but the person has just lost the link they had, and
      // if they were mid-sign-in on another device there is nothing left to go back to.
      //
      // Read first, then consume. The read is non-destructive and the binding is checked against it; the consume
      // is still a single atomic statement, so two browsers racing for the same token still produce exactly one
      // sign-in.
      const presented = await queryOne<{ id: string; email: string; browser_hash: string | null; purpose: string; account_id: string | null }>(
        `SELECT id, email, browser_hash, purpose, account_id FROM magic_links
          WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()`,
        [hashToken(token)],
      );
      if (!presented) throw badRequest("link_invalid", "That link has expired or already been used.");

      // Rows written before the link was browser-bound carry no hash; they live at most fifteen minutes longer,
      // and refusing them would only confuse somebody mid-sign-in.
      const nonce = parseCookies(req.headers.cookie).phylax_link ?? "";
      const crossDevice = req.body?.crossDevice === true && presented.purpose === "signin";
      if (presented.browser_hash && (!nonce || hashToken(nonce) !== presented.browser_hash) && !crossDevice) {
        // The token is left ALIVE here, on purpose: it still works in the browser that asked for it, which is
        // what the message tells the person to go back to.
        log.info("magic link presented in a browser that did not request it; the link was NOT consumed", {
          code: "link_browser_mismatch", purpose: presented.purpose,
        });
        throw badRequest(
          "link_wrong_browser",
          "For security that link only works in the browser you asked for it in, and it has not been used up — go back to that browser. If you no longer have it, ask for a new link from there.",
        );
      }
      if (presented.browser_hash) {
        res.clearCookie("phylax_link", { httpOnly: true, secure: req.ctx.config.COOKIE_SECURE, sameSite: "lax", path: "/" });
      }

      // Now consume it, atomically. If another browser won the race between the read above and this statement,
      // nothing is returned and the honest answer is "already used".
      const row = await queryOne<{ id: string; email: string; browser_hash: string | null; purpose: string; account_id: string | null }>(
        `UPDATE magic_links SET consumed_at = now()
          WHERE id = $1 AND consumed_at IS NULL AND expires_at > now()
          RETURNING id, email, browser_hash, purpose, account_id`,
        [presented.id],
      );
      if (!row) throw badRequest("link_invalid", "That link has expired or already been used.");

      // ---- a re-authentication link steps up the CURRENT session; it does not create a new one --------------
      //
      // Step-up is required before deleting an account, changing a password or linking a provider, and it
      // accepted a password or a passkey only — so an account whose one credential was an email link could never
      // satisfy it and was permanently locked out of its own security settings. See POST /reauthenticate/link.
      if (row.purpose === "reauth") {
        if (!row.account_id || !req.account || req.account.id !== row.account_id) {
          throw badRequest("link_invalid", "That link belongs to a different sign-in. Ask for a new one.");
        }
        const stepped = await execute(
          `UPDATE sessions SET reauthenticated_at = now()
            WHERE id = $1 AND account_id = $2 AND expires_at > now()`,
          [req.session?.id ?? "", req.account.id],
        );
        if (!stepped) throw unauthorized("session_revoked", "Sign in again before using that link.");
        log.info("session stepped up by email link", { accountId: req.account.id });
        return res.json({ status: "reauthenticated", redirect: "/account" });
      }

      const account = await findAccountByEmail(row.email);
      if (!account) {
        const pending = await createPendingSignup({ method: "link", email: row.email });
        setPendingCookie(res, pending.id, req.ctx.config.SESSION_SECRET, req.ctx.config.COOKIE_SECURE);
        return res.json({ redirect: "/welcome" });
      }
      await withTransaction(client => establishEmailOwnership(client, account.id, row.email));
      await createSession(res, account.id, { ...req.ctx.cookieOpts, userAgent: req.headers["user-agent"], ip: req.ip ?? null });
      res.json({ redirect: "/dashboard" });
    }),
  );

  // ---- passkeys: the options for a sign-in assertion ---------------------------------------
  router.post(
    "/passkey/options",
    rateLimiter({ windowMs: 10 * 60 * 1000, max: 30 }),
    asyncHandler(async (req: Request, res: Response) => {
      const { credentialIds } = (req.body ?? {}) as { credentialIds?: string[] };
      const options = await authenticationOptions(req.ctx.config, {
        ...(Array.isArray(credentialIds) && credentialIds.length ? { credentialIds } : {}),
      });
      res.json(options);
    }),
  );

  // ---- passkeys: check the assertion --------------------------------------------------------
  router.post(
    "/passkey/verify",
    rateLimiter({ windowMs: 10 * 60 * 1000, max: 30 }),
    asyncHandler(async (req: Request, res: Response) => {
      const { credential } = (req.body ?? {}) as { credential?: unknown };
      if (!credential) throw badRequest("credential_required", "That passkey response was missing.");

      let result;
      try {
        result = await verifyAuthentication(req.ctx.config, credential);
      } catch (err) {
        if (err instanceof HttpError && err.code === "unknown_credential") {
          // The passkey is not registered here. Start the account sequence, exactly as an unknown email does.
          const pending = await createPendingSignup({ method: "passkey" });
          setPendingCookie(res, pending.id, req.ctx.config.SESSION_SECRET, req.ctx.config.COOKIE_SECURE);
          res.json({ status: "needs-account", pending: { method: "passkey" } });
          return;
        }
        throw err;
      }

      const updated = await execute("UPDATE passkeys SET counter = $2, last_used_at = now() WHERE id = $1 AND counter = $3", [result.passkey.id, result.newCounter, result.passkey.counter]);
      if (!updated) throw unauthorized("credential_changed", "Start passkey sign-in again.");
      const account = await findAccountByCredential(
        (credential as { id: string }).id,
      );
      if (!account) throw unauthorized("account_missing", "That account is no longer here.");

      await createSession(res, account.id, {
        ...req.ctx.cookieOpts,
        proof: { method: "passkey", value: (credential as { id: string }).id },
        userAgent: req.headers["user-agent"],
        ip: req.ip ?? null,
      });
      res.json({ status: "signed-in" });
    }),
  );

  // Explicit new-account entry: authentication cannot discover a credential that does not exist yet.
  router.post("/passkey/register/start",rateLimiter({windowMs:600000,max:10}),asyncHandler(async(req,res)=>{
    const pending=await createPendingSignup({method:"passkey"});
    setPendingCookie(res,pending.id,req.ctx.config.SESSION_SECRET,req.ctx.config.COOKIE_SECURE);
    res.json({status:"needs-account",pending:{method:"passkey"}});
  }));

  // ---- passkeys: the options for registering one on a new account ---------------------------
  router.post(
    "/passkey/register/options",
    rateLimiter({ windowMs: 10 * 60 * 1000, max: 20 }),
    asyncHandler(async (req: Request, res: Response) => {
      const pending = await pendingFromRequest(req, req.ctx.config.SESSION_SECRET);
      if (!pending) {
        throw badRequest("no_pending_signup", "Your sign-in timed out. Go back to the sign-in page and start again.");
      }
      const { options } = await registrationOptions(req.ctx.config, {
        userName: pending.email ?? `passkey-${pending.id.slice(0, 8)}`,
        userDisplayName: pending.display_name ?? pending.email ?? "Phylax user",
        pendingSignupId: pending.id,
      });
      res.json(options);
    }),
  );

  // ---- passkeys: create the account and store the passkey in one go ------------------------
  //
  // The account and its first passkey are written in ONE transaction. That is the whole point: if the passkey
  // could not be stored, there must be no account, and if the account exists, the passkey must exist too. The
  // pending sign-up is deleted in the same transaction, so one sign-up produces exactly one account.
  router.post(
    "/passkey/register/verify",
    rateLimiter({ windowMs: 10 * 60 * 1000, max: 20 }),
    asyncHandler(async (req: Request, res: Response) => {
      const { credential, displayName, consent, passkeyName } = (req.body ?? {}) as {
        credential?: unknown;
        displayName?: string;
        consent?: { termsVersion: string; privacyVersion: string; acceptedAt: string };
        passkeyName?: string;
      };
      const pending = await pendingFromRequest(req, req.ctx.config.SESSION_SECRET);
      if (!pending) {
        throw badRequest("no_pending_signup", "Your sign-in timed out. Go back to the sign-in page and start again.");
      }
      const name = (displayName ?? "").trim();
      if (!name) throw badRequest("display_name_required", "Enter the name you'd like to be called.", "displayName");
      if (!consent?.termsVersion || !consent?.privacyVersion || !consent?.acceptedAt) {
        throw badRequest("consent_required", "Please agree to the Terms of Service and the Privacy Policy.");
      }

      // The response is checked first. This is pure verification: it consumes the challenge and proves the
      // authenticator is genuine, but it writes nothing.
      const verified = await verifyRegistrationResponse(req.ctx.config, credential, { pendingSignupId: pending.id });

      const account = await withTransaction(async (client) => {
        const created = await createAccount(client, pending, { displayName: name, consent, reminderLeadMinutes: req.ctx.config.REMINDER_LEAD_MINUTES, timezone: req.body.timezone });
        await storePasskey(client, created.id, verified, passkeyName);
        return created;
      });

      // The welcome email goes out after the account exists. A failure to send it is not a failure of the
      // sign-up: the person has an account, and the email is a courtesy.
      if (account.email) {
        const mail = welcomeEmail(req.ctx.config.APP_URL, account.display_name);
        const sent = await sendMail(req.ctx.config, {
          to: account.email,
          subject: mail.subject,
          text: mail.text,
          kind: "transactional",
        });
        if (!sent.ok) log.warn("the welcome email could not be sent", { error: sent.error });
      }

      clearPendingCookie(res, req.ctx.config.COOKIE_SECURE);
      await createSession(res, account.id, {
        ...req.ctx.cookieOpts,
        userAgent: req.headers["user-agent"],
        ip: req.ip ?? null,
      });
      res.json({ id: account.id, displayName: account.display_name });
    }),
  );

  // ---- passkeys: add another one to an account that already exists -------------------------
  //
  // The browser only offers a passkey to somebody who is signed in, and the account already exists, so the
  // options are made with the account's own id as the user handle. The credential ids the account already has
  // are excluded, so the same phone is not offered twice.
  router.post(
    "/passkey/add/options",
    requireAuth(),
    requireRecentAuth(),
    rateLimiter({ windowMs: 10 * 60 * 1000, max: 20 }),
    asyncHandler(async (req: Request, res: Response) => {
      const account = req.account!;
      if (account.email && !account.email_verified) throw badRequest("email_not_verified", "Verify email ownership before adding a passkey.");
      const excluded = await credentialIdsOf(account.id);
      const { options } = await registrationOptions(req.ctx.config, {
        userName: account.email ?? account.id,
        userDisplayName: account.display_name,
        accountId: account.id,
        excludeCredentialIds: excluded,
      });
      res.json(options);
    }),
  );

  router.post(
    "/passkey/add/verify",
    requireAuth(),
    requireRecentAuth(),
    rateLimiter({ windowMs: 10 * 60 * 1000, max: 20 }),
    asyncHandler(async (req: Request, res: Response) => {
      const { credential, passkeyName } = (req.body ?? {}) as { credential?: unknown; passkeyName?: string };
      if (!credential) throw badRequest("credential_required", "That passkey response was missing.");

      if (req.account!.email && !req.account!.email_verified) throw badRequest("email_not_verified", "Verify email ownership before adding a passkey.");
      const verified = await verifyRegistrationResponse(req.ctx.config, credential, { accountId: req.account!.id });
      await withTransaction(async client => {await storePasskey(client, req.account!.id, verified, passkeyName);await securityEvent(req.ctx.config,req.account!.id,"passkey_added",undefined,client);});
      res.json({ status: "added" });
    }),
  );

  // ---- passkeys: what this account has, and removing one ------------------------------------
  router.get(
    "/passkeys",
    requireAuth(),
    asyncHandler(async (req: Request, res: Response) => {
      res.json({ passkeys: await listPasskeys(req.account!.id) });
    }),
  );

  // Rename a passkey. The list exists to answer "is there a device here I don't recognise?", and a credential id
  // cannot answer that — so the name is the person's to set and to change, without another ceremony.
  router.put(
    "/passkeys/:id",
    requireAuth(),
    asyncHandler(async (req: Request, res: Response) => {
      const name = (req.body ?? {}).name;
      if (name !== undefined && typeof name !== "string") throw badRequest("invalid_name", "That name is not valid.");
      const renamed = await renamePasskey(req.account!.id, req.params.id, typeof name === "string" ? name : "");
      if (!renamed) throw new HttpError(404, "not_found", "That passkey isn't on this account.");
      res.json({ status: "renamed" });
    }),
  );

  router.delete(
    "/passkeys/:id",
    requireAuth(),
    requireRecentAuth(),
    asyncHandler(async (req: Request, res: Response) => {
      const removed = await revokePasskey(req.account!.id, req.params.id,c=>securityEvent(req.ctx.config,req.account!.id,"passkey_removed",undefined,c));
      if (!removed) throw new HttpError(404, "not_found", "That passkey isn't on this account.");
      res.json({ status: "removed" });
    }),
  );

  // ---- removing a way to sign in -------------------------------------------------------------
  //
  // Unlinking a provider, removing a password and removing the email address each take away one way to sign in.
  // The guard on all three is the same: at least one way must remain afterwards, or the account becomes
  // unreachable — not only to the person but to every recovery flow, since each of them ends at a sign-in method.
  // All three are recent-auth operations, run in a transaction with their security event, and answer 409 (a
  // conflict with the account's current state) rather than 400 when they would remove the last method.

  const UNLINKABLE_PROVIDERS = new Set(["apple", "google"]);

  router.delete(
    "/providers/:provider",
    requireAuth(),
    requireRecentAuth(),
    rateLimiter({ windowMs: 600000, max: 10 }),
    asyncHandler(async (req: Request, res: Response) => {
      const provider = req.params.provider;
      if (!UNLINKABLE_PROVIDERS.has(provider)) throw new HttpError(404, "not_found", "That provider isn't one you can unlink.");
      const methods = await signInMethods(req.account!.id);
      if (!methods.providers.includes(provider)) throw new HttpError(404, "not_found", "That provider isn't linked to this account.");
      if (methods.total - 1 <= 0) {
        throw conflict("last_signin_method", "That's the only way to sign in to this account. Add another before unlinking it.");
      }
      await withTransaction(async client => {
        await client.query("DELETE FROM auth_identities WHERE account_id=$1 AND method=$2", [req.account!.id, provider]);
        await securityEvent(req.ctx.config, req.account!.id, "provider_unlinked", provider, client);
      });
      res.json({ status: "unlinked", provider });
    }),
  );

  router.delete(
    "/password",
    requireAuth(),
    requireRecentAuth(),
    rateLimiter({ windowMs: 600000, max: 10 }),
    asyncHandler(async (req: Request, res: Response) => {
      const methods = await signInMethods(req.account!.id);
      if (!methods.password) throw new HttpError(404, "not_found", "This account doesn't use a password.");
      if (methods.total - 1 <= 0) {
        throw conflict("last_signin_method", "A password is the only way to sign in to this account. Add a passkey, a provider, or verify an email before removing it.");
      }
      await withTransaction(async client => {
        await client.query("DELETE FROM auth_identities WHERE account_id=$1 AND method='password'", [req.account!.id]);
        // A reset token mints a password without the ceremony this removal just went through; drop any outstanding
        // ones so removing the password cannot be undone by a link that is still in an inbox.
        await client.query("DELETE FROM password_reset_tokens WHERE account_id=$1", [req.account!.id]);
        await securityEvent(req.ctx.config, req.account!.id, "password_removed", undefined, client);
      });
      res.json({ status: "removed" });
    }),
  );

  router.delete(
    "/email",
    requireAuth(),
    requireRecentAuth(),
    rateLimiter({ windowMs: 600000, max: 10 }),
    asyncHandler(async (req: Request, res: Response) => {
      const account = req.account!;
      if (!account.email) throw new HttpError(404, "not_found", "This account has no email address.");
      const methods = await signInMethods(account.id);
      // Removing the address removes the magic-link capability with it, so what must survive is a password, a
      // provider or a passkey. An account whose only way in is an email link cannot have its email removed.
      const remainingWithoutEmail = (methods.password ? 1 : 0) + methods.providers.length + methods.passkeys;
      if (remainingWithoutEmail <= 0) {
        throw conflict("last_signin_method", "Your email is the only way to sign in to this account. Add a password, a passkey, or a provider before removing it.");
      }
      await withTransaction(async client => {
        await client.query("UPDATE accounts SET email=NULL, email_verified=false, email_verified_at=NULL, updated_at=now() WHERE id=$1", [account.id]);
        // The address is gone, so email alerts have nowhere to go. Turn them off rather than let the scheduler keep
        // queueing reminders that can never be delivered. A verified phone and its SMS alerts are left untouched.
        await client.query("UPDATE account_settings SET email_enabled=false WHERE account_id=$1", [account.id]);
        // Any pending proof of the old address is now meaningless, and leaving it would let a stale token
        // re-establish the very address this call removed.
        await client.query("DELETE FROM email_verification_tokens WHERE account_id=$1", [account.id]);
        await client.query("DELETE FROM password_reset_tokens WHERE account_id=$1", [account.id]);
        await securityEvent(req.ctx.config, account.id, "email_removed", account.email, client);
      });
      res.json({ status: "removed" });
    }),
  );

  // ---- sessions: what is signed in, and ending it --------------------------------------------
  router.get(
    "/sessions",
    requireAuth(),
    asyncHandler(async (req: Request, res: Response) => {
      const current = req.session!.id;
      const sessions = await listSessions(req.account!.id, { idleTimeoutMinutes: req.ctx.config.SESSION_IDLE_TIMEOUT_MINUTES });
      res.json({
        sessions: sessions.map((s) => ({
          id: hashToken(s.id),
          current: s.id === current,
          userAgent: s.user_agent,
          ip: s.ip,
          createdAt: s.created_at,
          lastSeenAt: s.last_seen_at,
          expiresAt: s.expires_at,
        })),
      });
    }),
  );

  router.post(
    "/sessions/others",
    requireAuth(),
    asyncHandler(async (req: Request, res: Response) => {
      const ended = await destroyAllSessions(req.account!.id, sessionIdFromRequest(req));
      res.json({ status: "signed-out", ended });
    }),
  );

  router.delete("/sessions/:sessionId", requireAuth(), asyncHandler(async (req, res) => {
    if (!/^[a-f0-9]{64}$/.test(req.params.sessionId)) throw badRequest("invalid_id", "That session identifier is invalid.");
    const ended = await execute("DELETE FROM sessions WHERE account_id=$1 AND encode(digest(id,'sha256'),'hex')=$2", [req.account!.id, req.params.sessionId]);
    if (!ended) throw new HttpError(404, "not_found", "That session no longer exists.");
    res.json({ status: "signed-out" });
  }));

  // ---- email: change it, and confirm it -------------------------------------------------------
  router.post(
    "/email/change",
    requireAuth(),
    requireRecentAuth(),
    rateLimiter({ windowMs: 10 * 60 * 1000, max: 10, message: "Too many requests. Wait a few minutes and try again." }),
    asyncHandler(async (req: Request, res: Response) => {
      if (req.account!.email && !req.account!.email_verified) throw badRequest("email_not_verified", "Verify the current email before changing it.");
      const { email } = (req.body ?? {}) as { email?: string };
      const address = (email ?? "").trim();
      if (!address) throw badRequest("email_required", "Enter your email address.", "email");
      if (!EMAIL_RE.test(address)) throw badRequest("email_invalid", "Enter a valid email, like name@work.com.", "email");
      if (address.toLowerCase() === (req.account!.email ?? "").toLowerCase()) {
        throw badRequest("email_unchanged", "That's already your email address.", "email");
      }

      const clash = await findAccountByEmail(address);
      if (clash) throw conflict("email_in_use", "That email address already has an account.");

      const token = randomToken(32);
      await execute(
        `INSERT INTO email_verification_tokens (account_id, email, token_hash, expires_at)
         VALUES ($1, $2, $3, now() + interval '24 hours')`,
        [req.account!.id, address, hashToken(token)],
      );

      const link = `${req.ctx.config.APP_URL.replace(/\/+$/, "")}/confirm-email?token=${encodeURIComponent(token)}`;
      const mail = emailVerificationEmail(req.ctx.config.APP_URL, link);
      const sent = await sendMail(req.ctx.config, { to: address, subject: mail.subject, text: mail.text, kind: "transactional" });
      if (!sent.ok) {
        log.warn("the verification email could not be sent", { error: sent.error });
        // The address is not changed until it is confirmed, so a failure here leaves the account as it was.
        throw new HttpError(503,"mail_unavailable","Verification email was not accepted. Try again later.");
      }
      res.json({ status: "sent", delivered: true });
    }),
  );

  router.post(
    "/email/confirm",
    asyncHandler(async (req: Request, res: Response) => {
      const { token } = (req.body ?? {}) as { token?: string };
      if (typeof token !== "string" || !token) throw badRequest("token_required", "That link is not valid.");

      const confirmation=await withTransaction(async client => {
        const result = await client.query<{ account_id: string; email: string }>(`UPDATE email_verification_tokens SET consumed_at = now()
          WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now() RETURNING account_id, email`, [hashToken(token)]);
        const row = result.rows[0];
        if (!row) throw badRequest("token_invalid", "That link has expired or already been used.");
        const target = await client.query<{ email: string | null; email_verified: boolean }>("SELECT email,email_verified FROM accounts WHERE id=$1 FOR UPDATE", [row.account_id]);
        if (target.rows[0]?.email?.toLowerCase() !== row.email.toLowerCase()) {
          const live=await client.query("SELECT id FROM sessions WHERE id=$1 AND account_id=$2 AND reauthenticated_at>now()-interval '10 minutes' AND expires_at>now()",[req.session?.id??null,row.account_id]);
          if(!live.rowCount)throw new HttpError(403,"account_required","Sign in again to the account that requested this email change before confirming it.");
        }
        await establishEmailOwnership(client, row.account_id, row.email);
        await client.query("DELETE FROM email_verification_tokens WHERE account_id = $1", [row.account_id]);
        await client.query("DELETE FROM password_reset_tokens WHERE account_id = $1", [row.account_id]);
        await client.query("DELETE FROM sessions WHERE account_id = $1", [row.account_id]);
        await securityEvent(req.ctx.config,row.account_id,"email_confirmed",target.rows[0]?.email_verified?target.rows[0].email:null,client);
        return {accountId:row.account_id,previousEmail:target.rows[0]?.email_verified?target.rows[0].email:null,credentialsReset:!target.rows[0]?.email_verified && target.rows[0]?.email!==null};
      });
      res.json({ status: "confirmed", credentialsReset:confirmation.credentialsReset });
    }),
  );

  router.post("/email/verification", requireAuth(), rateLimiter({ windowMs: 600000, max: 5 }), asyncHandler(async (req, res) => {
    const account = req.account!;
    if (!account.email) throw badRequest("email_required", "Add an email address first.");
    if (account.email_verified) return res.json({ status: "confirmed" });
    const token = randomToken(32);
    await execute("INSERT INTO email_verification_tokens(account_id,email,token_hash,expires_at) VALUES ($1,$2,$3,now()+interval '24 hours')", [account.id, account.email, hashToken(token)]);
    const mail = emailVerificationEmail(req.ctx.config.APP_URL, `${req.ctx.config.APP_URL}/confirm-email?token=${encodeURIComponent(token)}`);
    const sent = await sendMail(req.ctx.config, { to: account.email, ...mail, kind: "transactional" });
    if (!sent.ok) throw new HttpError(503, "mail_unavailable", "We could not send the verification email. Try again later.");
    res.json({ status: "sent" });
  }));

  /**
   * Send a phone-verification code.
   *
   * This is the endpoint that turns an account into money spent, so it carries every layer the product has:
   *
   *   1. a signed-in session, reauthenticated within the last ten minutes;
   *   2. three requests an hour per account (rateLimiter) and three a day per account (durable budget);
   *   3. a per-NETWORK daily ceiling, because a passkey-only sign-up needs no email at all — so an attacker could
   *      register accounts and spend three SMS each on any allowed-prefix number, with the only backstop being
   *      the global transactional cap, which they could also use to deny phone verification to everybody;
   *   4. a minimum account age, because SMS pumping is profitable inside minutes of registration and a real
   *      person is not verifying a phone number in their first hour;
   *   5. a verified email, unless there is no email on the account at all;
   *   6. Turnstile, when configured — see server/turnstile.ts for why it fails open on a provider outage.
   *
   * The country check is answered EXPLICITLY. `SMS_ALLOWED_PREFIXES` exists so an operator can say "we only send
   * to these countries", and the refusal used to be swallowed into a generic 503 "we could not send the code" from
   * deep inside the delivery layer. A person in a country the operator does not serve was told to try again
   * later, forever, with nothing in the log distinguishing them from a provider outage.
   */
  router.post("/phone/verification", requireAuth(), requireRecentAuth(), rateLimiter({ windowMs: 3600000, max: 3, key: req => req.account!.id }), asyncHandler(async (req, res) => {
    const config = req.ctx.config;
    if(req.account!.email && !req.account!.email_verified)throw badRequest("email_not_verified","Verify email before requesting phone codes.");

    const phone = req.body.phone;
    if (typeof phone !== "string" || !/^\+[1-9]\d{6,14}$/.test(phone)) throw badRequest("phone_invalid", "Use an international number, such as +2348012345678.");

    // The destination is checked BEFORE anything is spent or written, so a disallowed country costs the caller no
    // budget and leaves no verification row behind.
    if (config.SMS_ALLOWED_PREFIXES.length && !config.SMS_ALLOWED_PREFIXES.some(prefix => phone.startsWith(prefix))) {
      log.warn("phone verification refused: destination country is not served", { code: "country_not_allowed", accountId: req.account!.id });
      throw new HttpError(403, "country_not_allowed", "Phone verification is not available for that country.");
    }

    // Account age. Zero disables the check, which is the default: it is a policy decision, not a correctness one.
    if (config.SMS_MIN_ACCOUNT_AGE_HOURS > 0) {
      const row = await queryOne<{ age_ok: boolean }>(
        "SELECT created_at < now() - make_interval(hours => $2) AS age_ok FROM accounts WHERE id=$1",
        [req.account!.id, config.SMS_MIN_ACCOUNT_AGE_HOURS],
      );
      if (row && !row.age_ok) {
        log.warn("phone verification refused: account is too new", { code: "account_too_new", accountId: req.account!.id, minHours: config.SMS_MIN_ACCOUNT_AGE_HOURS });
        throw new HttpError(429, "account_too_new", `Your account needs to be at least ${config.SMS_MIN_ACCOUNT_AGE_HOURS} hour(s) old before you can verify a phone number.`);
      }
    }

    // Per-network ceiling. Bucketed to the IPv6 /64 the caller actually controls, for the same reason the
    // anonymous auth limiter is: a raw address is 2^64 fresh budgets to somebody with one allocation.
    const network = rateLimitBucket(clientIp(req, isTrustedProxy) ?? req.ip);
    if (!await budget(`phone-ip:${network}`, config.SMS_VERIFICATION_IP_DAILY_LIMIT, 86400)) {
      log.warn("phone verification refused: per-network daily limit reached", { code: "phone_network_budget", network });
      throw new HttpError(429, "network_daily_budget", "Too many phone codes have been requested from this network today. Try again tomorrow.");
    }

    if(!await budget(`phone-account:${req.account!.id}`,3,86400))throw new HttpError(429,"daily_budget","Phone verification limit reached for today.");

    // Last, because it is the only check that depends on the request body being presented to a human.
    assertTurnstile(await verifyTurnstile(config, (req.body as { turnstileToken?: unknown }).turnstileToken, clientIp(req, isTrustedProxy) ?? req.ip));

    const code = String(randomInt(100000, 1000000));
    const hash = hashToken(`${req.account!.id}:${code}:${req.ctx.config.SESSION_SECRET}`);
    await execute(`INSERT INTO phone_verifications(account_id,phone,code_hash,expires_at) VALUES ($1,$2,$3,now()+interval '10 minutes')
      ON CONFLICT(account_id) DO UPDATE SET phone=EXCLUDED.phone, code_hash=EXCLUDED.code_hash, attempts=0, expires_at=EXCLUDED.expires_at`, [req.account!.id, phone, hash]);
    const sent = await sendSms(config, { to: phone, body: `Your Phylax verification code is ${code}. It expires in 10 minutes. Do not share it.`, kind: "transactional" });
    if (!sent.ok) {
      // The delivery layer's own reason is surfaced when it is one the person can act on, rather than being
      // flattened into "try again later" — which is what told somebody in an unserved country to keep retrying.
      if (sent.error === "country_not_allowed") throw new HttpError(403, "country_not_allowed", "Phone verification is not available for that country.");
      if (sent.error?.startsWith("recipient_suppressed")) throw new HttpError(403, "recipient_suppressed", "Messages to that number are stopped. Text START to that number, or contact support.");
      log.error("phone verification code could not be sent", { code: "sms_send_failed", reason: sent.error, accountId: req.account!.id });
      throw new HttpError(503, "sms_unavailable", "We could not send the code. Try again later.");
    }
    res.json({ status: "sent" });
  }));
  router.post("/phone/confirm", requireAuth(), rateLimiter({ windowMs: 600000, max: 10, key: req => req.account!.id }), asyncHandler(async (req, res) => {
    const code = req.body.code;
    if (typeof code !== "string" || !/^\d{6}$/.test(code)) throw badRequest("code_invalid", "Enter the six-digit code.");
    const hash = hashToken(`${req.account!.id}:${code}:${req.ctx.config.SESSION_SECRET}`);
    const confirmed = await withTransaction(async client => {
      await client.query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE", [req.account!.id]);
      const live = await client.query("SELECT id FROM sessions WHERE id=$1 AND account_id=$2 AND expires_at>now()", [req.session!.id, req.account!.id]);
      if (!live.rowCount) throw unauthorized("session_revoked", "Sign in again before confirming this number.");
      const result = await client.query<{ phone: string; code_hash: string }>(`UPDATE phone_verifications SET attempts=attempts+1
        WHERE account_id=$1 AND expires_at>now() AND attempts<5 RETURNING phone,code_hash`, [req.account!.id]);
      const row = result.rows[0];
      if (!row || row.code_hash !== hash) return false; // commit failed-attempt counter
      await client.query("UPDATE accounts SET phone=$2,phone_verified=true WHERE id=$1", [req.account!.id, row.phone]);
      await client.query("UPDATE account_settings SET phone=$2 WHERE account_id=$1", [req.account!.id, row.phone]);
      await client.query("DELETE FROM phone_verifications WHERE account_id=$1", [req.account!.id]);
      await securityEvent(req.ctx.config,req.account!.id,"phone_confirmed",undefined,client);
      return true;
    });
    if (!confirmed) throw badRequest("code_invalid", "That code is incorrect, expired or has been used too many times.");
    res.json({ status: "confirmed" });
  }));

  // ---- oauth: start the flow ---------------------------------------------------------------
  router.get(
    "/oauth/:provider/start",
    asyncHandler(async (req: Request, res: Response) => {
      const provider = req.params.provider as Provider;
      if (provider !== "apple" && provider !== "google") throw new HttpError(404, "unknown_provider", "That sign-in method does not exist.");
      if (!isProviderConfigured(provider, req.ctx.config)) {
        throw new HttpError(503, "provider_not_configured", "That sign-in method is not available right now.");
      }
      // Only a same-site path: anything that could be read as absolute (//host, /\x) is an open redirect.
      const redirect = typeof req.query.redirect === "string" && /^\/(?![\\/])/.test(req.query.redirect) ? req.query.redirect : "/dashboard";

      // PKCE. The verifier is made here and never leaves the server; only its hash goes to the provider, and
      // the callback has to present the verifier to redeem the code. An intercepted code is then useless.
      const codeVerifier = randomToken(32);
      const browserNonce = randomToken(32);
      // The id the CALLBACK uses to find this row. It travels inside the signed state, not in a cookie, because
      // Apple's form_post is a cross-site POST and browsers do not reliably attach cookies to one — and this row
      // is where the PKCE verifier lives, so a cookie-keyed lookup made the Apple callback unreachable.
      const stateId = randomToken(24);
      // SameSite=Lax, not None.
      //
      // It was `none` whenever COOKIE_SECURE was on, on the theory that a cross-site callback needs it. It does
      // not help: a browser unwilling to send a Lax cookie on a third-party-initiated form post is increasingly
      // unwilling to send a SameSite=None one too, and `none` costs the cookie on every same-site navigation as
      // well as weakening the site's overall cookie posture. What actually binds the callback to the browser that
      // started it is the single-use signed state, consumed below with DELETE..RETURNING. The cookie is defence
      // in depth for the same-site flows where it does arrive.
      res.cookie("phylax_oauth", browserNonce, { httpOnly: true, secure: req.ctx.config.COOKIE_SECURE,
        sameSite: "lax", path: "/api/auth/oauth/callback", maxAge: 600000 });

      // ---- the linking intent, carried in the state -------------------------------------------------------
      //
      // Linking a provider to an EXISTING account requires fresh proof that the person controls that account.
      // That proof used to be read from the session cookie at callback time — which for Apple's cross-site
      // form_post is not there, so `proven` was always false and every Apple link attempt was refused. This is
      // the reason "link Apple" on the account page could never succeed.
      //
      // The signed state is the carrier that survives: HMAC'd under SESSION_SECRET so it cannot be forged, it
      // expires in ten minutes, and the row behind it is consumed on first use so it cannot be replayed. The
      // freshness timestamp is RE-CHECKED at callback time against the same ten-minute window, so a state minted
      // nine minutes ago cannot grant a link ten minutes later.
      //
      // This does not weaken the rule. It moves where the proof is written down, from a cookie the provider's
      // redirect cannot carry to a signed value the provider must carry.
      let link: { accountId: string; proofAt: number } | undefined;
      if (req.account?.id && req.session) {
        const lastProof = req.session.reauthenticated_at ?? req.session.created_at ?? null;
        if (lastProof && Date.now() - lastProof.getTime() <= 600000) {
          link = { accountId: req.account.id, proofAt: lastProof.getTime() };
        }
      }

      // The state carries the provider, where to go afterwards, the CSRF token and the linking intent. It is
      // signed, so it cannot be forged, and it holds the CSRF token, so the callback can check it against the
      // cookie the browser has when there is one.
      const state = sign(
        {
          provider,
          redirect,
          sid: stateId,
          nonce: randomToken(8),
          csrf: browserNonce,
          ...(link ? { link } : {}),
          exp: Date.now() + 10 * 60 * 1000,
        },
        req.ctx.config.SESSION_SECRET,
      );
      await execute("INSERT INTO oauth_states(nonce_hash,state_id,code_verifier,expires_at) VALUES ($1,$2,$3,now()+interval '10 minutes')", [hashToken(browserNonce), stateId, codeVerifier]);
      res.redirect(authorizeUrl(provider, req.ctx.config, state, redirectUri(req.ctx.config), codeVerifier));
    }),
  );

  // ---- oauth: the callback ------------------------------------------------------------------
  //
  // Google redirects with a GET. Apple POSTS a form, because it uses `response_mode=form_post` — and that is
  // the only way it will send the person's name. Both are handled by the same route, which is registered for
  // both methods.
  const oauthCallback = asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as Record<string, unknown>;
    const body = (req.body ?? {}) as Record<string, unknown>;

    // The provider is not named in the callback, so it is read out of the state. The state is signed, so it
    // cannot be forged.
    const rawState = typeof query.state === "string" ? query.state : typeof body.state === "string" ? body.state : "";
    const payload = unsign(rawState, req.ctx.config.SESSION_SECRET);
    if (!payload || (payload.provider !== "apple" && payload.provider !== "google")) {
      return res.redirect("/login?error=oauth");
    }
    const provider = payload.provider as Provider;

    // ---- binding the callback to the browser that started it --------------------------------------------
    //
    // There are two independent bindings, and the second one is the one that cannot be lost:
    //
    //   1. the `phylax_oauth` cookie, checked against `payload.csrf`. This is the classic double-submit binding,
    //      and it works for a same-site callback (Google redirects with a GET on our own origin).
    //   2. the single-use row in `oauth_states`, consumed here with DELETE..RETURNING. The state id travels
    //      inside the HMAC-signed state, which the provider is REQUIRED to send back — in the query string for
    //      Google, in the form body for Apple. A state can be redeemed exactly once, by whoever holds it, and it
    //      only ever existed in the browser that was redirected to the provider.
    //
    // Binding 2 is strictly stronger than binding 1, so the cookie is now defence in depth rather than the gate.
    // That matters because Apple's `response_mode=form_post` is a CROSS-SITE POST: the browser renders a page on
    // appleid.apple.com that auto-submits a form here, and cookies are frequently not attached to it. With the
    // cookie as the gate — and, worse, as the KEY into `oauth_states`, so the PKCE verifier was unreachable too —
    // every Apple callback failed before it reached the linking logic. "Link Apple" could not succeed at all.
    const expected = typeof payload.csrf === "string" ? payload.csrf : "";
    const actual = parseCookies(req.headers.cookie).phylax_oauth ?? "";
    res.clearCookie("phylax_oauth", { httpOnly: true, secure: req.ctx.config.COOKIE_SECURE,
      sameSite: "lax", path: "/api/auth/oauth/callback" });
    const cookieMatches = !!expected && !!actual && expected === actual;
    if (!cookieMatches) {
      // Logged, not refused: see above. A cross-site form post that arrives without its cookie is normal.
      log.info("the oauth callback carried no matching browser cookie; relying on the single-use signed state", {
        provider, code: "oauth_cookie_absent",
      });
    }

    const stateId = typeof payload.sid === "string" ? payload.sid : "";
    const oauthState = stateId
      // The primary lookup: keyed on the id inside the signed state, so it works with no cookie at all.
      ? await queryOne<{ code_verifier: string }>(
          "DELETE FROM oauth_states WHERE state_id = $1 AND expires_at > now() RETURNING code_verifier",
          [stateId],
        )
      // A state minted before this deploy has no `sid`; its row is still reachable by the cookie hash. This
      // branch only exists for the ten minutes either side of a release, and it keeps those flows working.
      : cookieMatches
        ? await queryOne<{ code_verifier: string }>(
            "DELETE FROM oauth_states WHERE nonce_hash = $1 AND expires_at > now() RETURNING code_verifier",
            [hashToken(actual)],
          )
        : null;
    if (!oauthState) {
      log.warn("the oauth state was unknown, expired or already used", { provider, code: "oauth_state_invalid" });
      return res.redirect("/login?error=oauth");
    }
    const callback = readCallback(provider, query, body);
    if (callback.error) return res.redirect("/login?error=oauth");
    if (!callback.code) return res.redirect("/login?error=oauth");

    let identity;
    try {
      identity = await exchangeCode(
        provider,
        req.ctx.config,
        callback.code,
        redirectUri(req.ctx.config),
        oauthState.code_verifier,
      );
    } catch (err) {
      log.warn("oauth callback failed", { provider, error: String(err) });
      return res.redirect("/login?error=oauth");
    }

    const destination = typeof payload.redirect === "string" ? payload.redirect : "/dashboard";

    // Already known: sign in.
    const known = await findAccountByProvider(provider, identity.subject);
    if (known) {
      await execute("UPDATE auth_identities SET last_used_at = now() WHERE method = $1 AND provider_subject = $2", [
        provider,
        identity.subject,
      ]);
      await createSession(res, known.id, {
        ...req.ctx.cookieOpts,
        proof: { method: provider, value: identity.subject },
        userAgent: req.headers["user-agent"],
        ip: req.ip ?? null,
      });
      return res.redirect(destination);
    }

    const byEmail = identity.email && identity.emailVerified ? await findAccountByEmail(identity.email) : null;
    if (byEmail) {
      // Never auto-link solely on provider email. The existing verified account must have authenticated first.
      //
      // "Recently authenticated" means a proof of presence under ten minutes old. There are two places it can
      // come from, and BOTH are checked against the same ten-minute window:
      //
      //   the session    `reauthenticated_at`, falling back to `created_at` for sessions created before
      //                   re-authentication was recorded. This is the same-site path (Google).
      //   the state      `payload.link`, written when the flow started by a session that was itself fresh, and
      //                   re-validated here against the window. This is the ONLY path that works for Apple,
      //                   whose cross-site form_post does not carry the session cookie — and because the state is
      //                   HMAC-signed, single-use and expiring, it is not a weaker proof than the cookie was.
      //
      // Before this, `proven` was computed from the session alone, so it was unconditionally false on an Apple
      // callback: every attempt to link Apple to an existing account was redirected to /login?error=linking.
      const lastProof = req.session?.reauthenticated_at ?? req.session?.created_at ?? null;
      const stateLink = payload.link as { accountId?: unknown; proofAt?: unknown } | undefined;
      const stateProofFresh =
        !!stateLink &&
        typeof stateLink.accountId === "string" &&
        typeof stateLink.proofAt === "number" &&
        Number.isFinite(stateLink.proofAt) &&
        Date.now() - stateLink.proofAt <= 600000 &&
        // The link may only ever be applied to the account the state was minted for. Without this, a state
        // minted while signed in as A could be used to link a provider onto B.
        stateLink.accountId === byEmail.id;
      const proven =
        (req.account?.id === byEmail.id && lastProof !== null && Date.now() - lastProof.getTime() <= 600000) ||
        stateProofFresh;
      if (byEmail.email_verified && !proven) return res.redirect("/login?error=linking");
      await withTransaction(async client=>{
        const live=await client.query<{email_verified:boolean}>("SELECT email_verified FROM accounts WHERE id=$1 FOR UPDATE",[byEmail.id]);
        if(live.rows[0]?.email_verified){
          // The in-transaction re-check, so a concurrent revocation cannot slip between the check above and the
          // identity insert. It accepts the state proof on exactly the same terms.
          if (!stateProofFresh) {
            const session=await client.query("SELECT id FROM sessions WHERE id=$1 AND account_id=$2 AND reauthenticated_at>now()-interval '10 minutes' AND expires_at>now()",[req.session?.id??null,byEmail.id]);
            if(!session.rowCount)throw conflict("linking_required","Sign in to your existing account first.");
          }
        }
        await establishEmailOwnership(client,byEmail.id,identity.email!);
        await client.query("INSERT INTO auth_identities(account_id,method,provider_subject) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",[byEmail.id,provider,identity.subject]);
        await securityEvent(req.ctx.config,byEmail.id,"provider_linked",undefined,client);
      });
      await createSession(res,byEmail.id,{...req.ctx.cookieOpts,userAgent:req.get("user-agent"),ip:req.ip});
      return res.redirect(destination);
    }

    // Unknown: start the account sequence, exactly as an unknown email does.
    const pending = await createPendingSignup({
      method: provider,
      email: identity.email,
      provider,
      providerSubject: identity.subject,
      // Apple sends the name in the posted form, not in the token, so the name from the form is used here.
      displayName: callback.name ?? identity.name,
      emailVerified: identity.emailVerified,
    });
    setPendingCookie(res, pending.id, req.ctx.config.SESSION_SECRET, req.ctx.config.COOKIE_SECURE);
    res.redirect("/welcome");
  });

  router.get("/oauth/callback", oauthCallback);
  router.post("/oauth/callback", oauthCallback);

  return router;
}

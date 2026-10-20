import { Router, type Request, type Response } from "express";
import { asyncHandler, badRequest, HttpError, unauthorized } from "../http.js";
import { LEGAL_VERSION } from "@shared/legal";
import { accountWriteGuard } from "../guards.js";
import { requireAuth, requireRecentAuth } from "../middleware.js";
import { clearPendingCookie, pendingFromRequest } from "../auth/pending.js";
import {
  consentsOf,
  identitiesOf,
  createAccountFromPending,
  deleteAccount,
  ensureSettings,
  exportAccount,
  hasCurrentConsent,
  renameAccount,
} from "../accounts.js";
import { createSession, destroySession, sessionIdFromRequest } from "../auth/sessions.js";
import { execute, queryOne, withTransaction } from "../db.js";
import { hashIdentifierAll, identifierKeys } from "../auth/tokens.js";
import { isValidIanaZone } from "../validation.js";
import { verifyPassword } from "../auth/passwords.js";
import { randomToken, hashToken } from "../auth/tokens.js";
import { sendMail, welcomeEmail, emailVerificationEmail } from "../notifications/mail.js";
import { log } from "../log.js";
import { displayNameLength, validateDisplayName, DISPLAY_NAME_MAX } from "@shared/displayName";

/**
 * The account routes.
 *
 * `POST /api/account` is the end of the account sequence: the sign-in found no account, the person agreed to the
 * documents and picked a name, and this is where the account is actually created.
 */

export function accountRoutes(): Router {
  const router = Router();

  // There used to be a `requireCurrentConsent()` middleware here, applied to both PUT /settings and
  // DELETE /account. The settings half now calls `hasCurrentConsent` directly, because consent genuinely is a
  // precondition for turning alerts ON — you are asking us to start processing your schedule.
  //
  // The deletion half was removed outright, and must not come back: making erasure conditional on accepting the
  // CURRENT terms means a legal-version bump (LEGAL_APPROVED_VERSION is a deploy-time constant, so bumps are
  // routine) stops people deleting their accounts until they agree to a new contract. See DELETE / below.

  router.post("/consent",requireAuth(),asyncHandler(async(req,res)=>{
    if(!req.body.consent) throw badRequest("consent_required","Read and accept the current Terms and Privacy notice.");
    await execute("INSERT INTO account_consents(account_id,terms_version,privacy_version,accepted_at) VALUES($1,$2,$2,now())",[req.account!.id,LEGAL_VERSION]);res.json({status:"accepted"});
  }));
  // ---- create the account for the pending sign-up -------------------------------------------
  router.post(
    "/",
    asyncHandler(async (req: Request, res: Response) => {
      const pending = await pendingFromRequest(req, req.ctx.config.SESSION_SECRET);
      if (!pending) {
        throw badRequest("no_pending_signup", "Your sign-in timed out. Go back to the sign-in page and start again.");
      }
      if (pending.method === "passkey") throw badRequest("passkey_required", "Complete passkey setup to create this account.");
      const { displayName, consent } = (req.body ?? {}) as {
        displayName?: string;
        consent?: { termsVersion: string; privacyVersion: string; acceptedAt: string };
      };

      const name = (displayName ?? "").trim();
      const problem = validateDisplayName(name);
      if (problem) throw badRequest("display_name_invalid", problem, "displayName");
      if (!consent?.termsVersion || !consent?.privacyVersion || !consent?.acceptedAt) {
        throw badRequest("consent_required", "Please agree to the Terms of Service and the Privacy Policy.");
      }

      // The account, the identity and the consent record are written in one transaction, and the pending
      // sign-up is deleted in the same transaction. So one sign-up makes exactly one account, and the sign-up
      // cannot be used a second time.
      const account = await createAccountFromPending(pending, { displayName: name, consent, reminderLeadMinutes: req.ctx.config.REMINDER_LEAD_MINUTES, timezone: req.body.timezone });

      // Queue ownership proof for a provisional password account; a delivery failure leaves it unverified.
      // The user can retry delivery from Account & alerts.
      if (account.email) {
        let mail;
        if (!account.email_verified) {
          const token = randomToken(32);
          await execute("INSERT INTO email_verification_tokens(account_id,email,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '24 hours')", [account.id, account.email, hashToken(token)]);
          mail = emailVerificationEmail(req.ctx.config.APP_URL, `${req.ctx.config.APP_URL}/confirm-email?token=${encodeURIComponent(token)}`);
        } else { mail = welcomeEmail(req.ctx.config.APP_URL, account.display_name); }
        const sent = await sendMail(req.ctx.config, {
          to: account.email,
          subject: mail.subject,
          text: mail.text,
        });
        if (!sent.ok) log.warn("the account email could not be sent", { error: sent.error });
      }

      await createSession(res, account.id, {
        ...req.ctx.cookieOpts,
        userAgent: req.headers["user-agent"],
        ip: req.ip ?? null,
      });
      clearPendingCookie(res, req.ctx.config.COOKIE_SECURE);
      res.json({ id: account.id, displayName: account.display_name });
    }),
  );

  // ---- the signed-in account ---------------------------------------------------------------
  router.get(
    "/",
    requireAuth(),
    accountWriteGuard(),
    asyncHandler(async (req: Request, res: Response) => {
      const settings = await ensureSettings(req.account!.id);
      const consents = await consentsOf(req.account!.id);
      const verification = await queryOne<{ phone_verified: boolean }>("SELECT phone_verified FROM accounts WHERE id=$1", [req.account!.id]);
      res.json({
        methods: await identitiesOf(req.account!.id),
        account: {
          id: req.account!.id,
          displayName: req.account!.display_name,
          email: req.account!.email,
          emailVerified: req.account!.email_verified,
          phone: req.account!.phone,
          phoneVerified: verification?.phone_verified ?? false,
        },
        settings: {
          travelMin: settings?.travel_minutes ?? 60,
          cancelHrs: settings?.cancel_hours ?? 24,
          timezone: settings?.timezone ?? "UTC",
          smsEnabled: settings?.sms_enabled ?? false,
          emailEnabled: settings?.email_enabled ?? false,
          phone: settings?.phone ?? null,
          reminderLeadMinutes: settings?.reminder_lead_minutes ?? 180,
        },
        consents,
      });
    }),
  );

  // ---- change the display name ---------------------------------------------------------------
  router.put(
    "/",
    requireAuth(),
    accountWriteGuard(),
    asyncHandler(async (req: Request, res: Response) => {
      const { displayName } = (req.body ?? {}) as { displayName?: string };
      const name = (displayName ?? "").trim();
      const problem = validateDisplayName(name);
      if (problem) throw badRequest("display_name_invalid", problem, "displayName");
      await renameAccount(req.account!.id, name);
      res.json({ id: req.account!.id, displayName: name });
    }),
  );

  // ---- the settings --------------------------------------------------------------------------
  router.put(
    "/settings",
    requireAuth(),
    accountWriteGuard(),
    asyncHandler(async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as {
        travelMin?: number;
        cancelHrs?: number;
        timezone?: string;
        smsEnabled?: boolean;
        emailEnabled?: boolean;
        phone?: string | null;
        reminderLeadMinutes?: number;
      };
      const accountId = req.account!.id;
      const current = await ensureSettings(accountId);

      const travelMin = clampInt(body.travelMin, current?.travel_minutes ?? 60, 0, 1440);
      const cancelHrs = clampInt(body.cancelHrs, current?.cancel_hours ?? 24, 0, 720);
      const reminderLeadMinutes = clampInt(body.reminderLeadMinutes, current?.reminder_lead_minutes ?? 180, 0, 10080);
      let timezone = current?.timezone ?? "UTC";
      if (body.timezone !== undefined) {
        // Reject, don't silently substitute: a zone the caller did not ask for produces wrong alert times, and
        // an offset-style zone ("+05:00") inverts in PostgreSQL (see isValidIanaZone).
        if (!isValidIanaZone(body.timezone)) throw badRequest("invalid_timezone", "Pick a timezone from the list, such as Africa/Lagos or America/New_York.");
        const known = await queryOne<{ name: string }>("SELECT name FROM pg_timezone_names WHERE name=$1", [body.timezone]);
        if (!known) throw badRequest("invalid_timezone", "That timezone is not available on the server. Pick another from the list.");
        timezone = body.timezone;
      }
      const smsEnabled = typeof body.smsEnabled === "boolean" ? body.smsEnabled : (current?.sms_enabled ?? false);
      const emailEnabled = typeof body.emailEnabled === "boolean" ? body.emailEnabled : (current?.email_enabled ?? false);
      // ---- the phone number is not writable here ---------------------------------------------------------
      //
      // This used to be `body.phone !== undefined ? body.phone : current.phone`, and the value went straight into
      // `accounts.phone` with `phone_verified` flipped to false when it differed. Two problems, one of them
      // serious:
      //
      //   - UNVERIFIED WRITE. Every check above is gated on `smsEnabled`. So a PUT with a new number and SMS left
      //     off stored an arbitrary, unproved number as the account's phone — the same column that is the SMS
      //     alert destination and the identity used by the phone-verification flow. Proving ownership of a number
      //     is the whole point of POST /auth/phone/verification, and this was a way to skip it.
      //   - REDUNDANCY. The number was then written to `account_settings.phone` as well, so the same fact lived in
      //     two tables that could disagree, and neither was authoritative.
      //
      // The number now comes from `accounts.phone`, which only the verification flow writes, and
      // `account_settings.phone` is kept as a mirror of it inside the same transaction. A caller who wants to
      // change their number is told which endpoint does that.
      const stored = await queryOne<{ phone: string | null; phone_verified: boolean }>(
        "SELECT phone, phone_verified FROM accounts WHERE id=$1",
        [accountId],
      );
      const phone = stored?.phone ?? null;
      const requestedPhone = typeof body.phone === "string" ? body.phone.trim() : body.phone === null ? null : undefined;
      if (requestedPhone !== undefined && requestedPhone !== phone) {
        throw badRequest(
          "phone_change_requires_verification",
          "To change your number, send it to Verify phone and enter the code you receive. Settings only holds a number you have already proved.",
        );
      }

      // Turning a channel on is the protected part. Changing the travel window or the timezone of somebody who
      // has already agreed is not, and refusing it would leave them unable to fix a wrong alert time.
      if (smsEnabled || emailEnabled) {
        if (!(await hasCurrentConsent(accountId))) {
          throw new HttpError(409, "consent_required", "Read and accept the current Terms and Privacy notice before enabling alerts.");
        }
      }
      if (smsEnabled && req.account!.email && !req.account!.email_verified) throw badRequest("email_not_verified", "Verify your email address before enabling alerts.");
      if (smsEnabled && req.ctx.config.SMS_PROVIDER === "disabled") throw badRequest("sms_disabled", "Text delivery is not configured by the operator.");
      if (emailEnabled && req.ctx.config.MAIL_PROVIDER === "disabled") throw badRequest("mail_disabled", "Email delivery is not configured by the operator.");
      if (smsEnabled) {
        // `phone` is now by construction the stored number, so the only thing left to check is that it was proved.
        if (!stored?.phone_verified || !stored.phone) throw badRequest("phone_not_verified", "Verify your phone number before enabling text alerts.");
      }
      if (smsEnabled && !phone) {
        throw badRequest("phone_required", "Add the number the texts should go to.");
      }
      if (emailEnabled && !req.account!.email_verified) throw badRequest("email_not_verified", "Verify your email address before enabling alerts.");
      if (emailEnabled && !req.account!.email) {
        throw badRequest("email_required", "This account has no email address to send alerts to.");
      }

      // One transaction, because `account_settings.phone` is a mirror of `accounts.phone` and two separate
      // statements could leave them disagreeing if the second one failed. `accounts.phone` itself is NOT written
      // here at all: this route no longer has any opinion about what the number is.
      await withTransaction(async (client) => {
        await client.query(
          `UPDATE account_settings
              SET travel_minutes = $2, cancel_hours = $3, timezone = $4, sms_enabled = $5, email_enabled = $6,
                  phone = (SELECT phone FROM accounts WHERE id = $1), reminder_lead_minutes = $7, updated_at = now()
            WHERE account_id = $1`,
          [accountId, travelMin, cancelHrs, timezone, smsEnabled, emailEnabled, reminderLeadMinutes],
        );
        // The rules changed: conflicts and cutoffs have to be re-evaluated now, not at the end of a full cycle.
        await client.query("UPDATE accounts SET needs_scan = true WHERE id = $1", [accountId]);
      });
      res.json({ travelMin, cancelHrs, timezone, smsEnabled, emailEnabled, phone, reminderLeadMinutes });
    }),
  );

  // ---- delivery suppressions -------------------------------------------------------------------
  //
  // "Why did my alerts stop?" has to be answerable by the person it happened to, not only by an operator with
  // database access. The addresses are hashed, so this shows the person their own addresses and whether each one
  // is currently suppressed. Re-subscribing after a STOP is allowed; clearing a bounce or a complaint is not —
  // that is the provider's word that the address is bad, and it belongs to the operator to overrule it.
  router.get(
    "/suppressions",
    requireAuth(),
    asyncHandler(async (req: Request, res: Response) => {
      const candidates = [
        ...(req.account!.email ? [{ channel: "email" as const, address: req.account!.email }] : []),
        ...(req.account!.phone ? [{ channel: "sms" as const, address: req.account!.phone }] : []),
      ];
      const out: { channel: string; address: string; suppressed: boolean; reason: string | null; resubscribable: boolean }[] = [];
      for (const c of candidates) {
        // Read side: match the suppression under any identifier key the deployment has used, so a rotated key does
        // not make an existing opt-out or hard-bounce invisible here.
        const hashes = hashIdentifierAll(`${c.channel}:${c.address.trim().toLowerCase()}`, identifierKeys(req.ctx.config));
        const row = hashes.length
          ? await queryOne<{ reason: string }>("SELECT reason FROM delivery_suppressions WHERE recipient_hash = ANY($1::text[]) LIMIT 1", [hashes])
          : null;
        out.push({
          channel: c.channel,
          address: c.address,
          suppressed: !!row,
          reason: row?.reason ?? null,
          resubscribable: row?.reason === "stop",
        });
      }
      res.json({ suppressions: out });
    }),
  );

  router.post(
    "/suppressions/resubscribe",
    requireAuth(),
    requireRecentAuth(),
    asyncHandler(async (req: Request, res: Response) => {
      const channel = req.body.channel === "sms" ? "sms" : "email";
      const address = channel === "sms" ? req.account!.phone : req.account!.email;
      if (!address) throw badRequest("address_required", "There is no address of that kind on this account.");
      // Match across every identifier key: the STOP may have been written under a key that has since rotated.
      const hashes = hashIdentifierAll(`${channel}:${address.trim().toLowerCase()}`, identifierKeys(req.ctx.config));
      // Only a STOP is reversible here. A bounce or a complaint stays until the operator clears it, because the
      // alternative is resuming delivery to an address that has already told us twice that it does not want it.
      const changed = hashes.length
        ? await execute("DELETE FROM delivery_suppressions WHERE recipient_hash = ANY($1::text[]) AND reason='stop'", [hashes])
        : 0;
      res.json({ resubscribed: !!changed });
    }),
  );

  // ---- everything we hold about this account -------------------------------------------------
  //
  // "What do you have about me?" is a fair question, and the answer should not need a phone call. The export
  // is the same data the account is built from, so the two can never disagree.
  router.get(
    "/export",
    requireAuth(),
    accountWriteGuard(),
    asyncHandler(async (req: Request, res: Response) => {
      const data = await exportAccount(req.account!.id);
      // The name says what it is, so the browser saves it as a file rather than displaying it.
      res.setHeader("Content-Disposition", `attachment; filename="phylax-data-${req.account!.id.slice(0, 8)}.json"`);
      res.json(data);
    }),
  );

  // ---- close the account ---------------------------------------------------------------------
  //
  // Deleting an account is the one thing that cannot be undone, so it asks for the password when the account
  // has one. The account and everything attached to it go: the shifts, the patterns, the reminders, the
  // sessions, the passkeys, the consent records.
  //
  // IT DOES NOT ASK FOR CONSENT, and that removal is deliberate.
  //
  // `requireCurrentConsent()` used to sit in this chain, so a person could not delete their account until they
  // had accepted the CURRENT Terms and Privacy notice. When the legal version is bumped — and
  // LEGAL_APPROVED_VERSION is a deploy-time constant, so a bump is a routine event — every account that has not
  // re-accepted is suddenly unable to exercise erasure. That is exactly backwards: the right to delete your data
  // does not become conditional on agreeing to a new contract, and a controller that requires acceptance of new
  // terms before honouring an erasure request is requiring the data subject to contract in order to leave.
  //
  // The controls that DO belong here are unchanged, and they are the ones that make deletion safe rather than the
  // ones that make it contractual: a live session, a re-authentication inside the last ten minutes, and the
  // account's own password when it has one.
  router.delete(
    "/",
    requireAuth(),
    accountWriteGuard(),
    requireRecentAuth(),
    asyncHandler(async (req: Request, res: Response) => {
      const { password } = (req.body ?? {}) as { password?: string };

      const identity = await queryOne<{ password_hash: string | null }>(
        `SELECT password_hash FROM auth_identities WHERE account_id = $1 AND method = 'password'`,
        [req.account!.id],
      );
      if (identity?.password_hash) {
        if (typeof password !== "string" || !(await verifyPassword(password, identity.password_hash))) {
          throw unauthorized("invalid_credentials", "That password isn't right.");
        }
      }

      await deleteAccount(req.account!.id);

      // The cookie has to go too, or the browser is left holding a session for an account that no longer exists.
      await destroySession(res, sessionIdFromRequest(req), req.ctx.cookieOpts);
      res.json({ status: "deleted" });
    }),
  );

  return router;
}

const clampInt = (value: unknown, fallback: number, min: number, max: number) => {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
};

export { HttpError, DISPLAY_NAME_MAX, displayNameLength };

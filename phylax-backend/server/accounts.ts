import { query, queryOne, withTransaction, execute } from "./db.js";
import { HttpError } from "./http.js";
import { normalizeDisplayName, validateDisplayName } from "@shared/displayName";
import type { PendingSignup } from "./auth/pending.js";
import { LEGAL_VERSION } from "@shared/legal";

/**
 * Accounts, and the rules about when one may be created.
 *
 * The invariant that matters: an identity may be attached to exactly one account, and an account is only created
 * when the person asks for one. A sign-in that finds no account never creates one on the spot.
 */

export type AccountRow = {
  id: string;
  display_name: string;
  email: string | null;
  email_verified: boolean;
  email_verified_at: Date | null;
  phone: string | null;
  created_at: Date;
};

export type Consent = {
  termsVersion: string;
  privacyVersion: string;
  acceptedAt: string;
};

/** Find an account by its email address (case-insensitive). */
export async function findAccountByEmail(email: string): Promise<AccountRow | null> {
  return queryOne<AccountRow>("SELECT * FROM accounts WHERE lower(email) = lower($1)", [email]);
}

/**
 * Has this account accepted the *current* Terms and Privacy notice?
 *
 * The version is part of the check on purpose. When the documents change, the people who have not yet seen the
 * new version have not agreed to it — so anything that only makes sense with their agreement (turning alerts on,
 * closing the account) has to ask again. The scheduler uses the same predicate, which is why a person who never
 * re-accepts simply stops being scheduled rather than being half-served.
 */
export async function hasCurrentConsent(accountId: string): Promise<boolean> {
  const row = await queryOne(
    "SELECT 1 FROM account_consents WHERE account_id = $1 AND terms_version = $2 AND privacy_version = $2",
    [accountId, LEGAL_VERSION],
  );
  return !!row;
}

/** Find an account that owns a provider identity. */
export async function findAccountByProvider(method: string, subject: string): Promise<AccountRow | null> {
  return queryOne<AccountRow>(
    `SELECT a.* FROM accounts a
       JOIN auth_identities i ON i.account_id = a.id
      WHERE i.method = $1 AND i.provider_subject = $2`,
    [method, subject],
  );
}

/** Find the account that owns a passkey credential. */
export async function findAccountByCredential(credentialId: string): Promise<AccountRow | null> {
  return queryOne<AccountRow>(
    `SELECT a.* FROM accounts a
       JOIN passkeys p ON p.account_id = a.id
      WHERE p.credential_id = $1`,
    [credentialId],
  );
}

/** The identity rows of an account. */
export async function identitiesOf(accountId: string) {
  return (
    await queryOne<{ methods: string[] }>(
      `SELECT array_agg(method) AS methods FROM auth_identities WHERE account_id = $1`,
      [accountId],
    )
  )?.methods ?? [];
}

/**
 * Every way this account can sign in — the input to the "do not remove the last method" guards used when
 * unlinking a provider, removing a password, or removing the email address.
 *
 * Four independent capabilities are counted:
 *   password    a password identity in auth_identities
 *   providers   each linked OAuth provider (apple, google), counted separately
 *   passkeys    each registered passkey
 *   magicLink   a VERIFIED email address, because a sign-in link can always be sent to it
 *
 * `total` is the sum. Removing any one capability must leave at least one other, or the account stops being
 * reachable by any sign-in method at all — not merely inconvenient, but locked out. Note that removing the email
 * address removes `magicLink`, so that guard subtracts it specifically.
 */
export async function signInMethods(accountId: string): Promise<{
  password: boolean;
  providers: string[];
  passkeys: number;
  magicLink: boolean;
  total: number;
}> {
  const row = await queryOne<{
    has_password: boolean;
    providers: string[] | null;
    passkeys: string;
    magic_link: boolean;
  }>(
    `SELECT
       EXISTS(SELECT 1 FROM auth_identities WHERE account_id=$1 AND method='password') AS has_password,
       COALESCE((SELECT array_agg(method) FROM auth_identities WHERE account_id=$1 AND method IN ('apple','google')), '{}'::text[]) AS providers,
       (SELECT count(*)::text FROM passkeys WHERE account_id=$1) AS passkeys,
       EXISTS(SELECT 1 FROM accounts WHERE id=$1 AND email IS NOT NULL AND email_verified) AS magic_link`,
    [accountId],
  );
  const password = !!row?.has_password;
  const providers = row?.providers ?? [];
  const passkeys = Number(row?.passkeys ?? 0);
  const magicLink = !!row?.magic_link;
  return {
    password,
    providers,
    passkeys,
    magicLink,
    total: (password ? 1 : 0) + providers.length + passkeys + (magicLink ? 1 : 0),
  };
}

/**
 * Create the account for a pending sign-up.
 *
 * Everything happens in one transaction: the account row, the identity that proves who the person is, the
 * settings row and the consent record. If any part fails, none of it is applied.
 *
 * The consent record is written to the account, so the answer to "which version of the terms did they agree to?"
 * is a column, not a guess.
 *
 * The address is only marked as verified when the person proved they own it. Clicking a link that was sent to
 * that address proves it. Typing it into a sign-in form does not: somebody else's password manager may have it,
 * and the address may simply have been typed wrong. So a password sign-up starts as unverified, and the
 * verification email asks the person to confirm it.
 */
export async function createAccountFromPending(
  pending: PendingSignup,
  input: { displayName: string; consent: Consent; reminderLeadMinutes?: number; timezone?: string },
): Promise<AccountRow> {
  return withTransaction((client) => createAccount(client, pending, input));
}

/**
 * The same thing, inside a transaction the caller owns.
 *
 * This is what makes the first passkey possible: the account and the passkey are written together, so there is
 * no moment at which one exists without the other.
 */
export async function createAccount(
  client: { query: <T extends Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> },
  pending: PendingSignup,
  input: { displayName: string; consent: Consent; reminderLeadMinutes?: number; timezone?: string },
): Promise<AccountRow> {
  if (input.timezone !== undefined) {
    try {
      if (typeof input.timezone !== "string") throw new Error("invalid timezone");
      new Intl.DateTimeFormat("en", { timeZone: input.timezone });
    } catch { throw new HttpError(400, "timezone_invalid", "Choose a valid IANA timezone."); }
  }
  const email = pending.email ?? null;
  // The browser normalises the name too, but the server must not trust that: "  Sam   Ortiz " is stored as
  // "Sam Ortiz" whoever sent it.
  const displayName = normalizeDisplayName(input.displayName);
  const problem = validateDisplayName(displayName);
  if (problem) throw new HttpError(400, "display_name_invalid", problem, { field: "displayName" });

  // A link sign-in came from an email the person clicked, so the address is proven. A provider sign-in proves
  // it when the provider says so. A password sign-up proves nothing about the address itself.
  const emailVerified = pending.method === "link" || (pending.email_verified === true && email !== null);

  if (email) {
    const existing = await client.query<AccountRow>("SELECT * FROM accounts WHERE lower(email) = lower($1)", [email]);
    if (existing.rows[0]) {
      // Somebody signed in with an address that now has an account. That is a conflict, not a new account.
      throw new HttpError(409, "account_exists", "An account already exists for that email. Sign in instead.");
    }
  }

  // A passkey sign-up has no address, so the check above finds nothing. The pending sign-up is the thing that
  // stops a second account: it is deleted in the same transaction that creates this one, so it cannot be used
  // twice. If it is still here, somebody is replaying it, and that is a conflict.
  const pendingRows = await client.query<{ id: string }>("SELECT id FROM pending_signups WHERE id = $1 AND expires_at > now() FOR UPDATE", [
    pending.id,
  ]);
  if (!pendingRows.rows[0]) {
    throw new HttpError(409, "signup_already_used", "That sign-in has already been used. Sign in instead.");
  }

  const inserted = await client.query<AccountRow>(
    `INSERT INTO accounts (display_name, email, email_verified, email_verified_at)
     VALUES ($1, $2, $3, CASE WHEN $3 THEN now() ELSE NULL END)
     RETURNING *`,
    [displayName, email, emailVerified],
  );
  const account = inserted.rows[0]!;

  // There is deliberately no `password` branch here any more.
  //
  // It used to read `pending.password_hash` and create a password identity from it — the tail end of the flow in
  // which typing a password at sign-in created an account. That flow was removed (password sign-in answers a
  // generic 401 for an unknown address and never registers), so the hash could only ever be NULL and the branch
  // was unreachable. It stayed reachable from the SCHEMA side, though: the column existed, so a hash of a
  // password somebody had typed could be written into a fifteen-minute table by any path that still set it, with
  // no code that would ever read it back. Migration 015 drops the column and this branch goes with it.
  //
  // An account created from a `password`-method pending row therefore starts with no credential at all, which is
  // the honest state: the person proved nothing yet. They prove their email, and then add a password themselves
  // through POST /api/auth/password/add — which is the path that also queues the ownership-notice outbox.
  if (pending.method === "link" && email) {
    await client.query(
      `INSERT INTO auth_identities (account_id, method) VALUES ($1, 'link')`,
      [account.id],
    );
  } else if ((pending.method === "apple" || pending.method === "google") && pending.provider_subject) {
    await client.query(
      `INSERT INTO auth_identities (account_id, method, provider_subject) VALUES ($1, $2, $3)`,
      [account.id, pending.method, pending.provider_subject],
    );
  }

  await client.query(
    `INSERT INTO account_settings (account_id, reminder_lead_minutes, timezone) VALUES ($1, $2, $3) ON CONFLICT (account_id) DO NOTHING`,
    [account.id, input.reminderLeadMinutes ?? 180, input.timezone ?? "UTC"],
  );

  await client.query(
    `INSERT INTO account_consents (account_id, terms_version, privacy_version, accepted_at)
     VALUES ($1, $2, $3, $4)`,
    [account.id, input.consent.termsVersion, input.consent.privacyVersion, input.consent.acceptedAt],
  );

  // The pending sign-up is spent. Deleting it in the same transaction that creates the account is what makes
  // one sign-up produce exactly one account.
  await client.query("DELETE FROM pending_signups WHERE id = $1", [pending.id]);

  return account;
}

/** The consent records of an account, newest first. */
export async function consentsOf(accountId: string) {
  return query<{
    terms_version: string;
    privacy_version: string;
    accepted_at: string;
  }>(
    `SELECT terms_version, privacy_version, accepted_at FROM account_consents
      WHERE account_id = $1 ORDER BY accepted_at DESC`,
    [accountId],
  );
}

/** Update the display name. */
export async function renameAccount(accountId: string, displayName: string): Promise<void> {
  const name = normalizeDisplayName(displayName);
  const problem = validateDisplayName(name);
  if (problem) throw new HttpError(400, "display_name_invalid", problem, { field: "displayName" });
  await execute("UPDATE accounts SET display_name = $2, updated_at = now() WHERE id = $1", [accountId, name]);
}

// NOTE: `changeEmail`, `markEmailVerified` and `changePhone` used to live here. They were removed on purpose:
// each one wrote an identity or contact field with NO ownership proof — an email set without verifying the new
// address, `email_verified` flipped to true with nothing behind it, a phone number written without the recipient
// ever confirming it (the exact unverified-phone hazard B26 closes on the settings route). Nothing called them,
// and keeping an unverified write path one import away is how it gets wired back up later. Email and phone changes
// go through the verification flows in routes/auth.ts and routes/account.ts instead.

/** The settings of an account, with the defaults filled in. */
export async function settingsOf(accountId: string) {
  return queryOne<{
    account_id: string;
    travel_minutes: number;
    cancel_hours: number;
    timezone: string;
    sms_enabled: boolean;
    email_enabled: boolean;
    phone: string | null;
    reminder_lead_minutes: number;
  }>(
    `SELECT account_id, travel_minutes, cancel_hours, timezone, sms_enabled, email_enabled, phone, reminder_lead_minutes
       FROM account_settings WHERE account_id = $1`,
    [accountId],
  );
}

/** The settings row for an account, created if it is missing. */
export async function ensureSettings(accountId: string, defaults: { reminderLeadMinutes?: number; timezone?: string } = {}) {
  await execute(
    `INSERT INTO account_settings (account_id, reminder_lead_minutes)
     VALUES ($1, COALESCE($2, 180))
     ON CONFLICT (account_id) DO NOTHING`,
    [accountId, defaults.reminderLeadMinutes ?? null],
  );
  return settingsOf(accountId);
}

/**
 * Everything the account holds, as one object.
 *
 * This is what a person is entitled to when they ask "what do you have about me?". It is also the first half of
 * deleting an account: the export is built from the same place, so the two can never drift apart.
 */
export async function exportAccount(accountId: string) {
  const [account, settings, identities, consents, shifts, patterns, reminders, sessions] = await Promise.all([
    queryOne<AccountRow>("SELECT * FROM accounts WHERE id = $1", [accountId]),
    queryOne("SELECT * FROM account_settings WHERE account_id = $1", [accountId]),
    query<{ method: string; created_at: Date; last_used_at: Date | null }>(
      `SELECT method, created_at, last_used_at FROM auth_identities WHERE account_id = $1`,
      [accountId],
    ),
    consentsOf(accountId),
    query(
      `SELECT platform, facility, label, start_minute, end_minute, date, note, created_at
         FROM shifts WHERE account_id = $1 ORDER BY date, start_minute`,
      [accountId],
    ),
    query(
      `SELECT facility, label, start_minute, end_minute, created_at FROM patterns WHERE account_id = $1 ORDER BY facility`,
      [accountId],
    ),
    query(
      `SELECT kind, scheduled_for, sent_at, channel, created_at FROM reminders WHERE account_id = $1 ORDER BY created_at`,
      [accountId],
    ),
    query<{ id: string; created_at: Date; last_seen_at: Date; expires_at: Date; user_agent: string | null }>(
      `SELECT id, created_at, last_seen_at, expires_at, user_agent FROM sessions WHERE account_id = $1`,
      [accountId],
    ),
  ]);

  return {
    securityEvents: await query("SELECT kind,created_at FROM security_events WHERE account_id=$1 ORDER BY created_at",[accountId]),
    deliveries: await query("SELECT provider,channel,status,created_at,updated_at FROM notification_deliveries WHERE account_id=$1 ORDER BY created_at",[accountId]),
    exportedAt: new Date().toISOString(),
    account: account
      ? {
          id: account.id,
          displayName: account.display_name,
          email: account.email,
          emailVerified: account.email_verified,
          phone: account.phone,
          createdAt: account.created_at,
        }
      : null,
    settings,
    signInMethods: identities.map((i) => ({ method: i.method, since: i.created_at, lastUsed: i.last_used_at })),
    consents,
    shifts,
    patterns,
    reminders,
    sessions: sessions.map((s) => ({
      createdAt: s.created_at,
      lastSeenAt: s.last_seen_at,
      expiresAt: s.expires_at,
      userAgent: s.user_agent,
    })),
  };
}

/**
 * Delete an account and everything attached to it.
 *
 * The shifts, patterns, reminders, sessions, identities, passkeys and consents all go with it: the schema
 * declares ON DELETE CASCADE for each of them, so one delete is enough and there is nothing left behind.
 */
export async function deleteAccount(accountId: string): Promise<void> {
  await execute("DELETE FROM accounts WHERE id = $1", [accountId]);
}

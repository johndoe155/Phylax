import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse as verifyRegistrationCeremony,
} from "@simplewebauthn/server";
import { randomBytes } from "node:crypto";
import { execute, query, queryOne, withTransaction } from "../db.js";
import { HttpError } from "../http.js";
import { log } from "../log.js";
import type { Config } from "../config.js";

/**
 * Passkeys (WebAuthn).
 *
 * The shape of the flow:
 *
 *   1. The browser asks for options. The server makes a challenge, stores it (so it can be used exactly once) and
 *      hands the options to the browser.
 *   2. The browser calls `navigator.credentials.get` / `.create`, which shows the real Face ID / fingerprint /
 *      screen-lock prompt. The authenticator signs the challenge.
 *   3. The browser posts the assertion back. The server checks the signature against the stored public key, checks
 *      the challenge is the one it issued and has not expired, and checks the origin and relying-party id.
 *
 * The relying party id has to be the registrable domain of the site (phylax.app, not app.phylax.app) and the
 * origin has to be the exact scheme+host the page was served from. Both come from the configuration, so a staging
 * host and the live host each get their own passkeys.
 */

const CHALLENGE_TTL_MS = 5 * 60 * 1000; // five minutes is plenty for a Face ID prompt

export type Passkey = {
  id: string;
  account_id: string;
  credential_id: string;
  public_key: string;
  counter: number;
  transports: string[] | null;
  device_type: string | null;
  backed_up: boolean;
  aaguid: string | null;
  user_handle: string | null;
  created_at: Date;
  last_used_at: Date | null;
};

/** The options for an authentication (signing in with an existing passkey). */
export async function authenticationOptions(
  config: Config,
  opts: { accountId?: string; credentialIds?: string[] } = {},
) {
  const allowCredentials =
    opts.credentialIds && opts.credentialIds.length
      ? opts.credentialIds.map((id) => ({ id, transports: undefined }))
      : undefined;

  const options = await generateAuthenticationOptions({
    rpID: config.rpId,
    userVerification: "required",
    ...(allowCredentials ? { allowCredentials } : {}),
  });

  await execute(
    `INSERT INTO webauthn_challenges (challenge, kind, account_id, expires_at)
     VALUES ($1, 'authentication', $2, $3)`,
    [options.challenge, opts.accountId ?? null, new Date(Date.now() + CHALLENGE_TTL_MS).toISOString()],
  );
  return options;
}

/** The options for a registration (adding a passkey to an account). */
export async function registrationOptions(
  config: Config,
  opts: { userName: string; userDisplayName: string; pendingSignupId?: string; accountId?: string; excludeCredentialIds?: string[] },
) {
  // The user handle is a stable, opaque id for the account. For a brand-new account it is generated now and kept
  // with the credential, so the authenticator's copy and the server's copy agree from the first registration.
  const existingHandle = opts.accountId ? await queryOne<{ user_handle: string }>("SELECT user_handle FROM passkeys WHERE account_id = $1 LIMIT 1", [opts.accountId]) : null;
  const userHandle = existingHandle?.user_handle ?? Buffer.from(randomBytes(32)).toString("base64url");

  const options = await generateRegistrationOptions({
    rpName: config.RP_NAME,
    rpID: config.rpId,
    userName: opts.userName,
    userDisplayName: opts.userDisplayName,
    userID: Buffer.from(userHandle, "base64url"),
    attestationType: "none",
    excludeCredentials: (opts.excludeCredentialIds ?? []).map((id) => ({ id })),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "required",
    },
  });

  await execute(
    `INSERT INTO webauthn_challenges (challenge, kind, pending_signup_id, user_handle, expires_at, account_id)
     VALUES ($1, 'registration', $2, $3, $4, $5)`,
    [
      options.challenge,
      opts.pendingSignupId ?? null,
      userHandle,
      new Date(Date.now() + CHALLENGE_TTL_MS).toISOString(),
      opts.accountId ?? null,
    ],
  );
  return { options, userHandle };
}

/**
 * The challenge the browser signed, read out of the client data.
 *
 * The client data is base64url-encoded JSON that the browser produced and the authenticator signed over. A
 * malformed one is a bad request, not a crash: `JSON.parse` throws a SyntaxError, and an unhandled one of those
 * would be a 500 that says nothing about what went wrong.
 */
function challengeFromClientData(response: unknown): string {
  const body = response as { response?: { clientDataJSON?: string } };
  const encoded = body?.response?.clientDataJSON;
  if (typeof encoded !== "string" || encoded.length === 0) {
    throw new HttpError(400, "invalid_credential", "That passkey response wasn't readable.");
  }
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as { challenge?: unknown };
    if (typeof parsed.challenge !== "string" || parsed.challenge.length === 0) {
      throw new HttpError(400, "invalid_credential", "That passkey response wasn't readable.");
    }
    return parsed.challenge;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, "invalid_credential", "That passkey response wasn't readable.");
  }
}

/** Consume a challenge: it must exist, be the right kind, and not have expired. */
async function consumeChallenge(challenge: string, kind: "registration" | "authentication") {
  const row = await queryOne<{
    id: string;
    challenge: string;
    kind: string;
    account_id: string | null;
    pending_signup_id: string | null;
    user_handle: string | null;
  }>(
    `DELETE FROM webauthn_challenges
      WHERE challenge = $1 AND kind = $2 AND expires_at > now()
      RETURNING id, challenge, kind, account_id, pending_signup_id, user_handle`,
    [challenge, kind],
  );
  if (!row) throw new HttpError(400, "challenge_expired", "That sign-in took too long. Try again.");
  return row;
}

/** Check an assertion against a stored passkey. */
export async function verifyAuthentication(
  config: Config,
  response: unknown,
): Promise<{ accountId: string; passkey: Passkey; newCounter: number }> {
  const body = response as { id?: string; response?: { clientDataJSON?: string; authenticatorData?: string; signature?: string; userHandle?: string } };
  const credentialId = body?.id;
  if (!credentialId) throw new HttpError(400, "invalid_credential", "That passkey response wasn't readable.");

  // The challenge is consumed FIRST, before anything else is looked up. A challenge is a one-time ticket: it
  // has to be gone whether or not the rest of the check passes, or a single issued challenge could be replayed
  // against a different credential.
  const challengeRow = await consumeChallenge(challengeFromClientData(response), "authentication");

  const passkey = await queryOne<Passkey>("SELECT * FROM passkeys WHERE credential_id = $1", [credentialId]);
  if (!passkey) {
    // The browser may send the id in base64url and the database may hold the same string; if it is not there, the
    // person has no passkey here, which is a "needs an account" answer rather than a failure.
    throw new HttpError(404, "unknown_credential", "That passkey isn't registered here.");
  }

  if (challengeRow.account_id && challengeRow.account_id !== passkey.account_id) throw new HttpError(400, "challenge_mismatch", "Start sign-in again.");
  if (body.response?.userHandle && body.response.userHandle !== passkey.user_handle) throw new HttpError(401, "invalid_credential", "That passkey does not belong to this account.");
  const verification = await verifyAuthenticationResponse({
    response: response as Parameters<typeof verifyAuthenticationResponse>[0]["response"],
    expectedChallenge: challengeRow.challenge,
    expectedOrigin: config.rpOrigin,
    expectedRPID: config.rpId,
    requireUserVerification: true,
    credential: {
      id: passkey.credential_id,
      publicKey: Buffer.from(passkey.public_key, "base64url"),
      counter: passkey.counter,
      transports: (passkey.transports ?? undefined) as never,
    },
  }).catch(() => { throw new HttpError(401, "verification_failed", "That passkey could not be verified."); });

  if (!verification.verified) {
    throw new HttpError(401, "verification_failed", "That passkey couldn't be verified. Try again.");
  }
  if (verification.authenticationInfo.newCounter <= passkey.counter && passkey.counter > 0) {
    // The counter going backwards means the authenticator was cloned.
    log.warn("webauthn counter went backwards", { credentialId, previous: passkey.counter, next: verification.authenticationInfo.newCounter });
  }

  return {
    accountId: passkey.account_id,
    passkey,
    newCounter: verification.authenticationInfo.newCounter,
  };
}

/** What a verified registration tells us about the new passkey. */
export type VerifiedRegistration = {
  credentialId: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[] | null;
  deviceType: string | null;
  backedUp: boolean;
  aaguid: string | null;
  userHandle: string;
};

/**
 * Check a registration response, without storing anything.
 *
 * The check is split from the write on purpose. Creating an account and registering its first passkey has to
 * be one atomic step: if the account were made first and the passkey second, a failure in between would leave
 * an account nobody can sign in to, and a retry would make a second one.
 *
 * So the response is verified first — which is pure computation, and consumes the challenge — and the result
 * is handed to the caller, who writes the account and the passkey together in one transaction.
 */
export async function verifyRegistrationResponse(config: Config, response: unknown, owner?: { accountId?: string; pendingSignupId?: string }): Promise<VerifiedRegistration> {
  const challengeRow = await consumeChallenge(challengeFromClientData(response), "registration");
  if (!owner || (owner.accountId ? challengeRow.account_id !== owner.accountId : challengeRow.pending_signup_id !== owner.pendingSignupId)) {
    throw new HttpError(400, "challenge_mismatch", "Start passkey setup again in this account.");
  }
  // The user handle was chosen when the options were made and stored with the challenge, so the authenticator's
  // copy and the server's copy agree even for an account that did not exist when the options were made.
  const userHandle = challengeRow.user_handle ?? "";

  const verification = await verifyRegistrationCeremony({
    response: response as Parameters<typeof verifyRegistrationCeremony>[0]["response"],
    expectedChallenge: challengeRow.challenge,
    expectedOrigin: config.rpOrigin,
    expectedRPID: config.rpId,
    requireUserVerification: true,
  }).catch(() => { throw new HttpError(400, "verification_failed", "That passkey could not be registered."); });

  if (!verification.verified || !verification.registrationInfo) {
    throw new HttpError(400, "verification_failed", "That passkey couldn't be set up. Try again.");
  }
  const info = verification.registrationInfo;

  return {
    credentialId: info.credential.id,
    publicKey: info.credential.publicKey,
    counter: info.credential.counter ?? 0,
    transports: info.credential.transports ?? null,
    deviceType: info.credentialDeviceType ?? null,
    backedUp: info.credentialBackedUp ?? false,
    aaguid: info.aaguid ?? null,
    userHandle,
  };
}

/**
 * Store a verified passkey against an account.
 *
 * The client is passed in so this can run inside the caller's transaction.
 */
export async function storePasskey(
  client: { query: <T extends Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> },
  accountId: string,
  verified: VerifiedRegistration,
  /** What the person wants to call this device. A label, never an identifier. */
  name?: string,
): Promise<Passkey> {
  const label = typeof name === "string" ? name.trim().slice(0, 60) : "";
  const row = await client.query<Passkey>(
    `INSERT INTO passkeys
       (account_id, credential_id, public_key, counter, transports, device_type, backed_up, aaguid, user_handle, name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)

     RETURNING *`,
    [
      accountId,
      verified.credentialId,
      Buffer.from(verified.publicKey).toString("base64url"),
      verified.counter,
      verified.transports,
      verified.deviceType,
      verified.backedUp,
      verified.aaguid,
      verified.userHandle,
      label || null,
    ],
  );
  // The identity row is what makes "which methods can this person sign in with?" a complete answer.
  await client.query(
    `INSERT INTO auth_identities (account_id, method, credential_id) VALUES ($1, 'passkey', $2)
     ON CONFLICT (credential_id) WHERE credential_id IS NOT NULL DO NOTHING`,
    [accountId, verified.credentialId],
  );
  return row.rows[0]!;
}

/** Check a registration response and store the new passkey, for an account that already exists. */
export async function verifyRegistration(
  config: Config,
  response: unknown,
  opts: { accountId: string },
): Promise<Passkey> {
  const verified = await verifyRegistrationResponse(config, response, opts);
  return withTransaction(client => storePasskey(client, opts.accountId, verified));
}

/** Remove challenges that have expired. Called by the scheduler. */
export async function pruneChallenges(): Promise<number> {
  return execute("DELETE FROM webauthn_challenges WHERE expires_at <= now()");
}

/**
 * The passkeys an account has.
 *
 * The credential id is not secret and is not shown in full: an authenticator's credential id is a public
 * identifier, but there is no reason to put it in front of a person, so it is shortened.
 */
export async function listPasskeys(accountId: string) {
  const rows = await query<{
    id: string;
    credential_id: string;
    name: string | null;
    device_type: string | null;
    backed_up: boolean;
    created_at: Date;
    last_used_at: Date | null;
  }>(
    `SELECT id, credential_id, name, device_type, backed_up, created_at, last_used_at
       FROM passkeys WHERE account_id = $1 ORDER BY created_at`,
    [accountId],
  );
  return rows.map((row) => ({
    id: row.id,
    /** A short, stable handle the browser can use to name the device. */
    handle: row.credential_id.slice(0, 12),
    /** What the person called it; the device type when they have not called it anything. */
    name: row.name ?? null,
    deviceType: row.device_type,
    backedUp: row.backed_up,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  }));
}

/**
 * Rename a passkey.
 *
 * The list exists so a person can answer "is there a device here I don't recognise?", and a credential id cannot
 * answer that. The name is theirs to change, at any time, without another ceremony.
 */
export async function renamePasskey(accountId: string, passkeyId: string, name: string): Promise<boolean> {
  const label = name.trim().slice(0, 60);
  const changed = await execute(
    "UPDATE passkeys SET name = $3 WHERE id = $1 AND account_id = $2",
    [passkeyId, accountId, label || null],
  );
  return !!changed;
}

/** Remove one passkey. The credential id is the row's own id, so it cannot remove somebody else's. */
export async function revokePasskey(accountId: string, passkeyId: string,onRevoke?:(client:import("pg").PoolClient)=>Promise<void>): Promise<boolean> {
  return withTransaction(async client => {
    await client.query("SELECT id FROM accounts WHERE id = $1 FOR UPDATE", [accountId]);
    const methods = await client.query<{ n: string }>("SELECT count(*)::text AS n FROM auth_identities WHERE account_id = $1 AND method <> 'passkey'", [accountId]);
    const keys = await client.query<{ n: string }>("SELECT count(*)::text AS n FROM passkeys WHERE account_id = $1", [accountId]);
    if (Number(methods.rows[0]?.n) === 0 && Number(keys.rows[0]?.n) <= 1) throw new HttpError(409, "last_sign_in_method", "Add another sign-in method before removing your last passkey.");
    const removed = await client.query<{ credential_id: string }>("DELETE FROM passkeys WHERE id = $1 AND account_id = $2 RETURNING credential_id", [passkeyId, accountId]);
    if (!removed.rows[0]) return false;
    await client.query("DELETE FROM auth_identities WHERE account_id = $1 AND method = 'passkey' AND credential_id = $2", [accountId, removed.rows[0].credential_id]);
    await onRevoke?.(client);
    return true;
  });
}

/**
 * The credential ids an account already has, so a new passkey is not offered a credential that is already
 * registered. Without this, registering the same phone twice would be rejected by the authenticator with a
 * message nobody understands.
 */
export async function credentialIdsOf(accountId: string): Promise<string[]> {
  const rows = await query<{ credential_id: string }>("SELECT credential_id FROM passkeys WHERE account_id = $1", [
    accountId,
  ]);
  return rows.map((r) => r.credential_id);
}

/** The identity row that records a passkey, so the account's sign-in methods are complete. */
export async function recordPasskeyIdentity(accountId: string, credentialId: string): Promise<void> {
  await execute(
    `INSERT INTO auth_identities (account_id, method, credential_id) VALUES ($1, 'passkey', $2)
     ON CONFLICT (credential_id) WHERE credential_id IS NOT NULL DO NOTHING`,
    [accountId, credentialId],
  );
}

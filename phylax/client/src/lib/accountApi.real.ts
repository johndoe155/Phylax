/**
 * The account page's REAL adapter (types and pure helpers stay in account.ts; the components import these calls through
 * accountApi.ts, which is a one-line seam).
 *
 * The page was written against a single `AccountProfile`. The backend serves the same facts from several endpoints with
 * different names, so this module's job is composition and translation — never a backend change:
 *
 *   GET  /account                    account{}, settings{}, methods[], consents[]
 *   GET  /auth/passkeys              the credentials (the profile needs them; /account does not carry them)
 *   GET  /auth/providers             which channels exist + the Turnstile site key (there is no /account/meta)
 *   GET  /auth/sessions              {sessions:[{id,current,userAgent,ip,createdAt,lastSeenAt,expiresAt}]}
 *   GET  /auth/security-events       {events:[{id,kind,created_at}]}
 *   GET  /shifts/reminders           {reminders:[{id,kind,status,scheduledFor,acceptedAt,sentAt,channel,error}]}
 *
 * FIELD RENAMES (server -> page)
 *   settings.reminderLeadMinutes -> settings.leadMinutes        settings.emailEnabled -> settings.emailAlerts
 *   settings.smsEnabled          -> settings.textAlerts        account.emailVerified -> email.verified
 *   account.phoneVerified        -> phone.verified             methods[] ('password','apple','google','link')
 *                                                                 -> hasPassword + providers[]
 *   passkeys.deviceType 'multiDevice' -> 'synced', anything else -> 'device-bound'
 *   consents[].terms_version / accepted_at -> consent.version / consent.acceptedAt (the newest row)
 *   security event kind -> a readable summary (KIND_LABELS)
 *   reminder channel 'sms' -> 'text'; reminder status collapsed to accepted | failed | skipped
 *
 * ROUTE / VERB TRANSLATIONS (page intent -> backend route)
 *   verify email        POST   /auth/email/verification
 *   change email        POST   /auth/email/change {email}
 *   remove email        DELETE /auth/email
 *   send phone code     POST   /auth/phone/verification {phone, turnstileToken}
 *   verify phone code   POST   /auth/phone/confirm {code}
 *   rename              PUT    /account {displayName}
 *   add password        POST   /auth/password/add {newPassword}
 *   change password     POST   /auth/password/change {currentPassword, newPassword}
 *   remove password     DELETE /auth/password
 *   rename passkey      PUT    /auth/passkeys/:id {name}
 *   remove passkey      DELETE /auth/passkeys/:id
 *   reauth (password)   POST   /auth/reauthenticate {method:'password', password}
 *   reauth (passkey)    POST   /auth/reauthenticate/passkey/options -> ceremony -> POST /auth/reauthenticate {method:'passkey', credential}
 *   reauth (email)      POST   /auth/reauthenticate/link  (the link steps the CURRENT session up when redeemed)
 *   unlink provider     DELETE /auth/providers/:provider
 *   sign out others     POST   /auth/sessions/others
 *   revoke one device   DELETE /auth/sessions/:id      (the id is the sha256 handle /auth/sessions returned)
 *   accept policies     POST   /account/consent {consent:{termsVersion,privacyVersion,acceptedAt}}
 *   export              GET    /account/export        (already a JSON attachment)
 *   delete account      DELETE /account {password?}
 *
 * TWO THINGS THE SERVER DOES NOT PUBLISH, and how they are handled here:
 *
 *   reauthUntil  There is no "elevated until" field anywhere in the API; the server enforces a ten-minute window on the
 *                session (`sessions.reauthenticated_at`) and answers 403 `reauthentication_required` outside it. So the
 *                page's countdown is kept here: it starts when a step-up succeeds, is remembered in sessionStorage so a
 *                reload does not lose it, and is cleared the moment the server actually refuses something — which makes it
 *                an optimistic mirror of the server's window rather than a second source of truth.
 *
 *   phone.pending  A code that was sent but not yet confirmed is not stored on the account, so it is remembered here for
 *                the life of the tab. The verified number always comes from the server.
 *
 * ERRORS. Every failure is an AccountError, because that is what the page renders:
 *   403 reauthentication_required -> code "reauth-required" (the runner toasts it with a "Confirm it's you" action)
 *   409 last_signin_method        -> code "last-method"
 *   401 not_signed_in/session_revoked -> code "signed-out"
 *   429                           -> code "rate-limited"
 *   anything else                 -> code "invalid", with `field` mapped onto the input the server named
 */
import { ApiError, apiFetch, apiPost } from "./apiClient";
import { createPasskey, getPasskey, CeremonyError } from "./webauthn";
import { getAuthProviders, removeCurrentAccount, renameCurrentAccount, type Provider } from "./auth";
import { POLICY_VERSION } from "./legal";
import {
  AccountError, HISTORY_LIMIT, LEAD_MAX, LEAD_MIN, PASSKEY_NAME_MAX, PASSWORD_MIN, REAUTH_MINUTES, setOAuthEnabled,
  type AccountMeta, type AccountProfile, type AlertRecord, type AlertStatus, type ChannelKey, type History,
  type NotificationSettings, type PasskeyInfo, type SecurityEvent, type SessionInfo,
} from "./account";

// ---- The server's shapes -------------------------------------------------------------------------------------------------

type AccountPayload = {
  methods: string[];
  account: {
    id: string;
    displayName: string;
    email: string | null;
    emailVerified: boolean;
    phone: string | null;
    phoneVerified: boolean;
  };
  settings: {
    travelMin: number;
    cancelHrs: number;
    timezone: string;
    smsEnabled: boolean;
    emailEnabled: boolean;
    phone: string | null;
    reminderLeadMinutes: number;
  };
  consents: { terms_version: string; privacy_version: string; accepted_at: string }[];
};

type PasskeyPayload = {
  passkeys: { id: string; handle: string; name: string | null; deviceType: string | null; backedUp: boolean; createdAt: string; lastUsedAt: string | null }[];
};

type SessionsPayload = {
  sessions: { id: string; current: boolean; userAgent: string | null; ip: string | null; createdAt: string; lastSeenAt: string | null; expiresAt: string }[];
};

type SecurityEventsPayload = { events: { id: string; kind: string; created_at: string }[] };

type RemindersPayload = {
  reminders: { id: string; kind: string; status: string; scheduledFor: string; acceptedAt: string | null; sentAt: string | null; channel: string | null; error: string | null }[];
};

// ---- Small caches ---------------------------------------------------------------------------------------------------------

const REAUTH_STORAGE_KEY = "phylax:reauth-until";

/** The end of the elevated window, as this tab believes it. See the header note. */
let reauthUntil: string | null = (() => {
  try {
    const stored = sessionStorage.getItem(REAUTH_STORAGE_KEY);
    if (stored && Date.parse(stored) > Date.now()) return stored;
  } catch {
    /* storage unavailable: the window simply starts fresh */
  }
  return null;
})();

function setReauthWindow(): void {
  reauthUntil = new Date(Date.now() + REAUTH_MINUTES * 60_000).toISOString();
  try {
    sessionStorage.setItem(REAUTH_STORAGE_KEY, reauthUntil);
  } catch {
    /* storage unavailable: kept in memory for this page */
  }
}

function clearReauthWindow(): void {
  reauthUntil = null;
  try {
    sessionStorage.removeItem(REAUTH_STORAGE_KEY);
  } catch {
    /* nothing stored */
  }
}

/** A number that was sent a code in this tab and is not verified yet. Not published by the server. */
let pendingPhone: string | null = null;

// ---- Error translation -----------------------------------------------------------------------------------------------------

/** The server's input names -> the page's input names. Anything unmapped is passed through. */
const FIELD_ALIASES: Record<string, string> = {
  password: "password",
  newPassword: "next",
  currentPassword: "current",
  email: "email",
  phone: "phone",
  code: "code",
  displayName: "displayName",
  leadMinutes: "leadMinutes",
  reminderLeadMinutes: "leadMinutes",
  emailAlerts: "emailAlerts",
  textAlerts: "textAlerts",
  timezone: "timezone",
};

function fieldFor(error: ApiError): string | undefined {
  if (error.code.startsWith("turnstile")) return "turnstile";
  if (!error.field) return undefined;
  return FIELD_ALIASES[error.field] ?? error.field;
}

/**
 * Turn any rejection into the AccountError the page renders.
 *
 * `reauth-required` is special: the runner turns it into a toast with a "Confirm it's you" action, so the message has to
 * be short and the code has to be exact.
 */
function toAccountError(error: unknown, field?: string): unknown {
  if (!(error instanceof ApiError)) return error;
  const named = field ?? fieldFor(error);
  if (error.code === "reauthentication_required") {
    // The server's window has closed whatever this tab thought; stop showing a countdown that is not real.
    clearReauthWindow();
    return new AccountError(error.message || "Confirm it's you first, then try again.", "reauth-required");
  }
  if (error.code === "last_signin_method") return new AccountError(error.message, "last-method");
  if (error.status === 401) return new AccountError(error.message || "Sign in to continue.", "signed-out");
  if (error.status === 429) return new AccountError(error.message || "Too many attempts. Wait a few minutes and try again.", "rate-limited", named);
  if (error.status === 403 && error.code === "account_suspended") return new AccountError(error.message, "signed-out");
  return new AccountError(error.message, "invalid", named);
}

// ---- Composition -----------------------------------------------------------------------------------------------------------

const deviceTypeOf = (value: string | null): PasskeyInfo["deviceType"] =>
  value === "multiDevice" || value === "synced" ? "synced" : "device-bound";

function toPasskey(passkey: PasskeyPayload["passkeys"][number], index: number): PasskeyInfo {
  return {
    id: passkey.id,
    name: passkey.name?.trim() || `Passkey ${index + 1}`,
    deviceType: deviceTypeOf(passkey.deviceType),
    createdAt: passkey.createdAt,
  };
}

function settingsOf(payload: AccountPayload): NotificationSettings {
  return {
    timezone: payload.settings?.timezone || "UTC",
    leadMinutes: clampInt(payload.settings?.reminderLeadMinutes, 180, LEAD_MIN, LEAD_MAX),
    emailAlerts: payload.settings?.emailEnabled === true,
    textAlerts: payload.settings?.smsEnabled === true,
  };
}

/** The newest consent record, or an empty one. The table keeps history; the page shows the current agreement. */
function consentOf(payload: AccountPayload): AccountProfile["consent"] {
  const rows = [...(payload.consents ?? [])].sort((a, b) => String(b.accepted_at).localeCompare(String(a.accepted_at)));
  const latest = rows[0];
  if (!latest) return { version: null, acceptedAt: null };
  return { version: latest.terms_version ?? null, acceptedAt: latest.accepted_at ?? null };
}

/**
 * Build the page's single profile from the parallel reads.
 *
 * `methods` is the server's list of sign-in identities: 'password' when a password exists, and one entry per linked
 * provider. 'link' is not an identity row (it is implied by a verified email), so it is not counted here — the page
 * derives the email's contribution from `email.verified` itself (see account.ts `signInMethodCount`).
 */
function toProfile(account: AccountPayload, passkeys: PasskeyPayload | null): AccountProfile {
  const methods = account.methods ?? [];
  const providers = methods.filter((m): m is Provider => m === "apple" || m === "google");
  return {
    id: account.account.id,
    displayName: account.account.displayName,
    email: { address: account.account.email ?? null, verified: account.account.emailVerified === true },
    phone: {
      number: account.account.phone ?? null,
      verified: account.account.phoneVerified === true,
      // Only shown while a code is outstanding in this tab, and never once the number matches the verified one.
      pending: pendingPhone && pendingPhone !== account.account.phone ? pendingPhone : null,
    },
    hasPassword: methods.includes("password"),
    providers,
    passkeys: (passkeys?.passkeys ?? []).map(toPasskey),
    consent: consentOf(account),
    settings: settingsOf(account),
    reauthUntil,
  };
}

const clampInt = (value: unknown, fallback: number, min: number, max: number): number => {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.max(min, Math.min(max, n));
};

/** GET /account + GET /auth/passkeys in parallel, mapped onto the page's profile. */
async function readProfile(signal?: AbortSignal): Promise<AccountProfile> {
  const [account, passkeys] = await Promise.all([
    apiFetch<AccountPayload>("/api/account", { signal }),
    // A passkey read failing must not take the whole page down: an account can have none, and the list is secondary.
    apiFetch<PasskeyPayload>("/api/auth/passkeys", { signal }).catch((error: unknown) => {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) throw error;
      return { passkeys: [] } as PasskeyPayload;
    }),
  ]);
  return toProfile(account, passkeys);
}

/** Every mutation answers with the new profile, because the page renders whatever comes back. */
async function afterMutation(signal?: AbortSignal): Promise<AccountProfile> {
  return readProfile(signal);
}

// ---- Meta ---------------------------------------------------------------------------------------------------------------------

let metaCache: AccountMeta | null = null;

/**
 * What the page needs to know about the deployment.
 *
 * There is no `/account/meta` on the backend. The facts exist in two public endpoints instead:
 *   GET /auth/providers -> which channels are configured, and the Turnstile site key (`turnstile.siteKey`)
 *   GET /api/legal      -> the policy version in force (`currentVersion`)
 * Both are cacheable for the life of the page, so the account page's parallel load stays two round trips, not four.
 */
export async function getAccountMeta(signal?: AbortSignal): Promise<AccountMeta> {
  if (metaCache) return metaCache;
  const [providers, legal] = await Promise.all([
    getAuthProviders().catch(() => null),
    apiFetch<{ currentVersion?: string; version?: string }>("/api/legal", { signal }).catch(() => null),
  ]);
  const channels: Record<ChannelKey, boolean> = {
    email: providers ? providers.email : true,
    text: providers ? providers.sms : true,
  };
  metaCache = {
    policyVersion: legal?.currentVersion ?? legal?.version ?? POLICY_VERSION,
    channels,
    turnstileSiteKey: providers?.turnstileSiteKey ?? null,
  };
  // The account page's "Link Google / Link Apple" buttons follow what this deployment can actually do (see account.ts).
  setOAuthEnabled(providers ? providers.apple || providers.google : false);
  return metaCache;
}

/** Forget the cached meta (called after sign-out, so the next person's page re-reads the operator's switches). */
export function resetAccountMeta(): void {
  metaCache = null;
  setOAuthEnabled(false);
  pendingPhone = null;
  clearReauthWindow();
}

// ---- Profile ------------------------------------------------------------------------------------------------------------------

/**
 * GET /account, composed into AccountProfile. `quiet` only skips nothing on the wire — the page uses it for the refresh
 * that runs while a person is reading, and there is no cheaper read — but it is kept so the signature matches the demo's.
 */
export async function getProfile(signal?: AbortSignal, quiet = false): Promise<AccountProfile> {
  void quiet;
  try {
    return await readProfile(signal);
  } catch (error) {
    throw toAccountError(error);
  }
}

/**
 * POST /account/consent {consent:{termsVersion, privacyVersion, acceptedAt}}.
 *
 * The `version` argument is what the page displays; the record it writes is the server's current legal version, because
 * the endpoint only accepts its own (`LEGAL_VERSION` is a literal in the request schema). A page whose display string had
 * drifted would otherwise fail for a reason the person cannot act on.
 */
export async function saveConsent(version: string, signal?: AbortSignal): Promise<AccountProfile> {
  const current = (await getAccountMeta(signal)).policyVersion || version;
  try {
    await apiPost("/api/account/consent", { consent: { termsVersion: current, privacyVersion: current, acceptedAt: new Date().toISOString() } }, signal);
    return await afterMutation(signal);
  } catch (error) {
    throw toAccountError(error);
  }
}

/**
 * PUT /account/settings — timezone, travel window, cutoff, lead time and the two channel switches.
 *
 * The travel/cutoff rules live here (not on a shift), which is why the page's settings object carries them and the shift
 * adapter reads them from the same record.
 */
export async function saveSettings(settings: NotificationSettings, signal?: AbortSignal): Promise<AccountProfile> {
  if (!Number.isInteger(settings.leadMinutes) || settings.leadMinutes < LEAD_MIN || settings.leadMinutes > LEAD_MAX) {
    throw new AccountError(`Use a whole number from ${LEAD_MIN} to ${LEAD_MAX}.`, "invalid", "leadMinutes");
  }
  try {
    await apiFetch("/api/account/settings", {
      method: "PUT",
      signal,
      body: {
        timezone: settings.timezone,
        reminderLeadMinutes: settings.leadMinutes,
        emailEnabled: settings.emailAlerts,
        smsEnabled: settings.textAlerts,
      },
    });
    return await afterMutation(signal);
  } catch (error) {
    throw toAccountError(error);
  }
}

// ---- Email --------------------------------------------------------------------------------------------------------------------

/** POST /auth/email/verification — sends (or resends) the proof of the current address. */
export async function sendEmailVerification(signal?: AbortSignal): Promise<AccountProfile> {
  try {
    await apiPost("/api/auth/email/verification", {}, signal);
    return await afterMutation(signal);
  } catch (error) {
    throw toAccountError(error);
  }
}

/**
 * POST /auth/email/change {email}. The new address is not adopted until its link is confirmed, so the profile that comes
 * back still carries the old one — the page's "verify it" note is driven by `email.verified`.
 */
export async function changeEmail(email: string, signal?: AbortSignal): Promise<AccountProfile> {
  try {
    await apiPost("/api/auth/email/change", { email: email.trim() }, signal);
    return await afterMutation(signal);
  } catch (error) {
    throw toAccountError(error);
  }
}

/** DELETE /auth/email — refuses when the address is the last way in (409 `last_signin_method`). */
export async function removeEmail(signal?: AbortSignal): Promise<AccountProfile> {
  try {
    await apiFetch("/api/auth/email", { method: "DELETE", signal });
    return await afterMutation(signal);
  } catch (error) {
    throw toAccountError(error);
  }
}

// ---- Phone --------------------------------------------------------------------------------------------------------------------

/**
 * POST /auth/phone/verification {phone, turnstileToken}.
 *
 * The server gates this one hard: a fresh re-authentication, a verified email, per-account and per-network budgets, and
 * (when configured) a Turnstile token. Its refusals are specific and worth showing as they are.
 */
export async function sendPhoneCode(phone: string, turnstileToken: string | null, signal?: AbortSignal): Promise<AccountProfile> {
  try {
    await apiPost("/api/auth/phone/verification", { phone, turnstileToken: turnstileToken ?? undefined }, signal);
    pendingPhone = phone;
    return await afterMutation(signal);
  } catch (error) {
    throw toAccountError(error);
  }
}

/** POST /auth/phone/confirm {code}. */
export async function verifyPhone(code: string, signal?: AbortSignal): Promise<AccountProfile> {
  try {
    await apiPost("/api/auth/phone/confirm", { code: code.trim() }, signal);
    pendingPhone = null;
    return await afterMutation(signal);
  } catch (error) {
    throw toAccountError(error, error instanceof ApiError && error.field ? fieldFor(error) : "code");
  }
}

// ---- Name and password --------------------------------------------------------------------------------------------------------

/** PUT /account {displayName}. The session's copy of the name is updated too, so the greeting agrees. */
export async function saveName(displayName: string, signal?: AbortSignal): Promise<AccountProfile> {
  try {
    const payload = await apiFetch<{ id: string; displayName: string }>("/api/account", {
      method: "PUT",
      signal,
      body: { displayName },
    });
    renameCurrentAccount(payload.displayName);
    return await afterMutation(signal);
  } catch (error) {
    throw toAccountError(error);
  }
}

/**
 * Add or change the password.
 *
 * The page sends either `{next}` (no password yet) or `{current, next}` (change). The backend has two routes for the two
 * cases, and both take `newPassword`; the current one is `currentPassword` and only exists on change.
 */
export async function setPassword(input: { current?: string; next: string }, signal?: AbortSignal): Promise<AccountProfile> {
  if (input.next.length < PASSWORD_MIN) throw new AccountError(`Use at least ${PASSWORD_MIN} characters.`, "invalid", "next");
  const profile = await getProfile(undefined, true).catch(() => null);
  const hasPassword = profile?.hasPassword === true;
  try {
    if (hasPassword) {
      await apiPost("/api/auth/password/change", { currentPassword: input.current ?? "", newPassword: input.next }, signal);
    } else {
      await apiPost("/api/auth/password/add", { newPassword: input.next }, signal);
    }
    return await afterMutation(signal);
  } catch (error) {
    if (error instanceof ApiError) {
      // "That current password isn't right" belongs under the current field; a weak new one under the new field.
      const currentProblem = error.code === "invalid_credentials" || error.code === "password_required" || error.code === "no_password_set";
      throw toAccountError(error, currentProblem && hasPassword ? "current" : "next");
    }
    throw toAccountError(error);
  }
}

/** DELETE /auth/password — refuses when it is the last way in. */
export async function removePassword(signal?: AbortSignal): Promise<AccountProfile> {
  try {
    await apiFetch("/api/auth/password", { method: "DELETE", signal });
    return await afterMutation(signal);
  } catch (error) {
    throw toAccountError(error);
  }
}

// ---- Passkeys -------------------------------------------------------------------------------------------------------------------

/**
 * Add a passkey: POST /auth/passkey/add/options -> the browser's prompt -> POST /auth/passkey/add/verify.
 *
 * Both steps require a re-authentication inside the last ten minutes, so a 403 `reauthentication_required` here sends the
 * page to "Confirm it's you" — that is the `reauth-required` code, not an error worth a bad password.
 */
export async function addPasskey(name: string, signal?: AbortSignal): Promise<AccountProfile> {
  const label = name.trim().replace(/\s+/g, " ");
  if ([...label].length > PASSKEY_NAME_MAX) throw new AccountError(`Use ${PASSKEY_NAME_MAX} characters or fewer.`, "invalid", "passkeyName");
  try {
    const options = await apiPost("/api/auth/passkey/add/options", {}, signal);
    const credential = await ceremony(() => createPasskey(options as Parameters<typeof createPasskey>[0], signal));
    await apiPost("/api/auth/passkey/add/verify", { credential, ...(label ? { passkeyName: label } : {}) }, signal);
    return await afterMutation(signal);
  } catch (error) {
    throw ceremonyAware(error);
  }
}

/** PUT /auth/passkeys/:id {name} — renaming needs no ceremony and no fresh proof. */
export async function renamePasskey(id: string, name: string, signal?: AbortSignal): Promise<AccountProfile> {
  const label = name.trim().replace(/\s+/g, " ");
  if (!label) throw new AccountError("Give the passkey a name.", "invalid", "passkeyName");
  if ([...label].length > PASSKEY_NAME_MAX) throw new AccountError(`Use ${PASSKEY_NAME_MAX} characters or fewer.`, "invalid", "passkeyName");
  try {
    await apiFetch(`/api/auth/passkeys/${encodeURIComponent(id)}`, { method: "PUT", body: { name: label }, signal });
    return await afterMutation(signal);
  } catch (error) {
    throw toAccountError(error);
  }
}

/** DELETE /auth/passkeys/:id — needs fresh proof, and is refused when it would remove the last way in. */
export async function removePasskey(id: string, signal?: AbortSignal): Promise<AccountProfile> {
  try {
    await apiFetch(`/api/auth/passkeys/${encodeURIComponent(id)}`, { method: "DELETE", signal });
    return await afterMutation(signal);
  } catch (error) {
    throw toAccountError(error);
  }
}

/** Run a WebAuthn ceremony, turning a cancelled prompt into an AccountError instead of a raw DOMException. */
async function ceremony<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof CeremonyError) throw new AccountError(error.message, "invalid", "passkey");
    throw error;
  }
}

/** A cancelled prompt is a sentence, not a stack trace; everything else goes through the normal mapping. */
function ceremonyAware(error: unknown): unknown {
  if (error instanceof ApiError) return toAccountError(error);
  if (error instanceof Error && (error.name === "CeremonyError" || error.name === "NotAllowedError")) {
    return new AccountError(error.message, "invalid");
  }
  return error;
}

// ---- "Confirm it's you" ---------------------------------------------------------------------------------------------------------

/** POST /auth/reauthenticate {method:'password', password}. A success opens the ten-minute window this tab mirrors. */
export async function reauthWithPassword(password: string, signal?: AbortSignal): Promise<AccountProfile> {
  try {
    await apiPost("/api/auth/reauthenticate", { method: "password", password }, signal);
    setReauthWindow();
    return await afterMutation(signal);
  } catch (error) {
    throw toAccountError(error, "password");
  }
}

/** POST /auth/reauthenticate/passkey/options -> prompt -> POST /auth/reauthenticate {method:'passkey', credential}. */
export async function reauthWithPasskey(signal?: AbortSignal): Promise<AccountProfile> {
  try {
    const options = await apiPost("/api/auth/reauthenticate/passkey/options", {}, signal);
    const credential = await ceremony(() => getPasskey(options as Parameters<typeof getPasskey>[0], signal));
    await apiPost("/api/auth/reauthenticate", { method: "passkey", credential }, signal);
    setReauthWindow();
    return await afterMutation(signal);
  } catch (error) {
    throw ceremonyAware(error);
  }
}

/**
 * POST /auth/reauthenticate/link — an emailed step-up for accounts with no password and no passkey.
 *
 * The link is bound to this browser and this account, and redeeming it steps the CURRENT session up rather than starting
 * a new one. Nothing changes until it is opened, which is why the page watches the profile for a few minutes.
 */
export async function sendReauthLink(signal?: AbortSignal): Promise<AccountProfile> {
  try {
    await apiPost("/api/auth/reauthenticate/link", {}, signal);
    return await afterMutation(signal);
  } catch (error) {
    throw toAccountError(error);
  }
}

/** DELETE /auth/providers/:provider — refused when it is the last way in. */
export async function unlinkProvider(provider: Provider, signal?: AbortSignal): Promise<AccountProfile> {
  try {
    await apiFetch(`/api/auth/providers/${provider}`, { method: "DELETE", signal });
    return await afterMutation(signal);
  } catch (error) {
    throw toAccountError(error);
  }
}

// ---- Sessions ---------------------------------------------------------------------------------------------------------------------

function toSession(session: SessionsPayload["sessions"][number]): SessionInfo {
  return {
    id: session.id,
    current: session.current === true,
    userAgent: session.userAgent ?? "",
    lastSeenAt: session.lastSeenAt ?? session.createdAt,
  };
}

/** GET /auth/sessions. The id is a sha256 handle, not the session id itself. */
export async function listSessions(signal?: AbortSignal): Promise<SessionInfo[]> {
  try {
    const payload = await apiFetch<SessionsPayload>("/api/auth/sessions", { signal });
    return payload.sessions.map(toSession);
  } catch (error) {
    throw toAccountError(error);
  }
}

/** DELETE /auth/sessions/:id — the id must be the 64-character handle /auth/sessions returned. */
export async function revokeSession(id: string, signal?: AbortSignal): Promise<SessionInfo[]> {
  try {
    await apiFetch(`/api/auth/sessions/${encodeURIComponent(id)}`, { method: "DELETE", signal });
    return await listSessions(signal);
  } catch (error) {
    throw toAccountError(error);
  }
}

/** POST /auth/sessions/others — ends every session but this one. */
export async function signOutOthers(signal?: AbortSignal): Promise<SessionInfo[]> {
  try {
    await apiPost("/api/auth/sessions/others", {}, signal);
    return await listSessions(signal);
  } catch (error) {
    throw toAccountError(error);
  }
}

// ---- History ------------------------------------------------------------------------------------------------------------------------

/**
 * The labels for the account-scoped change log.
 *
 * The server stores `kind` (a stable code) and a nullable `detail`; it does not store prose, because prose in a database
 * goes stale the moment the copy changes. The sentence is therefore built here, which also means a new kind the page does
 * not know yet still renders as something readable rather than a raw identifier.
 */
const KIND_LABELS: Record<string, string> = {
  password_added: "Password added",
  password_changed: "Password changed",
  password_removed: "Password removed",
  password_reset: "Password reset from an email link",
  passkey_added: "Passkey added",
  passkey_removed: "Passkey removed",
  email_confirmed: "Email address verified",
  email_removed: "Email address removed",
  phone_confirmed: "Phone number verified",
  provider_linked: "A sign-in provider was linked",
  provider_unlinked: "A sign-in provider was unlinked",
  account_created: "Account created",
  email_changed: "Email address changed",
  sessions_revoked: "Other devices were signed out",
};

const summarise = (kind: string): string => {
  if (KIND_LABELS[kind]) return KIND_LABELS[kind]!;
  // "some_kind_code" -> "Some kind code"
  const words = kind.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Account changed";
};

/**
 * The reminder kinds the scheduler can produce (server/scheduler.ts `snapshot`): a clash between two shifts (overlap or
 * a tight travel window) and a closing cancellation cutoff. Anything else falls back to a plain "Shift alert".
 */
const REMINDER_SUBJECTS: Record<string, string> = {
  overlap: "Overlapping shifts",
  tight: "Tight travel window",
  cancellation: "Cancellation window closing",
  shift_reminder: "Shift reminder",
};

/**
 * Collapse the server's delivery states into the page's three.
 *
 *   accepted             delivered/accepted by the provider
 *   failed               dead, expired after retries, or a provider error
 *   skipped              queued (not sent yet), suppressed (superseded, shift deleted, no longer applicable)
 *
 * "Skipped" is the honest label for all of those under a three-value model: none of them is a delivery, and none of them
 * is a failure the person has to act on. `acceptedAt` is the server's word on acceptance and wins over `status`.
 */
function statusOf(reminder: RemindersPayload["reminders"][number]): AlertStatus {
  if (reminder.acceptedAt || reminder.sentAt) return "accepted";
  const status = (reminder.status ?? "").toLowerCase();
  if (status === "accepted" || status === "delivered" || status === "sent") return "accepted";
  if (status === "dead" || status === "failed" || status === "bounced" || status === "complained" || status === "error") return "failed";
  return "skipped";
}

/**
 * GET /auth/security-events + GET /shifts/reminders, merged into the page's History.
 *
 * Two separate endpoints, one panel: the security list is the account-scoped change log (latest 50) and the reminders are
 * the alert log (latest 50). Neither is paginated further by the backend, which matches the page's own HISTORY_LIMIT.
 */
export async function listHistory(signal?: AbortSignal): Promise<History> {
  const [events, reminders] = await Promise.all([
    apiFetch<SecurityEventsPayload>("/api/auth/security-events", { signal }),
    apiFetch<RemindersPayload>("/api/shifts/reminders", { signal }).catch((error: unknown) => {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) throw error;
      return { reminders: [] } as RemindersPayload;
    }),
  ]);

  const security: SecurityEvent[] = (events.events ?? []).slice(0, HISTORY_LIMIT).map((event) => ({
    id: event.id,
    summary: summarise(event.kind),
    at: event.created_at,
  }));

  const alerts: AlertRecord[] = (reminders.reminders ?? []).slice(0, HISTORY_LIMIT).map((reminder) => ({
    id: reminder.id,
    channel: reminder.channel === "sms" ? "text" : "email",
    subject: REMINDER_SUBJECTS[reminder.kind] ?? "Shift alert",
    status: statusOf(reminder),
    at: reminder.acceptedAt ?? reminder.scheduledFor,
  }));

  return { security, alerts };
}

// ---- Data: export and deletion -------------------------------------------------------------------------------------------------------

/** GET /account/export. The page turns whatever comes back into the phylax-data.json download. */
export async function exportData(signal?: AbortSignal): Promise<unknown> {
  try {
    return await apiFetch<unknown>("/api/account/export", { signal });
  } catch (error) {
    throw toAccountError(error);
  }
}

/**
 * DELETE /account {password?}.
 *
 * Needs a live session, proof of presence inside ten minutes, and the password when the account has one. It does NOT end
 * the local session here: the caller navigates away first and then calls `finishAccountDeletion()`, so the page never
 * re-renders as "signed out" on its way out.
 */
export async function deleteAccount(input: { password?: string }, signal?: AbortSignal): Promise<void> {
  try {
    await apiFetch("/api/account", { method: "DELETE", body: input.password ? { password: input.password } : {}, signal });
  } catch (error) {
    throw toAccountError(error, "password");
  }
}

/** Ends the deleted account's session on this device (flips useAuth). Call it right after navigating away. */
export function finishAccountDeletion(): void {
  resetAccountMeta();
  removeCurrentAccount();
}


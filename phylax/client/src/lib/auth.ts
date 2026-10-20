/**
 * Auth adapter: the sign-in page (pages/Login.tsx), the account sequence (pages/Onboarding.tsx), the recovery page
 * (pages/Recovery.tsx: forgot / reset a password, confirm an email, redeem a sign-in link) and the account page's
 * idea of who is signed in.
 *
 * This is the REAL adapter. It talks to the Phylax API through lib/apiClient.ts (same-origin cookies, CSRF double
 * submit, `{error:{code,message,field}}` envelopes) and keeps the contract the pages were written against:
 *
 *   - resolve AuthOutcome -> what happened (see below)
 *   - reject AuthError    -> shown to the person; `field` pins it under that input, otherwise it is a form-level message
 *   - reject TokenError   -> the link or code is dead (expired, used, or never existed)
 *   - reject AbortError   -> the person cancelled (swallowed silently)
 *   - reject anything else -> treated as a network failure ("Couldn't reach Phylax")
 *
 * Every call takes an AbortSignal so cancelling the passkey prompt (or leaving the page) stops the work.
 *
 * SESSION. The session is an httpOnly first-party cookie the browser cannot read, so who is signed in is a question only
 * the server can answer. `hydrateAuth()` asks it once at boot (GET /auth/session), and the answer is kept in a small
 * store that `useAuth()` subscribes to. `getCurrentAccount()` stays synchronous — it reads that store — which is why the
 * router holds the signed-in pages until `hydrateAuth()` has resolved (see components/RequireSession.tsx).
 *
 * ACCOUNTS. There is no password sign-up, on purpose and by design: the backend refuses to register an address from a
 * sign-in attempt, because doing so would turn the sign-in form into a way of finding out which addresses have accounts.
 * Every account starts from something that proves ownership — a link sent to an address (POST /auth/magic-link, then
 * POST /auth/magic-link/redeem), a provider (Apple / Google), or a passkey ceremony — and a password is added afterwards
 * from the account page (POST /auth/password/add). So `signInWithPassword` never answers "needs-account": wrong or
 * unknown credentials are the same generic 401, and the message tells the person to create an account with an email link.
 *
 * "needs-account" still exists as an outcome, and it is still what starts the account sequence at /welcome. It arrives
 * from `redeemSignInLink` (an address nobody has claimed) and from `signInWithPasskey` (an authenticator nobody has
 * registered) — never from an email typed into a form.
 */

import { ApiError, apiFetch, apiPost, bootstrapCsrf, csrfToken, isAbortError, withQuery } from "./apiClient";
import { createPasskey, getPasskey, CeremonyError } from "./webauthn";
import { POLICY_VERSION } from "./legal";

// ---- Types the pages import --------------------------------------------------------------------------------------------

export type Provider = "apple" | "google";

/**
 * How an account can begin. `password` is deliberately absent: the backend does not create accounts from a typed
 * password, so a password can only ever be added to an account that already exists.
 */
export type SignUpMethod = "passkey" | "link" | Provider;

export class AuthError extends Error {
  field?: "email" | "password" | "displayName";
  /** The API's stable code, when there was one (`invalid_credentials`, `link_wrong_browser`, `too_many_attempts`, ...). */
  code?: string;
  constructor(message: string, field?: "email" | "password" | "displayName", code?: string) {
    super(message);
    this.name = "AuthError";
    this.field = field;
    this.code = code;
  }
}

/** The link or token is not valid any more (expired, already used, or never existed). */
export class TokenError extends AuthError {
  constructor(message: string) {
    super(message);
    this.name = "TokenError";
  }
}

/** Who is about to get an account. Nothing secret: it only tells the page which sign-in method and email to show. */
export interface PendingSignup {
  method: SignUpMethod;
  email?: string;
  /** The name the provider already knows, when it sent one (Apple does, once). The page can pre-fill from it. */
  displayName?: string;
}

export type AuthOutcome =
  | { status: "signed-in" }
  | { status: "link-sent" }
  | { status: "needs-account"; pending: PendingSignup };

/** What the person agreed to, and when. The server stamps its own time as well; this is the client's record. */
export interface Consent {
  termsVersion: string;
  privacyVersion: string;
  acceptedAt: string;
}

/**
 * The payload that finalises the account record.
 *
 * `timezone` is required BY THE SERVER (POST /account stores it; every reminder time is computed in it), so it is part
 * of this type. It is optional here because the account sequence does not ask for it — the adapter fills in the zone the
 * device reports, which is the only zone Phylax can be sure of at that moment. The account page lets it be corrected.
 */
export interface AccountInput {
  displayName: string;
  consent: Consent;
  timezone?: string;
}

export interface Account {
  id: string;
  displayName: string;
}

/** What `GET /auth/providers` says this deployment can actually do. */
export interface AuthProviders {
  apple: boolean;
  google: boolean;
  passkey: boolean;
  email: boolean;
  sms: boolean;
  turnstileSiteKey: string | null;
}

/** The zone the device reports, or "UTC" when the browser will not say. */
export function detectedZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

// ---- The session store ------------------------------------------------------------------------------------------------

export type AuthStatus = "loading" | "authenticated" | "unauthenticated";

export interface AuthSnapshot {
  status: AuthStatus;
  account: Account | null;
}

/**
 * The one snapshot object. `useSyncExternalStore` compares snapshots with `Object.is`, so this is replaced ONLY when
 * something actually changed — returning a fresh object per call would re-render forever.
 */
let snapshot: AuthSnapshot = { status: "loading", account: null };

const listeners = new Set<() => void>();

function publish(next: AuthSnapshot): void {
  if (next.status === snapshot.status && next.account?.id === snapshot.account?.id && next.account?.displayName === snapshot.account?.displayName) return;
  snapshot = next;
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* a listener that throws must not stop the others */
    }
  }
}

/** The current snapshot, for `useAuth` (hooks/useAuth.ts). */
export const getAuthSnapshot = (): AuthSnapshot => snapshot;

/** The status alone: "loading" until the first `hydrateAuth()` has answered. */
export const getAuthStatus = (): AuthStatus => snapshot.status;

/**
 * Who is signed in on this device, or null when nobody is. Synchronous because the pages call it while rendering; it is
 * only truthful once `hydrateAuth()` has resolved, and the signed-in routes wait for that.
 */
export function getCurrentAccount(): Account | null {
  return snapshot.account;
}

/** Called whenever the session may have changed. Returns the unsubscribe function. */
export function subscribeToAuth(onChange: () => void): () => void {
  listeners.add(onChange);
  // The session is a cookie, so another tab signing in or out changes nothing this tab can observe; but coming back from
  // the back/forward cache can, so re-hydrate then.
  const onPageShow = (event: PageTransitionEvent) => {
    if (event.persisted) void hydrateAuth();
  };
  window.addEventListener("pageshow", onPageShow);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("pageshow", onPageShow);
  };
}

type SessionPayload = {
  account: { id: string; displayName: string; email: string | null; emailVerified: boolean } | null;
};

/**
 * Ask the server who is signed in, and publish the answer.
 *
 * This is also what mints the CSRF cookie, so it is the first call the app makes. It never throws: an unreachable server
 * leaves the person looking signed out (and the pages say "couldn't reach Phylax" when they try to act), which is better
 * than a boot screen that never finishes.
 */
export async function hydrateAuth(): Promise<AuthStatus> {
  await bootstrapCsrf();
  try {
    const payload = await apiFetch<SessionPayload>("/api/auth/session");
    const account = payload.account ? { id: payload.account.id, displayName: payload.account.displayName } : null;
    sessionEmail = payload.account?.email ?? null;
    sessionEmailVerified = payload.account?.emailVerified ?? false;
    publish({ status: account ? "authenticated" : "unauthenticated", account });
  } catch (error) {
    if (isAbortError(error)) throw error;
    // A 503 (database not configured) or a network failure both read as "signed out" here; the pages will surface it.
    publish({ status: "unauthenticated", account: null });
  }
  return snapshot.status;
}

/** The signed-in address, from the session answer. The account page reads the full record for itself. */
let sessionEmail: string | null = null;
let sessionEmailVerified = false;
export const getSessionEmail = (): string | null => sessionEmail;
export const getSessionEmailVerified = (): boolean => sessionEmailVerified;

/** Update the cached display name after the account page renames it, so every greeting agrees without a round trip. */
export function renameCurrentAccount(displayName: string): void {
  if (!snapshot.account) return;
  publish({ status: "authenticated", account: { ...snapshot.account, displayName } });
}

/** Forget the session locally. The server has already ended it (signOut) or there is nothing left to end (deletion). */
export function removeCurrentAccount(): void {
  sessionEmail = null;
  sessionEmailVerified = false;
  pendingCache = null;
  publish({ status: "unauthenticated", account: null });
}

/**
 * End the session: POST /auth/logout clears the session cookie and the pending sign-up on the server, then the local
 * snapshot is cleared so everything showing the signed-in state updates at once.
 */
export async function signOut(signal?: AbortSignal): Promise<void> {
  try {
    await apiPost("/api/auth/logout", {}, signal);
  } catch (error) {
    // A logout that cannot reach the server still has to leave this tab signed out, or the person is stuck. The cookie
    // stays until it expires, but every page here reads the snapshot.
    if (isAbortError(error)) throw error;
  }
  removeCurrentAccount();
}

// ---- Providers and the legal version ------------------------------------------------------------------------------------

let providersCache: AuthProviders | null = null;
let providersPromise: Promise<AuthProviders> | null = null;

/**
 * What this deployment offers (GET /auth/providers). Cached, because the sign-in buttons and the account page both ask
 * and the answer only changes when the operator redeploys.
 */
export function getAuthProviders(signal?: AbortSignal): Promise<AuthProviders> {
  if (providersCache) return Promise.resolve(providersCache);
  if (!providersPromise) {
    providersPromise = apiFetch<{
      providers: Record<string, boolean>;
      passkey: boolean;
      email: boolean;
      sms: boolean;
      turnstile: { siteKey: string } | null;
    }>("/api/auth/providers", { signal: undefined })
      .then((payload) => {
        const value: AuthProviders = {
          apple: payload.providers?.apple === true,
          google: payload.providers?.google === true,
          passkey: payload.passkey !== false,
          email: payload.email !== false,
          sms: payload.sms !== false,
          turnstileSiteKey: payload.turnstile?.siteKey ?? null,
        };
        providersCache = value;
        return value;
      })
      .catch((error: unknown) => {
        providersPromise = null;
        throw error;
      });
  }
  // The caller's own signal is not passed into the shared request on purpose: one page aborting must not cancel the
  // answer for the next one.
  void signal;
  return providersPromise;
}

/** True when the operator has fully configured that provider (both keys). */
export async function isProviderAvailable(provider: Provider): Promise<boolean> {
  try {
    const providers = await getAuthProviders();
    return providers[provider];
  } catch {
    return false;
  }
}

let legalVersionCache: string | null = null;

/**
 * The policy version the server will actually accept.
 *
 * The consent record is validated against the backend's own `LEGAL_VERSION` (a zod literal), and `/api/legal` publishes
 * it. The page's own strings (TERMS_VERSION / PRIVACY_VERSION) are display metadata; if they ever drift from the
 * server's, a consent POST would be refused for a reason the person cannot act on. So the adapter sends the server's
 * version, and the record says exactly what the server holds.
 */
export async function legalVersion(signal?: AbortSignal): Promise<string> {
  if (legalVersionCache) return legalVersionCache;
  try {
    const payload = await apiFetch<{ currentVersion?: string; version?: string }>("/api/legal", { signal });
    const value = payload.currentVersion ?? payload.version;
    if (typeof value === "string" && value) {
      legalVersionCache = value;
      return value;
    }
  } catch (error) {
    if (isAbortError(error)) throw error;
  }
  return POLICY_VERSION;
}

// ---- The pending sign-up -----------------------------------------------------------------------------------------------

let pendingCache: PendingSignup | null = null;
let pendingLoaded = false;

type PendingPayload = {
  pending: { id: string; method: string; email: string | null; provider: string | null; displayName: string | null; expiresAt: string } | null;
};

/**
 * Map the server's pending record onto the page's shape.
 *
 * The server keeps `method` and `provider` apart (a provider sign-up has method "apple" AND provider "apple"; a link
 * sign-up has method "link" and no provider). The page only needs one word, so a provider wins when there is one.
 */
function toPendingSignup(pending: NonNullable<PendingPayload["pending"]>): PendingSignup {
  const provider = pending.provider === "apple" || pending.provider === "google" ? pending.provider : null;
  const method: SignUpMethod = provider ?? (pending.method === "passkey" ? "passkey" : "link");
  const email = pending.email ?? undefined;
  const displayName = pending.displayName ?? undefined;
  return { method, ...(email ? { email } : {}), ...(displayName ? { displayName } : {}) };
}

/**
 * Read the pending sign-up from the server (GET /auth/pending) and cache it.
 *
 * The server holds it in a signed cookie plus a row with a fifteen-minute expiry, so it survives a reload — which is the
 * whole point: somebody who refreshes halfway through the account sequence is not told their sign-in timed out.
 */
export async function loadPendingSignup(signal?: AbortSignal): Promise<PendingSignup | null> {
  try {
    const payload = await apiFetch<PendingPayload>("/api/auth/pending", { signal });
    pendingCache = payload.pending ? toPendingSignup(payload.pending) : null;
    pendingLoaded = true;
    return pendingCache;
  } catch (error) {
    if (isAbortError(error)) throw error;
    return pendingCache;
  }
}

/**
 * The sign-up that is waiting for its account, or null when there is none.
 *
 * Synchronous because the account page reads it while rendering. `hydrateAuth()` warms it at boot, so it is accurate for
 * a page that arrives from an email link or a provider redirect. A `null` before that first read is ambiguous (it may
 * simply not have been asked yet), which is why Onboarding awaits `refreshPendingSignup()` when it opens.
 */
export function getPendingSignup(): PendingSignup | null {
  return pendingCache;
}

/** True once the server has answered "is there a pending sign-up?" at least once this page load. */
export const hasLoadedPendingSignup = (): boolean => pendingLoaded;

/** Ask again (the account page calls this on mount, so a reload mid-sequence still knows what it is creating). */
export async function refreshPendingSignup(signal?: AbortSignal): Promise<PendingSignup | null> {
  pendingLoaded = false;
  return loadPendingSignup(signal);
}

/** The person backed out: the row and the cookie both go (POST /auth/pending/discard). */
export function discardPendingSignup(): void {
  pendingCache = null;
  pendingLoaded = false;
  // Fire and forget: the page is navigating away, and a failure here only leaves a row that expires on its own.
  void apiPost("/api/auth/pending/discard", {}).catch(() => undefined);
}

// ---- Error translation --------------------------------------------------------------------------------------------------

/** Turn an ApiError into the AuthError the pages show, keeping the field when the server pinned one. */
function toAuthError(error: unknown): unknown {
  if (!(error instanceof ApiError)) return error;
  const field = error.field === "email" || error.field === "password" || error.field === "displayName" ? error.field : undefined;
  if (error.status === 429) return new AuthError(error.message || "Too many attempts. Wait a few minutes and try again.", field, error.code);
  return new AuthError(error.message, field, error.code);
}

/** The dead-token codes the API uses for an expired, used or unknown link. */
const DEAD_TOKEN_CODES = new Set(["token_invalid", "token_required", "link_invalid", "invalid_token", "token_expired"]);

function toTokenAwareError(error: unknown, deadMessage: string): unknown {
  if (error instanceof ApiError && DEAD_TOKEN_CODES.has(error.code)) return new TokenError(error.message || deadMessage);
  return toAuthError(error);
}

// ---- Sign-in ------------------------------------------------------------------------------------------------------------

/**
 * POST /auth/password {email, password}.
 *
 * There is no "needs-account" branch. The server answers an unknown address and a wrong password with the SAME 401
 * `invalid_credentials`, which is the point: the form cannot be used to find out who has an account. The message it
 * sends already says how to get one ("create your account with an email link").
 */
export async function signInWithPassword(creds: { email: string; password: string }, signal?: AbortSignal): Promise<AuthOutcome> {
  try {
    await apiPost<{ status: string }>("/api/auth/password", { email: creds.email.trim(), password: creds.password }, signal);
  } catch (error) {
    throw toAuthError(error);
  }
  await hydrateAuth();
  return { status: "signed-in" };
}

/**
 * POST /auth/magic-link {email}.
 *
 * The answer is always `link-sent`, whether or not that address has an account — asking is not a way to find out. An
 * address nobody has claimed becomes a pending sign-up when the link is REDEEMED (see `redeemSignInLink`), not when it
 * is requested, so "needs-account" cannot be reported here.
 */
export async function sendMagicLink(email: string, signal?: AbortSignal): Promise<AuthOutcome> {
  try {
    await apiPost<{ status: string }>("/api/auth/magic-link", { email: email.trim() }, signal);
  } catch (error) {
    throw toAuthError(error);
  }
  return { status: "link-sent" };
}

/**
 * Start Apple / Google: a full-page redirect to GET /auth/oauth/:provider/start?redirect=...
 *
 * The provider's callback decides on the server whether the account exists. A known account comes back signed in at
 * `redirect`; an unknown one is redirected to /welcome with a pending sign-up. A provider that is not configured (no
 * client id/secret on the server) answers 503 rather than a JSON body in the address bar, so it is checked first and
 * reported as a normal error.
 *
 * The promise never settles: the browser is leaving. That keeps the sign-in sheet in its busy state until the page
 * unloads, instead of flashing a state for a call that has not finished.
 */
export async function signInWithProvider(provider: Provider, signal?: AbortSignal): Promise<AuthOutcome> {
  void signal;
  const available = await isProviderAvailable(provider);
  if (!available) {
    const name = provider === "apple" ? "Apple" : "Google";
    throw new AuthError(`${name} sign-in isn't available right now. Use an email link or a passkey instead.`, undefined, "provider_not_configured");
  }
  window.location.assign(oauthStartUrl(provider, "/dashboard"));
  return new Promise<AuthOutcome>(() => {
    /* the page unloads; nothing here will run */
  });
}

/** Where a provider flow starts, and where it should land afterwards (a same-site path only — the server enforces it too). */
export function oauthStartUrl(provider: Provider, redirect = "/dashboard"): string {
  return withQuery(`/api/auth/oauth/${provider}/start`, { redirect });
}

/**
 * A passkey sign-in: options -> the browser's prompt -> the assertion.
 *
 *   POST /auth/passkey/options  -> PublicKeyCredentialRequestOptions (a discoverable-credential request, so the browser
 *                                  can offer the passkey without being told which one)
 *   navigator.credentials.get   -> the operating system's Face ID / fingerprint / security-key prompt
 *   POST /auth/passkey/verify   -> {status:"signed-in"} or {status:"needs-account"} when no account owns that credential
 */
export async function signInWithPasskey(signal?: AbortSignal): Promise<AuthOutcome> {
  let options: unknown;
  try {
    options = await apiPost("/api/auth/passkey/options", {}, signal);
  } catch (error) {
    throw toAuthError(error);
  }
  const credential = await ceremony(() => getPasskey(options as Parameters<typeof getPasskey>[0], signal));
  let result: { status?: string };
  try {
    result = await apiPost<{ status?: string }>("/api/auth/passkey/verify", { credential }, signal);
  } catch (error) {
    throw toAuthError(error);
  }
  if (result.status === "needs-account") {
    await loadPendingSignup(signal);
    return { status: "needs-account", pending: { method: "passkey" } };
  }
  await hydrateAuth();
  return { status: "signed-in" };
}

/** A cancelled or failed ceremony is an AuthError to the page, not an unhandled DOMException. */
async function ceremony<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isAbortError(error)) throw error;
    if (error instanceof CeremonyError) throw new AuthError(error.message, undefined, error.reason);
    throw error;
  }
}

// ---- Account creation ---------------------------------------------------------------------------------------------------

/**
 * Finish the account for the pending sign-up, in one call.
 *
 *   link / provider   POST /account          { displayName, timezone, consent }
 *   passkey           POST /auth/passkey/register/options -> ceremony -> POST /auth/passkey/register/verify
 *                     (the account and its first passkey are written in one transaction server-side)
 *
 * The identity being claimed comes from the server's pending sign-up (a signed cookie), never from this payload.
 */
export async function createAccount(input: AccountInput, signal?: AbortSignal): Promise<Account> {
  const pending = pendingCache ?? (await loadPendingSignup(signal));
  if (!pending) throw new AuthError("Your sign-in timed out. Go back to the sign-in page and start again.");

  const version = await legalVersion(signal);
  const consent: Consent = {
    termsVersion: version,
    privacyVersion: version,
    acceptedAt: input.consent.acceptedAt || new Date().toISOString(),
  };
  const timezone = input.timezone ?? detectedZone();

  try {
    const account =
      pending.method === "passkey"
        ? await createAccountWithPasskey(input.displayName, consent, timezone, signal)
        : await apiPost<{ id: string; displayName: string }>("/api/account", { displayName: input.displayName, timezone, consent }, signal);
    pendingCache = null;
    await hydrateAuth();
    // The server has started the session; publish it even if the session read raced the write.
    if (!snapshot.account) publish({ status: "authenticated", account: { id: account.id, displayName: account.displayName } });
    return { id: account.id, displayName: account.displayName };
  } catch (error) {
    throw toAuthError(error);
  }
}

async function createAccountWithPasskey(displayName: string, consent: Consent, timezone: string, signal?: AbortSignal): Promise<{ id: string; displayName: string }> {
  const options = await apiPost("/api/auth/passkey/register/options", {}, signal);
  const credential = await ceremony(() => createPasskey(options as Parameters<typeof createPasskey>[0], signal));
  return apiPost<{ id: string; displayName: string }>(
    "/api/auth/passkey/register/verify",
    { credential, displayName, consent, timezone },
    signal,
  );
}

// ---- Recovery: forgot / reset a password, confirm an email, redeem a sign-in link ---------------------------------------

/**
 * POST /auth/password/forgot {email}. ALWAYS resolves the same way whether or not an account exists, so the page cannot
 * be used to find out who has one.
 */
export async function requestPasswordReset(email: string, signal?: AbortSignal): Promise<void> {
  try {
    await apiPost("/api/auth/password/forgot", { email: email.trim() }, signal);
  } catch (error) {
    throw toAuthError(error);
  }
}

/**
 * POST /auth/password/reset {token, newPassword}.
 *
 * The field is `newPassword` on the wire (the page's own argument is still called `password`). A dead link is a
 * TokenError so the page offers "Request a new link"; a weak or breached password is an AuthError pinned under the field.
 */
export async function resetPassword(input: { token: string; password: string }, signal?: AbortSignal): Promise<void> {
  try {
    await apiPost("/api/auth/password/reset", { token: input.token, newPassword: input.password }, signal);
  } catch (error) {
    if (error instanceof ApiError && (error.code === "password_too_short" || error.code === "password_breached" || error.code === "password_too_long")) {
      throw new AuthError(error.message, "password", error.code);
    }
    throw toTokenAwareError(error, "This reset link has expired or was already used. Request a new one.");
  }
}

/**
 * POST /auth/email/confirm {token}.
 *
 * `credentialsReset` means confirming this address wiped credentials that were set up on an unverified address (the
 * provisional-takeover guard) — the person must sign in by link and set a new password. The page calls that
 * `provisionalCleared` and shows its own notice for it.
 */
export async function confirmEmail(token: string, signal?: AbortSignal): Promise<{ provisionalCleared: boolean }> {
  try {
    const payload = await apiPost<{ status?: string; credentialsReset?: boolean }>("/api/auth/email/confirm", { token }, signal);
    return { provisionalCleared: payload.credentialsReset === true };
  } catch (error) {
    throw toTokenAwareError(error, "This confirmation link has expired or was already used.");
  }
}

/**
 * POST /auth/magic-link/redeem {token, crossDevice}.
 *
 * Three outcomes, all server-decided:
 *
 *   redirect "/dashboard"  an existing account signed in. The page navigates there.
 *   redirect "/welcome"    the address was proved but nobody owns it: the server created a pending sign-up, so the
 *                          account sequence starts.
 *   status "reauthenticated" a step-up link (sent from the account page) confirmed the CURRENT session instead of
 *                          creating a new one; the person goes back to the account page.
 *
 * The page calls its argument `differentDevice`; the server's field is `crossDevice`, and it means "this link was opened
 * somewhere other than where it was asked for". It only relaxes the browser binding for a sign-in link, and the server
 * decides that — it is a hint, not an override.
 */
export async function redeemSignInLink(input: { token: string; differentDevice?: boolean }, signal?: AbortSignal): Promise<void> {
  let payload: { status?: string; redirect?: string };
  try {
    payload = await apiPost<{ status?: string; redirect?: string }>(
      "/api/auth/magic-link/redeem",
      { token: input.token, crossDevice: input.differentDevice === true },
      signal,
    );
  } catch (error) {
    if (error instanceof ApiError && error.code === "link_wrong_browser") {
      // The token was deliberately NOT consumed, so the person can still use it in the browser that asked for it.
      throw new AuthError(error.message, undefined, "link_wrong_browser");
    }
    throw toTokenAwareError(error, "That link has expired or was already used. Request a new one from the sign-in page.");
  }

  if (payload.status === "reauthenticated") {
    await hydrateAuth();
    window.location.assign(payload.redirect ?? "/account");
    return;
  }

  await hydrateAuth();
  const destination = payload.redirect ?? "/dashboard";
  if (destination !== "/dashboard") {
    // Follow the server's route rather than the page's default: /welcome means a pending sign-up is waiting.
    await loadPendingSignup(signal);
    window.location.assign(destination);
  }
}

// ---- Sign-in link preview ------------------------------------------------------------------------------------------------

/**
 * The sign-in link in an email is GET /api/auth/magic-link?token=…, which the server redirects to the app's
 * /redeem-link?token=… page (so the token is never consumed by a link scanner that follows a GET). Nothing has to be
 * done here; `redeemSignInLink` is what actually consumes it, from the page's button.
 */

/** Everything the app needs before it may render a signed-in page: the CSRF cookie, the session and the pending sign-up. */
export async function hydrateSession(): Promise<void> {
  await hydrateAuth();
  // Warm the pending sign-up so the account sequence can render synchronously after a reload.
  await loadPendingSignup().catch(() => null);
  // And who has the cookie, so `csrfToken()` is populated before the first mutation.
  if (!csrfToken()) await bootstrapCsrf(true);
}

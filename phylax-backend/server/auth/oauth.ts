import { createHash, createSign } from "node:crypto";
import { HttpError } from "../http.js";
import type { Config } from "../config.js";
import { log } from "../log.js";

/**
 * Sign in with Apple or Google.
 *
 * The flow is the standard authorization-code flow, with one Phylax-specific rule: the callback never decides
 * whether the person has an account on its own. It hands the provider's identity to the caller, which creates a
 * pending sign-up if there is no account yet and sends the browser to /welcome. The account is only created when
 * the person says so.
 *
 * The `state` is a signed value, so a callback that did not come from a request this server made is rejected
 * before anything is written.
 */

export type Provider = "apple" | "google";

export type ProviderIdentity = {
  provider: Provider;
  /** The provider's own stable user id. */
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
};

/**
 * What the provider sent back, before it is turned into an identity.
 *
 * The two providers deliver the answer differently. Google redirects with the code in the query string. Apple
 * uses `response_mode=form_post`, so it POSTS a form to the callback — and it sends the person's NAME in that
 * form, because the name is in the id_token never. So the name has to be read out of the posted body, or every
 * Apple account is created with no name at all.
 */
export type ProviderCallback = {
  code: string;
  state: string;
  /** The name, when the provider sent one. */
  name?: string | null;
  /** Whether the provider says it has verified the address. */
  emailVerified?: boolean;
  error?: string;
};

type ProviderConfig = {
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  scope: string;
  /** The fields the identity endpoint returns. */
  fields: { id: string; email: string; verified: string; name: string };
};

const PROVIDERS: Record<Provider, (c: Config) => ProviderConfig | null> = {
  google: (c) => {
    if (!c.GOOGLE_CLIENT_ID || !c.GOOGLE_CLIENT_SECRET) return null;
    return {
      clientId: c.GOOGLE_CLIENT_ID,
      clientSecret: c.GOOGLE_CLIENT_SECRET,
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scope: "openid email profile",
      fields: { id: "sub", email: "email", verified: "email_verified", name: "name" },
    };
  },
  apple: (c) => {
    if (!c.APPLE_CLIENT_ID || !c.APPLE_TEAM_ID || !c.APPLE_KEY_ID || !c.APPLE_PRIVATE_KEY) return null;
    return {
      clientId: c.APPLE_CLIENT_ID,
      clientSecret: c.APPLE_CLIENT_SECRET ?? "",
      authorizeUrl: "https://appleid.apple.com/auth/authorize",
      tokenUrl: "https://appleid.apple.com/auth/token",
      scope: "name email",
      fields: { id: "sub", email: "email", verified: "email_verified", name: "name" },
    };
  },
};

/** Whether a provider is configured. */
export const isProviderConfigured = (provider: Provider, config: Config) => !!PROVIDERS[provider](config);

/** The URL the browser is sent to, to start the flow. */
export function authorizeUrl(
  provider: Provider,
  config: Config,
  state: string,
  redirectUri: string,
  codeVerifier?: string,
): string {
  const p = PROVIDERS[provider](config);
  if (!p) throw new HttpError(503, "provider_not_configured", `${provider} sign-in is not available right now.`);
  const url = new URL(p.authorizeUrl);
  url.searchParams.set("client_id", p.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", p.scope);
  url.searchParams.set("state", state);
  if (provider === "apple") {
    url.searchParams.set("response_mode", "form_post");
    url.searchParams.set("mode", "signup");
  }
  // PKCE. A random verifier is made here and its hash is put in the state; the provider is given the hash and
  // the callback has to present the verifier. It means an intercepted code cannot be redeemed by anybody else.
  if (codeVerifier) {
    url.searchParams.set("code_challenge", sha256Base64Url(codeVerifier));
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.toString();
}

/** The SHA-256 of a PKCE verifier, as base64url. */
function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

/**
 * Read the provider's answer out of a callback.
 *
 * Google sends it in the query string. Apple posts a form. Both are handled here, so the route does not have to
 * care which provider it is talking to.
 */
export function readCallback(
  provider: Provider,
  query: Record<string, unknown>,
  body: Record<string, unknown> | undefined,
): ProviderCallback {
  const source = provider === "apple" ? { ...(body ?? {}), ...query } : { ...query, ...(body ?? {}) };

  const error = typeof source.error === "string" ? source.error : undefined;
  const code = typeof source.code === "string" ? source.code : "";
  const state = typeof source.state === "string" ? source.state : "";

  let name: string | null = null;
  let emailVerified: boolean | undefined;

  // Apple sends the person's name as a JSON string in the `user` field of the posted form. It is only sent the
  // FIRST time somebody signs in with Apple, so it has to be read here, where it arrives.
  const userField = source.user;
  if (typeof userField === "string" && userField.length > 0) {
    try {
      const parsed = JSON.parse(userField) as { name?: { firstName?: string; lastName?: string } };
      const first = parsed.name?.firstName?.trim();
      const last = parsed.name?.lastName?.trim();
      const joined = [first, last].filter(Boolean).join(" ").trim();
      if (joined) name = joined;
    } catch {
      /* Apple's form field is not JSON: it is not a name we can use */
    }
  }

  return { code, state, name, emailVerified, error };
}

/** The callback URL this server expects. It must be registered with the provider. */
export const redirectUri = (config: Config) => `${config.APP_URL.replace(/\/+$/, "")}/api/auth/oauth/callback`;

/** Exchange the authorization code for the provider's identity. */
export async function exchangeCode(
  provider: Provider,
  config: Config,
  code: string,
  redirectUriValue: string,
  codeVerifier?: string,
): Promise<ProviderIdentity> {
  const p = PROVIDERS[provider](config);
  if (!p) throw new HttpError(503, "provider_not_configured", `${provider} sign-in is not available right now.`);

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUriValue,
    client_id: p.clientId,
  });
  // Apple wants its client secret as a signed JWT; Google takes the plain secret.
  if (provider === "apple") body.set("client_secret", appleClientSecret(config, p.clientId));
  else body.set("client_secret", p.clientSecret);
  // The verifier for the PKCE challenge, if one was made.
  if (codeVerifier) body.set("code_verifier", codeVerifier);

  const tokenRes = await fetch(p.tokenUrl, {
    method: "POST",
    signal: AbortSignal.timeout(15000),
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });
  if (!tokenRes.ok) {
    // The provider's body is NOT surfaced to the browser: it can carry the client secret's echo or an internal
    // URL, and the person cannot act on it anyway.
    log.warn("oauth token exchange failed", { status: tokenRes.status });
    throw new HttpError(502, "token_exchange_failed", "We couldn't finish signing you in. Try again.");
  }
  const tokens = (await tokenRes.json()) as { access_token?: string; id_token?: string };
  const accessToken = tokens.access_token;

  // One path per provider. The old shape fell through to GOOGLE's userinfo endpoint for an APPLE flow whenever
  // the id token was absent, which could only ever fail — and it failed as an opaque "couldn't read your account
  // details" 502, with nothing in the log to say which provider had answered what.
  let claims: Record<string, unknown> = {};
  if (provider === "apple") {
    // Apple returns the identity in the id token, a JWT signed by Apple. There is no userinfo endpoint to fall
    // back to, so a missing id token is a hard failure, not a reason to try somebody else's API.
    if (!tokens.id_token) throw new HttpError(502, "identity_invalid", "We couldn't finish signing you in. Try again.");
    claims = await verifyAppleIdToken(tokens.id_token, config);
  } else if (accessToken) {
    const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new HttpError(502, "identity_fetch_failed", "We couldn't read your account details. Try again.");
    claims = (await res.json()) as Record<string, unknown>;
  } else {
    throw new HttpError(502, "identity_missing", "We couldn't read your account details. Try again.");
  }

  const subject = String(claims[p.fields.id] ?? "");
  if (!subject) throw new HttpError(502, "identity_missing", "We couldn't read your account details. Try again.");

  const email = typeof claims[p.fields.email] === "string" ? (claims[p.fields.email] as string) : null;
  const verifiedRaw = claims[p.fields.verified];
  const emailVerified =
    typeof verifiedRaw === "boolean" ? verifiedRaw : typeof verifiedRaw === "string" ? verifiedRaw === "true" : false;
  // Apple does not put the name in the id_token; it posts it alongside. The caller passes what it received.
  const claimName = typeof claims[p.fields.name] === "string" ? (claims[p.fields.name] as string) : null;

  return { provider, subject, email, emailVerified, name: claimName };
}

/** Apple's client secret is a short-lived JWT signed with the team's private key. */
function appleClientSecret(config: Config, clientId: string): string {
  const { APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY } = config;
  if (!APPLE_TEAM_ID || !APPLE_KEY_ID || !APPLE_PRIVATE_KEY) {
    throw new HttpError(503, "provider_not_configured", "Apple sign-in is not available right now.");
  }
  const key = APPLE_PRIVATE_KEY.replace(/\\n/g, "\n");
  const header = { alg: "ES256", kid: APPLE_KEY_ID, typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: APPLE_TEAM_ID, iat: now, exp: now + 3600, aud: "https://appleid.apple.com", sub: clientId };
  const encode = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const signer = createSign("SHA256");
  signer.update(`${encode(header)}.${encode(payload)}`);
  const signature = signer.sign({ key, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `${encode(header)}.${encode(payload)}.${signature}`;
}

/**
 * Verify Apple's id token.
 *
 * The signature check is the important part: without it, anyone could mint a token claiming to be anyone. The
 * token is checked against Apple's public key and the audience, the expiry, and the issuer.
 */
async function verifyAppleIdToken(idToken: string, config: Config): Promise<Record<string, unknown>> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new HttpError(502, "identity_invalid", "We couldn't read your account details. Try again.");
  const [headerB64, payloadB64] = parts as [string, string, string];

  const header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8")) as { kid?: string; alg?: string };
  if (header.alg !== "RS256") throw new HttpError(502, "identity_invalid", "We couldn't read your account details. Try again.");

  // Apple's signing key, fetched from their well-known endpoint and cached by the fetch layer.
  let jwks = await fetchAppleKeys();
  let jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) { jwks = await fetchAppleKeys(true); jwk = jwks.keys.find((k) => k.kid === header.kid); }
  if (!jwk) throw new HttpError(502, "identity_invalid", "We couldn't read your account details. Try again.");

  const key = await importJwk(jwk);
  const { createVerify } = await import("node:crypto");
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${headerB64}.${payloadB64}`);
  const ok = verifier.verify(key, Buffer.from(parts[2]!, "base64url"));
  if (!ok) throw new HttpError(502, "identity_invalid", "We couldn't read your account details. Try again.");

  const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as Record<string, unknown>;
  const aud = payload.aud;
  const audience = Array.isArray(aud) ? aud : [aud];
  if (!audience.includes(config.APPLE_CLIENT_ID)) throw new HttpError(502, "identity_invalid", "We couldn't read your account details. Try again.");
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now()) {
    throw new HttpError(502, "identity_invalid", "We couldn't read your account details. Try again.");
  }
  if (payload.iss !== "https://appleid.apple.com") {
    throw new HttpError(502, "identity_invalid", "We couldn't read your account details. Try again.");
  }
  return payload;
}

type AppleJwk = { kid: string; kty: string; n: string; e: string; alg?: string; use?: string };
let appleKeysCache: { keys: AppleJwk[]; at: number } | null = null;

async function fetchAppleKeys(force = false): Promise<{ keys: AppleJwk[] }> {
  if (!force && appleKeysCache && Date.now() - appleKeysCache.at < 60 * 60 * 1000) return appleKeysCache;
  const res = await fetch("https://appleid.apple.com/auth/keys", { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new HttpError(502, "identity_invalid", "We couldn't read your account details. Try again.");
  const json = (await res.json()) as { keys: AppleJwk[] };
  appleKeysCache = { keys: json.keys, at: Date.now() };
  return appleKeysCache;
}

/** Turn a JWK into a key object Node's crypto understands. */
async function importJwk(jwk: AppleJwk) {
  const { createPublicKey } = await import("node:crypto");
  return createPublicKey({ key: jwk as unknown as import("node:crypto").JsonWebKey, format: "jwk" });
}

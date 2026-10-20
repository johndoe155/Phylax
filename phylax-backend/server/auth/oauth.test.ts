import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, createSign } from "node:crypto";
import type { Server } from "node:http";
import { setupDatabase, teardownDatabase, truncateAll, makeAccount, TEST_DATABASE_URL } from "../test-helpers.js";
import { createApp } from "../app.js";
import { execute, query, queryOne } from "../db.js";
import { hashPassword } from "./passwords.js";
import { COOKIE_NAME, createSession } from "./sessions.js";
import { signCsrfToken } from "../csrf.js";
import type { Config } from "../config.js";
import type { Response } from "express";

/**
 * Sign in with Apple, and in particular LINKING Apple to an account that already exists.
 *
 * WHY THIS FILE EXISTS. The account page has offered "Link Apple" since the provider was added, and it could
 * never succeed. Apple uses `response_mode=form_post`: the browser is shown a page on appleid.apple.com that
 * auto-submits a form to our callback. That is a CROSS-SITE POST, so the browser does not attach our cookies —
 * neither the session cookie nor `phylax_oauth`. Two things depended on those cookies:
 *
 *   - `oauth_states` was keyed by the hash of the `phylax_oauth` cookie, so with no cookie the row holding the
 *     PKCE code verifier was unreachable and the callback failed before any identity was exchanged;
 *   - the linking proof was read from the session, so `proven` was unconditionally false and the callback
 *     redirected to `/login?error=linking`.
 *
 * Both now travel inside the HMAC-signed, single-use `state`, which the provider is required to send back. These
 * tests drive the real HTTP routes end to end and stub only Apple's own endpoints, so the form_post shape — no
 * cookies, parameters in the body — is what is actually exercised.
 */

const APPLE_TEAM_ID = "TEAM000001";
const APPLE_KEY_ID = "KEY0000001";
const APPLE_CLIENT_ID = "com.phylax.test.signin";
const SUBJECT = "apple.001234.abcdef.1234";
const APPLE_EMAIL = "linked@example.test";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

/** The JWK Apple publishes at /auth/keys, derived from the test key pair. */
function publicJwk(kid: string) {
  const jwk = publicKey.export({ format: "jwk" });
  return { ...jwk, kid, alg: "RS256", use: "sig" };
}

/** An id_token signed by the test key, shaped exactly like Apple's. */
function appleIdToken(claims: Record<string, unknown>): string {
  const header = { alg: "RS256", kid: APPLE_KEY_ID, typ: "JWT" };
  const payload = {
    iss: "https://appleid.apple.com",
    aud: APPLE_CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 600,
    iat: Math.floor(Date.now() / 1000),
    sub: SUBJECT,
    email: APPLE_EMAIL,
    email_verified: "true",
    ...claims,
  };
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const signer = createSign("RSA-SHA256");
  signer.update(`${b64(header)}.${b64(payload)}`);
  return `${b64(header)}.${b64(payload)}.${signer.sign(privateKey).toString("base64url")}`;
}

/**
 * Stand in for Apple.
 *
 * Only the two URLs the server calls are answered: `/auth/token` (the code exchange, which needs a client secret
 * signed with the team key) and `/auth/keys` (the JWKS used to verify the id_token). Everything else is a hard
 * failure, so a test cannot accidentally pass by talking to something real.
 */
function stubApple(opts: { idToken?: string; tokenStatus?: number } = {}) {
  const calls: string[] = [];
  // The test client drives the routes over real HTTP, so it uses `fetch` too. Only Apple's own endpoints are
  // intercepted; everything else is passed through to the real implementation, otherwise the stub would swallow
  // the test's own requests to the server.
  const realFetch = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith("https://appleid.apple.com/")) {
        return realFetch(input as never, init);
      }
      calls.push(url);
      if (url.startsWith("https://appleid.apple.com/auth/token")) {
        if (opts.tokenStatus && opts.tokenStatus !== 200) {
          return new Response("{}", { status: opts.tokenStatus });
        }
        return new Response(JSON.stringify({ access_token: "at", id_token: opts.idToken ?? appleIdToken({}) }), { status: 200 });
      }
      if (url.startsWith("https://appleid.apple.com/auth/keys")) {
        return new Response(JSON.stringify({ keys: [publicJwk(APPLE_KEY_ID)] }), { status: 200 });
      }
      throw new Error(`the test stubbed Apple but the server called ${url}`);
    }),
  );
  return calls;
}

describe.skipIf(!TEST_DATABASE_URL)("sign in with Apple, against a stubbed Apple", () => {
  let config: Config;
  let server: Server;
  let base: string;

  /** A configuration with Apple actually signing: team id, key id and a private key the stub can verify against. */
  const appleConfig = (base: Config): Config => ({
    ...base,
    APPLE_CLIENT_ID,
    APPLE_TEAM_ID,
    APPLE_KEY_ID,
    APPLE_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  });

  beforeAll(async () => {
    config = appleConfig((await setupDatabase())!);
    server = createApp({ config }).listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.on("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await teardownDatabase();
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await truncateAll();
  });

  /**
   * Start the flow and pull the signed state out of the redirect.
   *
   * Deliberately does NOT return the `phylax_oauth` cookie: the point of these tests is that the callback works
   * without it, because that is what Apple's form_post delivers.
   */
  async function startApple(cookies: string[] = []): Promise<{ state: string }> {
    const res = await fetch(`${base}/api/auth/oauth/apple/start?redirect=/account`, {
      redirect: "manual",
      headers: cookies.length ? { Cookie: cookies.join("; ") } : {},
    });
    expect(res.status).toBe(302);
    const location = res.headers.get("location")!;
    expect(location.startsWith("https://appleid.apple.com/auth/authorize?")).toBe(true);
    const params = new URL(location).searchParams;
    // form_post is what makes this whole file necessary; if it ever changes, the premise changes with it.
    expect(params.get("response_mode")).toBe("form_post");
    expect(params.get("code_challenge_method")).toBe("S256");
    const state = params.get("state")!;
    expect(state.length).toBeGreaterThan(20);
    return { state };
  }

  /** Apple's callback: a cross-site form POST, parameters in the body, no cookies. */
  async function appleFormPost(state: string, extra: Record<string, string> = {}) {
    const body = new URLSearchParams({ code: "the-auth-code", state, ...extra });
    return fetch(`${base}/api/auth/oauth/callback`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  }

  it("signs in a brand-new Apple identity with no cookie present at the callback", async () => {
    const calls = stubApple();
    const { state } = await startApple();
    // Apple sends the person's name in the posted form, never in the id_token. If the callback could not be
    // reached without a cookie, this name was lost along with everything else.
    const res = await appleFormPost(state, { user: JSON.stringify({ name: { firstName: "Ada", lastName: "Lovelace" } }) });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/welcome");
    // Both of Apple's endpoints were reached, and nothing else was called.
    expect(calls.some((c) => c.includes("/auth/token"))).toBe(true);
    expect(calls.some((c) => c.includes("/auth/keys"))).toBe(true);
    // The state is single-use: the row is gone, so a replay cannot redeem the same code twice.
    expect((await queryOne<{ n: number }>("SELECT count(*)::int AS n FROM oauth_states"))!.n).toBe(0);
    const pending = await queryOne<{ display_name: string | null; method: string }>(
      "SELECT display_name, method FROM pending_signups",
    );
    expect(pending!.method).toBe("apple");
    expect(pending!.display_name).toBe("Ada Lovelace");
  });

  it("refuses to redeem the same state twice", async () => {
    stubApple();
    const { state } = await startApple();
    expect((await appleFormPost(state)).status).toBe(302);
    const replay = await appleFormPost(state);
    expect(replay.status).toBe(302);
    expect(replay.headers.get("location")).toBe("/login?error=oauth");
  });

  it("links Apple to an existing verified account using the proof carried in the state", async () => {
    // The account exists, its email is verified, and it matches what Apple will assert.
    const account = await makeAccount({ email: APPLE_EMAIL });
    await execute("INSERT INTO auth_identities(account_id,method,password_hash) VALUES($1,'password',$2)", [
      account.id,
      await hashPassword("existing-password-123"),
    ]);

    // A session that is fresh, so the start route writes the linking intent into the state. The session cookie is
    // presented to /start ONLY — exactly like a real browser, which then loses it on the cross-site post back.
    let raw = "";
    await createSession({ cookie: (_n: string, v: string) => { raw = v; } } as unknown as Response, account.id, {
      secure: false,
      sameSite: "lax",
      ttlMs: 3600000,
    });
    const csrf = signCsrfToken("a".repeat(64), config.SESSION_SECRET);

    const calls = stubApple();
    const { state } = await startApple([`${COOKIE_NAME}=${raw}`, `phylax_csrf=${csrf}`]);
    const res = await appleFormPost(state); // no cookies at all

    expect(res.status).toBe(302);
    // NOT /login?error=linking, which is where every Apple link attempt used to end.
    expect(res.headers.get("location")).toBe("/account");
    expect(calls.some((c) => c.includes("/auth/token"))).toBe(true);

    const linked = await queryOne<{ n: number }>(
      "SELECT count(*)::int AS n FROM auth_identities WHERE account_id=$1 AND method='apple' AND provider_subject=$2",
      [account.id, SUBJECT],
    );
    expect(linked!.n).toBe(1);
    // And the change was recorded, with the notice queued to the address that was already verified.
    expect((await queryOne<{ n: number }>("SELECT count(*)::int AS n FROM security_events WHERE account_id=$1 AND kind='provider_linked'", [account.id]))!.n).toBe(1);
  });

  it("will not link onto somebody else's account with a state minted for a different one", async () => {
    // The signed state names the account it was minted for. A state produced while signed in as A must not be
    // usable to attach a provider to B, however fresh it is.
    const attacker = await makeAccount({ email: "attacker@example.test" });
    let raw = "";
    await createSession({ cookie: (_n: string, v: string) => { raw = v; } } as unknown as Response, attacker.id, {
      secure: false,
      sameSite: "lax",
      ttlMs: 3600000,
    });
    const csrf = signCsrfToken("b".repeat(64), config.SESSION_SECRET);

    // The victim owns the address Apple is about to assert.
    const victim = await makeAccount({ email: APPLE_EMAIL });

    stubApple();
    const { state } = await startApple([`${COOKIE_NAME}=${raw}`, `phylax_csrf=${csrf}`]);
    const res = await appleFormPost(state); // no session cookie: nothing proves control of the victim

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login?error=linking");
    expect((await queryOne<{ n: number }>(
      "SELECT count(*)::int AS n FROM auth_identities WHERE account_id=$1 AND method='apple'",
      [victim.id],
    ))!.n).toBe(0);
  });

  it("writes no linking intent when the session was not fresh to begin with", async () => {
    const account = await makeAccount({ email: APPLE_EMAIL });
    let raw = "";
    await createSession({ cookie: (_n: string, v: string) => { raw = v; } } as unknown as Response, account.id, {
      secure: false,
      sameSite: "lax",
      ttlMs: 3600000,
    });
    // A tab that has been open since yesterday: the proof of presence is older than the window, so the start
    // route must not put a linking intent into the state at all.
    await execute("UPDATE sessions SET reauthenticated_at = now() - interval '2 hours', created_at = now() - interval '2 hours'");
    const csrf = signCsrfToken("c".repeat(64), config.SESSION_SECRET);

    stubApple();
    const { state } = await startApple([`${COOKIE_NAME}=${raw}`, `phylax_csrf=${csrf}`]);
    const res = await appleFormPost(state);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login?error=linking");
    expect((await query<{ method: string }>("SELECT method FROM auth_identities WHERE account_id=$1", [account.id])).length).toBe(0);
  });

  it("will not honour a linking intent that went stale while the person was away at the provider", async () => {
    const account = await makeAccount({ email: APPLE_EMAIL });
    let raw = "";
    await createSession({ cookie: (_n: string, v: string) => { raw = v; } } as unknown as Response, account.id, {
      secure: false,
      sameSite: "lax",
      ttlMs: 3600000,
    });
    const csrf = signCsrfToken("e".repeat(64), config.SESSION_SECRET);

    // The flow starts with a genuinely fresh proof, so the state carries a linking intent...
    vi.useFakeTimers({ now: Date.now(), toFake: ["Date"] });
    try {
      stubApple();
      const { state } = await startApple([`${COOKIE_NAME}=${raw}`, `phylax_csrf=${csrf}`]);
      // ...and then eleven minutes pass before the provider posts back. The intent is re-checked against the
      // window at callback time, so a state minted nine minutes ago cannot grant a link eleven minutes later.
      vi.setSystemTime(Date.now() + 11 * 60 * 1000);
      const res = await appleFormPost(state);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toMatch(/^\/login\?error=(linking|oauth)$/);
    } finally {
      vi.useRealTimers();
    }
    expect((await query<{ method: string }>("SELECT method FROM auth_identities WHERE account_id=$1", [account.id])).length).toBe(0);
  });

  it("rejects an id_token Apple did not sign, and one for a different audience", async () => {
    const account = await makeAccount({ email: APPLE_EMAIL });
    let raw = "";
    await createSession({ cookie: (_n: string, v: string) => { raw = v; } } as unknown as Response, account.id, {
      secure: false,
      sameSite: "lax",
      ttlMs: 3600000,
    });
    const csrf = signCsrfToken("d".repeat(64), config.SESSION_SECRET);
    const cookies = [`${COOKIE_NAME}=${raw}`, `phylax_csrf=${csrf}`];

    // Signed by a key that is not in the published JWKS.
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const forged = (() => {
      const header = { alg: "RS256", kid: APPLE_KEY_ID, typ: "JWT" };
      const payload = { iss: "https://appleid.apple.com", aud: APPLE_CLIENT_ID, exp: Math.floor(Date.now() / 1000) + 600, sub: SUBJECT, email: APPLE_EMAIL };
      const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
      const signer = createSign("RSA-SHA256");
      signer.update(`${b64(header)}.${b64(payload)}`);
      return `${b64(header)}.${b64(payload)}.${signer.sign(other.privateKey).toString("base64url")}`;
    })();
    stubApple({ idToken: forged });
    let started = await startApple(cookies);
    expect((await appleFormPost(started.state)).headers.get("location")).toBe("/login?error=oauth");

    // Correctly signed, but for a different client id.
    stubApple({ idToken: appleIdToken({ aud: "com.somebody.else" }) });
    started = await startApple(cookies);
    expect((await appleFormPost(started.state)).headers.get("location")).toBe("/login?error=oauth");

    // And an expired one.
    stubApple({ idToken: appleIdToken({ exp: Math.floor(Date.now() / 1000) - 60 }) });
    started = await startApple(cookies);
    expect((await appleFormPost(started.state)).headers.get("location")).toBe("/login?error=oauth");

    expect((await query<{ method: string }>("SELECT method FROM auth_identities WHERE account_id=$1", [account.id])).length).toBe(0);
  });

  it("does not leak the provider's own error when the token exchange fails", async () => {
    stubApple({ tokenStatus: 400 });
    const { state } = await startApple();
    const res = await appleFormPost(state);
    // The provider's body can echo the client secret or an internal URL, and the person cannot act on it anyway.
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login?error=oauth");
  });
});

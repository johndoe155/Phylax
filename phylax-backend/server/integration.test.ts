import { beforeAll, afterAll, describe, it, expect } from "vitest";
import type { Server } from "node:http";
import { createApp } from "./app.js";
import { setupDatabase, teardownDatabase, TEST_DATABASE_URL } from "./test-helpers.js";
import { queryOne, execute } from "./db.js";
import { sign, hashToken } from "./auth/tokens.js";
import { createScheduler } from "./scheduler.js";
import { spanIn } from "@shared/shifts";

let server: Server, base: string;
const cookies = new Map<string, string>();
async function call(path: string, method = "GET", body?: unknown, extra: Record<string, string> = {}) {
  const response = await fetch(base + path, { method, redirect: "manual", headers: {
    Cookie: [...cookies].map(([k,v]) => `${k}=${v}`).join("; "),
    "Content-Type": "application/json", "X-CSRF-Token": cookies.get("phylax_csrf") ?? "", ...extra,
  }, body: body === undefined ? undefined : JSON.stringify(body) });
  for (const item of response.headers.getSetCookie()) {
    const [pair] = item.split(";"); const eq = pair.indexOf("="); cookies.set(pair.slice(0,eq), pair.slice(eq+1));
  }
  const text = await response.text();
  // Whatever JSON the route produced. A test client cannot know each route's response shape without repeating
  // every one of them, so the body stays loose HERE and is pinned by the assertion at each call site instead.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let data: any; try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data, response };
}

describe.skipIf(!TEST_DATABASE_URL)("real HTTP security and identity regression", () => {
  beforeAll(async () => {
    const config = (await setupDatabase())!;
    server = createApp({ config }).listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.on("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => { if (server) await new Promise<void>(resolve => server.close(() => resolve())); await teardownDatabase(); });
  it("issues a CSRF token and forbids missing tokens and foreign origins", async () => {
    const session = await call("/api/auth/session");
    expect(session.response.headers.get("cache-control")).toBe("no-store");
    expect(session.response.headers.get("x-request-id")).toBeTruthy();
    expect((await call("/api/auth/password", "POST", {}, { "X-CSRF-Token": "" })).status).toBe(403);
    expect((await call("/api/auth/password", "POST", {}, { Origin: "https://evil.example" })).status).toBe(403);
  });
  it("publishes only timezone names supported by both PostgreSQL and this Node/ICU build", async () => {
    const response = await call("/api/meta/timezones");
    expect(response.status).toBe(200);
    expect(response.data.timezones).toContain("Africa/Lagos");
    expect(response.data.timezones).not.toContain("Europe/Kiev");
    expect(response.data.timezones).not.toContain("+05:00");
  });
  // ---- finding 6: the global auth ceiling counted EVERY >=400 response ------------------------------
  //
  // Two trivial ways to switch off sign-in for every user of the instance: send 10,000 malformed POSTs a day
  // (each a 400, none of them a credential guess), or just be rate-limited often enough (each 429 is the
  // defence WORKING, and it accelerated the global shutdown). Only a 401 says "wrong credentials".
  it("spends the global auth ceiling on wrong credentials only, not on malformed or rate-limited requests", async () => {
    const spent = async () => Number((await queryOne<{ hits: string }>(
      "SELECT hits FROM rate_buckets WHERE key='auth-global'"))?.hits ?? "0");
    const before = await spent();

    // Malformed bodies: a 400 each, and not one of them is a credential guess.
    for (let i = 0; i < 25; i++) {
      expect((await call("/api/auth/password", "POST", { email: 123, password: [] })).status).toBe(400);
    }
    expect(await spent()).toBe(before);

    // Wrong credentials: a 401 each, and every one of them counts.
    for (let i = 0; i < 5; i++) {
      expect((await call("/api/auth/password", "POST", { email: `nobody-${i}@example.com`, password: "wrong-password-123" })).status).toBe(401);
    }
    expect(await spent()).toBe(before + 5);
  });

  it("limits an anonymous caller per /64 network rather than per rotating IPv6 address", async () => {
    // The per-IP budget is keyed on the bucket, so rotating the low bits of one IPv6 allocation — which a single
    // person controls 2^64 of — does not buy a fresh 120/hour budget each time.
    const { rateLimitBucket } = await import("./http.js");
    const a = rateLimitBucket("2001:db8:abcd:12::1");
    const b = rateLimitBucket("2001:db8:abcd:12:dead:beef::9");
    expect(a).toBe(b);
    expect(a).toBe("2001:db8:abcd:12::/64");
  });

  it("rejects wrong types and oversized JSON with 400/413, not 500", async () => {
    expect((await call("/api/auth/password", "POST", { email: 123, password: [] })).status).toBe(400);
    expect((await call("/api/auth/password", "POST", { email: "a".repeat(70000) })).status).toBe(413);
  });
  it("creates one password account, marks typed email unverified and consumes the pending signup", async () => {
    // Legacy provisional account fixture: the public password endpoint no longer registers unknown addresses.
    expect((await call("/api/auth/password", "POST", { email: "audit@example.com", password: "audit-password-123" })).status).toBe(401);
    const {createPendingSignup}=await import("./auth/pending.js");
    // No password hash is staged, and none can be: `pending_signups.password_hash` was dropped by migration 015.
    // It was left over from the removed "typing a password at sign-in creates an account" flow, so it stored a
    // scrypt hash of a password somebody had typed in a table with no code path that could ever read it — a
    // disclosure risk with no function. The account this creates has no password identity until the person proves
    // their email and adds one themselves (see POST /api/auth/password/add below).
    const pending=await createPendingSignup({method:"password",email:"audit@example.com"});
    cookies.set("phylax_pending",sign({pid:pending.id,exp:Date.now()+900000},(await setupDatabase())!.SESSION_SECRET));
    expect((await call("/api/auth/pending")).data.pending.method).toBe("password");
    const created = await call("/api/account", "POST", { displayName: "Audit Person", consent: { termsVersion: "2026-10-17.2", privacyVersion: "2026-10-17.2", acceptedAt: new Date().toISOString() } });
    expect(created.status).toBe(200);
    expect((await call("/api/account")).data.account.emailVerified).toBe(false);
    expect((await call("/api/auth/pending")).data.pending).toBeNull();
    expect((await call("/api/account", "POST", {})).status).toBe(400);
  });
  it("edits owner-scoped shifts, validates ids and preserves reminders route", async () => {
    const shift = await call("/api/shifts", "POST", { platform: "ShiftKey", facility: "Audit Facility", start: 480, end: 960, date: "2026-11-01" });
    expect(shift.status).toBe(201);
    expect((await call(`/api/shifts/${shift.data.id}`, "PUT", { facility: "Changed Facility" })).data.facility).toBe("Changed Facility");
    expect((await call("/api/shifts/reminders")).status).toBe(200);
    expect((await call("/api/shifts/not-a-uuid", "DELETE")).status).toBe(400);
    expect((await call("/api/account/export")).data.account.email).toBe("audit@example.com");
  });
  it("resets a password atomically, revokes sessions and refuses token replay", async () => {
    const account = (await queryOne<{ id: string }>("SELECT id FROM accounts WHERE email = 'audit@example.com'"))!;
    await execute("INSERT INTO password_reset_tokens(account_id,token_hash,email,expires_at) VALUES ($1,$2,'audit@example.com',now()+interval '1 hour')", [account.id, hashToken("test-reset-token")]);
    expect((await call("/api/auth/password/reset", "POST", { token: "test-reset-token", newPassword: "new-audit-password" })).status).toBe(200);
    expect((await call("/api/account")).status).toBe(401);
    expect((await call("/api/auth/password/reset", "POST", { token: "test-reset-token", newPassword: "new-audit-password" })).status).toBe(400);
    expect((await call("/api/auth/password", "POST", { email: "audit@example.com", password: "new-audit-password" })).data.status).toBe("signed-in");
  });
  it("does not allow an unknown address to create a link account before redemption", async () => {
    const result = await call("/api/auth/magic-link", "POST", { email: "unproven@example.com" });
    expect(result.data.status).toBe("link-sent");
    expect((await call("/api/auth/pending")).data.pending).toBeNull();
  });
  it("makes retried shift creation idempotent", async () => {
    const body = { id: "stable-client-request", platform: "ShiftKey", facility: "Retry Facility", start: 500, end: 900, date: "2026-11-02" };
    const first = await call("/api/shifts", "POST", body);
    const retry = await call("/api/shifts", "POST", body);
    expect(first.status).toBe(201);
    expect(retry.data.id).toBe(first.data.id);
    const count = await queryOne<{ n: string }>("SELECT count(*)::text AS n FROM shifts WHERE client_id='stable-client-request'");
    expect(count!.n).toBe("1");
  });
  it("requires phone ownership, counts bad codes and consumes successful verification", async () => {
    const account = (await queryOne<{ id: string }>("SELECT id FROM accounts WHERE email='audit@example.com'"))!;
    await call("/api/account/consent","POST",{consent:{termsVersion:"2026-10-17.2",privacyVersion:"2026-10-17.2",acceptedAt:new Date().toISOString()}});
    expect((await call("/api/account/settings", "PUT", { smsEnabled: true, phone: "+2348012345678" })).status).toBe(400);
    const secret = (await setupDatabase())!.SESSION_SECRET;
    await execute("INSERT INTO phone_verifications(account_id,phone,code_hash,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')", [account.id, "+2348012345678", hashToken(`${account.id}:123456:${secret}`)]);
    expect((await call("/api/auth/phone/confirm", "POST", { code: "000000" })).status).toBe(400);
    expect((await queryOne<{ attempts: number }>("SELECT attempts FROM phone_verifications WHERE account_id=$1", [account.id]))!.attempts).toBe(1);
    expect((await call("/api/auth/phone/confirm", "POST", { code: "123456" })).status).toBe(200);
    expect((await call("/api/account/settings", "PUT", { smsEnabled: true, phone: "+2348012345678" })).status).toBe(200);
    expect((await call("/api/auth/phone/confirm", "POST", { code: "123456" })).status).toBe(400);
  });
  it("never exposes session bearer tokens in the device list", async () => {
    const result = await call("/api/auth/sessions");
    expect(result.data.sessions).toHaveLength(1);
    expect(result.data.sessions[0].id).toMatch(/^[a-f0-9]{64}$/);
    expect(result.data.sessions[0].id).not.toBe(cookies.get("app_session_id"));
  });
  it("imports atomically without replacement and preserves existing shifts", async()=>{
    const old=(await call("/api/shifts")).data.shifts.length;
    const body={requestId:crypto.randomUUID(),shifts:[{platform:"CareRev",facility:"Imported",start:600,end:1000,date:"2026-11-03",note:"Test note"}]};
    // The destructive PUT /batch replace-everything endpoint was removed; the path now falls through to PUT /:id
    // where validateId rejects "batch" as a non-UUID. Import (below) is the supported, idempotent way to add shifts.
    const batch=await call("/api/shifts/batch","PUT",body);
    expect(batch.status).toBe(400);
    expect(batch.data.error.code).toBe("invalid_id");
    const imported=await call("/api/shifts/import","POST",body);expect(imported.status).toBe(201);expect(imported.data.shifts[0].note).toBe("Test note");
    expect((await call("/api/shifts/import","POST",body)).data.shifts[0].id).toBe(imported.data.shifts[0].id);
    expect((await call("/api/shifts/import","POST",{...body,shifts:[{date:"invalid"}]})).status).toBe(400);
    expect((await call("/api/shifts")).data.shifts.length).toBe(old+1);
  });
  it("a redeemed link creates a verified pending signup only once", async () => {
    await execute("INSERT INTO magic_links(email,token_hash,expires_at) VALUES ($1,$2,now()+interval '15 minutes')", ["new-link@example.com", hashToken("new-link-token")]);
    const redeemed = await call("/api/auth/magic-link?token=new-link-token");
    expect(redeemed.response.headers.get("location")).toBe("/redeem-link?token=new-link-token");
    expect((await queryOne<{ consumed_at: Date | null }>("SELECT consumed_at FROM magic_links WHERE token_hash=$1", [hashToken("new-link-token")]))!.consumed_at).toBeNull();
    expect((await call("/api/auth/magic-link/redeem", "POST", { token: "new-link-token" })).data.redirect).toBe("/welcome");
    const result = await call("/api/account", "POST", { displayName: "Link Person", consent: { termsVersion: "2026-10-17.2", privacyVersion: "2026-10-17.2", acceptedAt: new Date().toISOString() } });
    expect(result.status).toBe(200);
    expect((await call("/api/account")).data.account.emailVerified).toBe(true);
    expect((await call("/api/auth/magic-link/redeem", "POST", { token: "new-link-token" })).status).toBe(400);
  });
  it("rejects malformed WebAuthn data without creating an account", async () => {
    const result = await call("/api/auth/passkey/verify", "POST", { credential: { id: "fake", response: { clientDataJSON: "invalid" } } });
    expect(result.status).toBe(400);
  });
  it("email proof removes an attacker's provisional credentials, sessions and phone", async () => {
    const { hashPassword } = await import("./auth/passwords.js");
    const victim = (await queryOne<{ id: string }>("INSERT INTO accounts(display_name,email,email_verified,phone,phone_verified) VALUES('Provisional','victim@example.com',false,'+2348011111111',true) RETURNING id"))!;
    await execute("INSERT INTO account_settings(account_id,phone,sms_enabled) VALUES($1,'+2348011111111',true)", [victim.id]);
    await execute("INSERT INTO auth_identities(account_id,method,password_hash) VALUES($1,'password',$2)", [victim.id, await hashPassword("attacker-password")]);
    await execute("INSERT INTO sessions(id,account_id,expires_at) VALUES('attacker-session',$1,now()+interval '1 day')", [victim.id]);
    await execute("INSERT INTO magic_links(email,token_hash,expires_at) VALUES('victim@example.com',$1,now()+interval '15 minutes')", [hashToken("victim-proof")]);
    expect((await call("/api/auth/magic-link/redeem", "POST", { token: "victim-proof" })).data.redirect).toBe("/dashboard");
    expect((await queryOne<{ n: string }>("SELECT count(*)::text AS n FROM sessions WHERE id='attacker-session'"))!.n).toBe("0");
    expect((await queryOne<{ n: string }>("SELECT count(*)::text AS n FROM auth_identities WHERE account_id=$1 AND method='password'", [victim.id]))!.n).toBe("0");
    expect((await call("/api/auth/password", "POST", { email: "victim@example.com", password: "attacker-password" })).status).toBe(401);
    expect((await call("/api/account")).data.account.phone).toBeNull();
    expect((await call("/api/auth/password/add", "POST", { newPassword: "victim-owned-password" })).status).toBe(200);
    expect((await call("/api/auth/password", "POST", { email: "victim@example.com", password: "victim-owned-password" })).data.status).toBe("signed-in");
  });
  it("enables verified email alerts with a real timezone and dispatches a conflict", async () => {
    const { makeShift, dayFromNow } = await import("./test-helpers.js");
    const account = (await queryOne<{ id: string }>("SELECT id FROM accounts WHERE email='victim@example.com'"))!;
    await call("/api/account/consent","POST",{consent:{termsVersion:"2026-10-17.2",privacyVersion:"2026-10-17.2",acceptedAt:new Date().toISOString()}});
    const configured = await call("/api/account/settings", "PUT", { timezone: "Africa/Lagos", emailEnabled: true, reminderLeadMinutes: 120 });
    expect(configured.status).toBe(200);
    expect(configured.data.timezone).toBe("Africa/Lagos");
    await makeShift(account.id, { start: 480, end: 960, date: dayFromNow(1), facility: "First Facility" });
    await makeShift(account.id, { start: 600, end: 1000, date: dayFromNow(1), facility: "Other Facility" });
    const scheduler = createScheduler((await setupDatabase())!);
    try { expect((await scheduler.runOnce()).sent).toBeGreaterThan(0); }
    finally { await scheduler.stop(); }
    expect((await queryOne<{ n: string }>("SELECT count(*)::text AS n FROM reminders WHERE account_id=$1 AND sent_at IS NOT NULL", [account.id]))!.n).not.toBe("0");
  });
  it("signup queues an ownership proof token instead of treating its welcome as verification", async () => {
    const account = (await queryOne<{ id: string }>("SELECT id FROM accounts WHERE email='audit@example.com'"))!;
    expect((await queryOne<{ n: string }>("SELECT count(*)::text AS n FROM email_verification_tokens WHERE account_id=$1", [account.id]))!.n).toBe("1");
  });
  it("a follower cannot dispatch while another connection owns the scheduler lock", async () => {
    const config = (await setupDatabase())!;
    const { getPool } = await import("./db.js");
    const client = await getPool().connect();
    // Same key as scheduler.ts.
    await client.query("SELECT pg_advisory_lock($1)", [0x7068796c]);
    const scheduler = createScheduler(config);
    try { expect((await scheduler.runOnce()).ticked).toBe(false); }
    finally { await scheduler.stop(); await client.query("SELECT pg_advisory_unlock($1)", [0x7068796c]); client.release(); }
  });
});

describe("timezone-aware shift instants", () => {
  it("uses Lagos UTC+1 rather than the host timezone", () => {
    const [start] = spanIn({ date: "2026-11-01", start: 60, end: 120 }, "Africa/Lagos");
    expect(new Date(start).toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });
});

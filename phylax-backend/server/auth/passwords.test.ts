import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { hashPassword, verifyPassword, passwordStrength, checkPasswordBreach, MIN_PASSWORD_LENGTH } from "./passwords.js";

const sha1 = (pw: string) => createHash("sha1").update(pw, "utf8").digest("hex").toUpperCase();
const breachOpts = (over: Partial<{ enabled: boolean; url: string; timeoutMs: number }> = {}) => ({
  enabled: true, url: "https://api.pwnedpasswords.com/range/", timeoutMs: 3000, ...over,
});
/** A minimal stand-in for the pieces of `Response` the check reads. */
const httpResponse = (init: { ok: boolean; status?: number; body?: string }) => ({
  ok: init.ok,
  status: init.status ?? (init.ok ? 200 : 500),
  text: async () => init.body ?? "",
});

describe("password hashing", () => {
  it("accepts the right password", async () => {
    const hash = await hashPassword("a-good-password");
    expect(await verifyPassword("a-good-password", hash)).toBe(true);
  });

  it("refuses the wrong password", async () => {
    const hash = await hashPassword("a-good-password");
    expect(await verifyPassword("a-bad-password", hash)).toBe(false);
    expect(await verifyPassword("", hash)).toBe(false);
    expect(await verifyPassword("a-good-password ", hash)).toBe(false);
  });

  it("never stores the password itself", async () => {
    const hash = await hashPassword("hunter2-hunter2");
    expect(hash).not.toContain("hunter2");
    expect(hash.startsWith("scrypt$")).toBe(true);
  });

  it("gives every password its own salt, so two of the same password hash differently", async () => {
    const a = await hashPassword("the-same-password");
    const b = await hashPassword("the-same-password");
    expect(a).not.toBe(b);
    expect(await verifyPassword("the-same-password", a)).toBe(true);
    expect(await verifyPassword("the-same-password", b)).toBe(true);
  });

  it("treats a missing or malformed hash as wrong, rather than throwing", async () => {
    expect(await verifyPassword("anything", null)).toBe(false);
    expect(await verifyPassword("anything", undefined)).toBe(false);
    expect(await verifyPassword("anything", "")).toBe(false);
    expect(await verifyPassword("anything", "not-a-hash")).toBe(false);
    expect(await verifyPassword("anything", "scrypt$1$2$3$abc$def")).toBe(false);
  });

  it("normalises the password the same way both sides do, so a stray accent does not lock anyone out", async () => {
    const hash = await hashPassword("café-passphrase");
    expect(await verifyPassword("café-passphrase", hash)).toBe(true);
  });
});

describe("password strength", () => {
  it("rates a short password as no better than weak", () => {
    expect(passwordStrength("abc").score).toBeLessThanOrEqual(1);
    expect(passwordStrength("").score).toBe(0);
  });

  it("rates a long, mixed password as strong", () => {
    expect(passwordStrength("correct horse battery staple").score).toBeGreaterThanOrEqual(3);
  });

  it("holds a common password down, however long", () => {
    expect(passwordStrength("password123456789").score).toBeLessThanOrEqual(1);
  });

  it("keeps the server's own minimum at eight characters", () => {
    expect(MIN_PASSWORD_LENGTH).toBe(8);
    expect(passwordStrength("1234567").score).toBeLessThanOrEqual(1);
    expect(passwordStrength("12345678").score).toBeGreaterThanOrEqual(1);
  });
});

describe("breach-corpus check (k-anonymity)", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("does nothing and calls nobody when the feature is off", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await checkPasswordBreach("password", breachOpts({ enabled: false }));
    expect(result).toEqual({ checked: false, breached: false, reason: "disabled" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends ONLY the five-character prefix — never the password, the full hash, or the suffix", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => httpResponse({ ok: true, body: "" }) as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
    // A distinctive password, so "the raw password is not in the URL" is a real assertion rather than an accident
    // of the provider's own domain name.
    const secret = "correct-horse-battery-staple-42";
    await checkPasswordBreach(secret, breachOpts());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const full = sha1(secret);
    const prefix = full.slice(0, 5);
    expect(url).toBe(`https://api.pwnedpasswords.com/range/${prefix}`);
    expect(url).not.toContain(full);
    expect(url).not.toContain(full.slice(5));
    expect(url).not.toContain(secret);
    expect(url).not.toContain(encodeURIComponent(secret));
    // The privacy header that asks the provider to pad the response with decoys.
    expect((init.headers as Record<string, string>)["Add-Padding"]).toBe("true");
  });

  it("reports a breach, with the corpus count, when the suffix comes back", async () => {
    const suffix = sha1("password").slice(5);
    vi.stubGlobal("fetch", vi.fn(async () => httpResponse({
      ok: true,
      body: `0000000000000000000000000000000000000:1\r\n${suffix}:3861493\r\nFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:2`,
    }) as unknown as Response));
    const result = await checkPasswordBreach("password", breachOpts());
    expect(result).toEqual({ checked: true, breached: true, count: 3861493 });
  });

  it("matches the suffix case-insensitively, as the provider returns upper-case hex", async () => {
    const suffix = sha1("password").slice(5);
    vi.stubGlobal("fetch", vi.fn(async () => httpResponse({
      ok: true, body: `${suffix.toLowerCase()}:7`,
    }) as unknown as Response));
    expect(await checkPasswordBreach("password", breachOpts())).toEqual({ checked: true, breached: true, count: 7 });
  });

  it("clears a password the corpus does not contain", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => httpResponse({
      ok: true, body: "1111111111111111111111111111111111111:9\n2222222222222222222222222222222222222:4",
    }) as unknown as Response));
    expect(await checkPasswordBreach("a genuinely unusual passphrase", breachOpts()))
      .toEqual({ checked: true, breached: false, count: 0 });
  });

  it("fails OPEN on a non-200, so a provider outage cannot block sign-up", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => httpResponse({ ok: false, status: 503, body: "" }) as unknown as Response));
    expect(await checkPasswordBreach("password", breachOpts()))
      .toEqual({ checked: false, breached: false, reason: "http" });
  });

  it("fails OPEN on an empty or unparseable body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => httpResponse({ ok: true, body: "" }) as unknown as Response));
    expect(await checkPasswordBreach("password", breachOpts()))
      .toEqual({ checked: false, breached: false, reason: "malformed" });
  });

  it("fails OPEN on a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    expect(await checkPasswordBreach("password", breachOpts()))
      .toEqual({ checked: false, breached: false, reason: "network" });
  });

  it("fails OPEN on timeout, bounded by timeoutMs, not a socket default", async () => {
    // A provider that never answers: the only thing that ends the wait is our AbortController.
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
      });
    })));
    const started = Date.now();
    const result = await checkPasswordBreach("password", breachOpts({ timeoutMs: 60 }));
    expect(result).toEqual({ checked: false, breached: false, reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

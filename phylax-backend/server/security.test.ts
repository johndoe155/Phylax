import { afterEach, describe, expect, it, vi } from "vitest";
import { isTrustedProxy, refreshCloudflareRanges, resetCloudflareRangesForTests } from "./net.js";
import { clientIp, parseCookies, rateLimitBucket } from "./http.js";
import { readCallback, redirectUri, authorizeUrl, isProviderConfigured } from "./auth/oauth.js";
import { loadConfig } from "./config.js";
import { spanIn } from "@shared/shifts";
import type { Request } from "express";

const config = loadConfig({ NODE_ENV: "test", APP_URL: "https://example.com", GOOGLE_CLIENT_ID: "client", GOOGLE_CLIENT_SECRET: "secret" });
describe("proxy boundaries", () => {
  afterEach(() => { vi.unstubAllGlobals(); resetCloudflareRangesForTests(); });

  it("only trusts loopback and published Cloudflare ranges", () => {
    expect(isTrustedProxy("127.0.0.1")).toBe(true);
    expect(isTrustedProxy("::ffff:127.0.0.1")).toBe(true);
    expect(isTrustedProxy("2606:4700::1234")).toBe(true);
    expect(isTrustedProxy("8.8.8.8")).toBe(false);
    expect(isTrustedProxy("10.1.2.3")).toBe(false);
    expect(isTrustedProxy("malformed")).toBe(false);
  });

  it("atomically installs both validated Cloudflare lists and stops trusting a withdrawn range", async () => {
    const oldAddress = "2606:4700::1234";
    const v4 = ["192.0.2.0/24", "198.51.100.0/24", "203.0.113.0/24", "192.0.0.0/24", "198.18.0.0/15", "100.64.0.0/10", "169.254.0.0/16", "172.16.0.0/12", "10.0.0.0/8", "192.168.0.0/16"];
    const v6 = ["2001:db8:1::/48", "2001:db8:2::/48", "2001:db8:3::/48", "2001:db8:4::/48", "2001:db8:5::/48"];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const body = String(input).endsWith("v4") ? v4.join("\n") : v6.join("\n");
      return { ok: true, status: 200, text: async () => body } as Response;
    }));
    expect(await refreshCloudflareRanges({ CLOUDFLARE_IPS_URL_V4: "https://unit.test/v4", CLOUDFLARE_IPS_URL_V6: "https://unit.test/v6" })).toBe(true);
    expect(isTrustedProxy(oldAddress)).toBe(false);
    expect(isTrustedProxy("192.0.2.1")).toBe(true);
    expect(isTrustedProxy("2001:db8:3::42")).toBe(true);
    // Loopback is never withdrawn; health checks and local ops keep working after the refresh.
    expect(isTrustedProxy("127.0.0.1")).toBe(true);
  });

  it("retains the last-known-good ranges if either fetched list is invalid", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const body = String(input).endsWith("v4") ? "" : "2001:db8::/32";
      return { ok: true, status: 200, text: async () => body } as Response;
    }));
    expect(await refreshCloudflareRanges({ CLOUDFLARE_IPS_URL_V4: "https://unit.test/v4", CLOUDFLARE_IPS_URL_V6: "https://unit.test/v6" })).toBe(false);
    expect(isTrustedProxy("2606:4700::1234")).toBe(true);
    expect(isTrustedProxy("8.8.8.8")).toBe(false);
  });
  it("does not read attacker-supplied forwarded headers by default", () => {
    const req = { ip: "8.8.8.8", socket: { remoteAddress: "8.8.8.8" }, headers: { "x-forwarded-for": "1.2.3.4" } } as unknown as Request;
    expect(clientIp(req)).toBe("8.8.8.8");
    expect(clientIp(req, isTrustedProxy)).toBe("8.8.8.8");
  });
  it("cookie names cannot pollute the object prototype", () => {
    const parsed = parseCookies("__proto__=bad; a=%ZZ");
    expect(Object.getPrototypeOf(parsed)).toBeNull();
    expect(parsed.a).toBe("%ZZ");
  });
});
// ---- finding 6: the anonymous auth ceiling must not be a service-wide denial of service -----------------------
describe("the auth attempt ceiling", () => {
  it("buckets an IPv6 caller to the /64 they actually control", () => {
    // A single IPv6 allocation is normally a /64: 2^64 addresses one person can rotate through freely. Keyed on
    // the raw address, a 120/hour per-address budget is not a limit at all.
    expect(rateLimitBucket("2001:db8:abcd:12::1")).toBe("2001:db8:abcd:12::/64");
    expect(rateLimitBucket("2001:db8:abcd:12:ffff:ffff:ffff:ffff")).toBe("2001:db8:abcd:12::/64");
    // Every address in the same allocation shares one budget.
    expect(rateLimitBucket("2001:db8:abcd:12::1")).toBe(rateLimitBucket("2001:db8:abcd:12::9999"));
    // A DIFFERENT allocation is a different budget, so this is not over-blocking.
    expect(rateLimitBucket("2001:db8:abcd:13::1")).not.toBe(rateLimitBucket("2001:db8:abcd:12::1"));
  });
  it("leaves IPv4 alone, including the mapped form a dual-stack socket reports", () => {
    expect(rateLimitBucket("203.0.113.7")).toBe("203.0.113.7");
    expect(rateLimitBucket("::ffff:203.0.113.7")).toBe("203.0.113.7");
    expect(rateLimitBucket(undefined)).toBe("unknown");
  });
});

describe("OAuth integration", () => {
  it("uses the mounted Express callback path", () => expect(redirectUri(config)).toBe("https://example.com/api/auth/oauth/callback"));
  it("reads Apple's form-post name", () => {
    expect(readCallback("apple", {}, { code: "code", state: "state", user: JSON.stringify({ name: { firstName: "Ada", lastName: "Lovelace" } }) })).toMatchObject({ code: "code", name: "Ada Lovelace" });
  });
  it("adds S256 PKCE to the authorization request", () => {
    const url = new URL(authorizeUrl("google", config, "signed-state", redirectUri(config), "verifier"));
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toHaveLength(43);
  });
  it("does not advertise Apple unless signing keys are configured", () => expect(isProviderConfigured("apple", config)).toBe(false));
});
describe("shift timezone boundaries", () => {
  it("handles a US spring-forward overnight shift", () => {
    const [start, end] = spanIn({ date: "2026-03-07", start: 23 * 60, end: 7 * 60 }, "America/New_York");
    expect(new Date(start).toISOString()).toBe("2026-03-08T04:00:00.000Z");
    expect(new Date(end).toISOString()).toBe("2026-03-08T11:00:00.000Z");
    expect((end - start) / 3600000).toBe(7);
  });
});

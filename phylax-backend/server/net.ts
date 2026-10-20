import { BlockList, isIP } from "node:net";
import type { Config } from "./config.js";
import { log } from "./log.js";

// The compiled list is an offline fallback, not the long-term source of truth. Cloudflare adds and withdraws
// ranges; a stale entry can either stop trusting a legitimate edge or, worse, keep trusting an address it no longer
// owns. `refreshCloudflareRanges` fetches both published lists, validates them in full, then atomically swaps the
// BlockList used by Express. A failed/partial fetch leaves the last good list (or this bootstrap list) untouched.
const DEFAULT_RANGES: readonly { base: string; bits: number }[] = [
  { base: "173.245.48.0", bits: 20 }, { base: "103.21.244.0", bits: 22 }, { base: "103.22.200.0", bits: 22 },
  { base: "103.31.4.0", bits: 22 }, { base: "141.101.64.0", bits: 18 }, { base: "108.162.192.0", bits: 18 },
  { base: "190.93.240.0", bits: 20 }, { base: "188.114.96.0", bits: 20 }, { base: "197.234.240.0", bits: 22 },
  { base: "198.41.128.0", bits: 17 }, { base: "162.158.0.0", bits: 15 }, { base: "104.16.0.0", bits: 13 },
  { base: "104.24.0.0", bits: 14 }, { base: "172.64.0.0", bits: 13 }, { base: "131.0.72.0", bits: 22 },
  { base: "2400:cb00::", bits: 32 }, { base: "2606:4700::", bits: 32 }, { base: "2803:f800::", bits: 32 },
  { base: "2405:b500::", bits: 32 }, { base: "2405:8100::", bits: 32 }, { base: "2a06:98c0::", bits: 29 },
  { base: "2c0f:f248::", bits: 32 },
];
const LOOPBACKS = [{ base: "127.0.0.0", bits: 8 }, { base: "::1", bits: 128 }] as const;

type Cidr = { base: string; bits: number; family: 4 | 6 };
const familyOf = (base: string): 4 | 6 => {
  const family = isIP(base);
  if (family !== 4 && family !== 6) throw new Error("invalid_ip");
  return family;
};
function buildBlockList(ranges: readonly Cidr[]): BlockList {
  const block = new BlockList();
  for (const range of ranges) block.addSubnet(range.base, range.bits, range.family === 6 ? "ipv6" : "ipv4");
  return block;
}
const bootstrap: Cidr[] = [
  ...DEFAULT_RANGES.map((r) => ({ ...r, family: familyOf(r.base) })),
  ...LOOPBACKS.map((r) => ({ ...r, family: familyOf(r.base) })),
];
let proxies = buildBlockList(bootstrap);
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let activeConfig: Pick<Config, "CLOUDFLARE_IPS_REFRESH" | "CLOUDFLARE_IPS_URL_V4" | "CLOUDFLARE_IPS_URL_V6" | "CLOUDFLARE_IPS_REFRESH_MS"> | null = null;
let refreshInFlight: Promise<boolean> | null = null;

/** Parse a newline-delimited CIDR list and reject malformed, empty, mixed-family or catch-all entries. */
function parseCidrs(text: string, familyExpected: 4 | 6): Cidr[] {
  if (text.length > 128_000) throw new Error("cloudflare_list_too_large");
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < (familyExpected === 4 ? 10 : 5) || lines.length > 256) throw new Error("cloudflare_list_size_invalid");
  const seen = new Set<string>();
  const parsed: Cidr[] = [];
  for (const line of lines) {
    const match = /^([^/\s]+)\/(\d{1,3})$/.exec(line);
    if (!match) throw new Error("cloudflare_cidr_invalid");
    const base = match[1]!;
    const family = familyOf(base);
    const bits = Number(match[2]);
    const max = family === 4 ? 32 : 128;
    // Refuse a family mix-up, a default/catch-all route, and duplicate entries before the list is installed.
    if (family !== familyExpected || !Number.isInteger(bits) || bits < 1 || bits > max) throw new Error("cloudflare_cidr_invalid");
    const key = `${base}/${bits}`;
    if (seen.has(key)) throw new Error("cloudflare_cidr_duplicate");
    seen.add(key);
    parsed.push({ base, bits, family });
  }
  return parsed;
}

async function fetchList(url: string, expected: 4 | 6): Promise<Cidr[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: "text/plain" } });
    if (!response.ok) throw new Error(`cloudflare_http_${response.status}`);
    return parseCidrs(await response.text(), expected);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fetch, validate and atomically install both of Cloudflare's published address lists.
 *
 * Uses the last-known-good pair until BOTH lists have been fetched and fully validated. Never installs a partial
 * pair, never replaces a good pair with an empty/error response, and has a five-second timeout per HTTP request.
 * Defaults are HTTPS Cloudflare endpoints; configured endpoints allow operators to use an egress proxy or a
 * controlled mirror, but malformed content is rejected identically.
 */
export async function refreshCloudflareRanges(
  config: Pick<Config, "CLOUDFLARE_IPS_URL_V4" | "CLOUDFLARE_IPS_URL_V6">,
): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const [v4, v6] = await Promise.all([
        fetchList(config.CLOUDFLARE_IPS_URL_V4, 4),
        fetchList(config.CLOUDFLARE_IPS_URL_V6, 6),
      ]);
      const next = buildBlockList([...v4, ...v6, ...LOOPBACKS.map((r) => ({ ...r, family: familyOf(r.base) }))]);
      proxies = next;
      log.info("Cloudflare proxy ranges refreshed", { ipv4: v4.length, ipv6: v6.length });
      return true;
    } catch (error) {
      log.warn("Cloudflare proxy range refresh failed; retaining last known-good ranges", {
        code: "cloudflare_range_refresh_failed",
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

/** Start one unref'd periodic refresh for this process and trigger the first fetch. */
export function configureCloudflareRanges(
  config: Pick<Config, "CLOUDFLARE_IPS_REFRESH" | "CLOUDFLARE_IPS_URL_V4" | "CLOUDFLARE_IPS_URL_V6" | "CLOUDFLARE_IPS_REFRESH_MS">,
): void {
  if (!config.CLOUDFLARE_IPS_REFRESH || activeConfig) return;
  activeConfig = config;
  void refreshCloudflareRanges(config);
  refreshTimer = setInterval(() => { void refreshCloudflareRanges(config); }, config.CLOUDFLARE_IPS_REFRESH_MS);
  refreshTimer.unref?.();
}

/** Reset for tests; production never calls this. */
export function resetCloudflareRangesForTests(): void {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
  activeConfig = null;
  refreshInFlight = null;
  proxies = buildBlockList(bootstrap);
}

export function isTrustedProxy(address: string | null | undefined): boolean {
  if (!address) return false;
  const value = address.replace(/^::ffff:/i, "");
  const family = isIP(value);
  return family !== 0 && proxies.check(value, family === 6 ? "ipv6" : "ipv4");
}
export const trustedProxyCheck = (address: string) => isTrustedProxy(address);

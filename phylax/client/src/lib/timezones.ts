/**
 * Timezones for the account page's alert settings.
 *
 * The list comes from the server (GET /api/meta/timezones). While it loads, and whenever it can't be had (offline, an error,
 * or a host that answers every path with the app's index.html, as this site's rewrite does), the page uses the short list
 * below so the select is never empty. Either way the person's own device timezone comes first, then the one they saved.
 */

export const TIMEZONES_URL = "/api/meta/timezones";
const TIMEOUT_MS = 8000;

/** Offline shortlist: the zones people most often work in, east to west is not the point, familiarity is. */
export const FALLBACK_TIMEZONES: readonly string[] = [
  "UTC",
  "America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu",
  "America/Toronto", "America/Vancouver", "America/Mexico_City", "America/Bogota", "America/Sao_Paulo", "America/Argentina/Buenos_Aires",
  "Europe/London", "Europe/Dublin", "Europe/Lisbon", "Europe/Paris", "Europe/Berlin", "Europe/Madrid", "Europe/Rome", "Europe/Athens", "Europe/Moscow",
  "Africa/Lagos", "Africa/Accra", "Africa/Cairo", "Africa/Nairobi", "Africa/Johannesburg",
  "Asia/Dubai", "Asia/Karachi", "Asia/Kolkata", "Asia/Dhaka", "Asia/Bangkok", "Asia/Singapore", "Asia/Shanghai", "Asia/Manila", "Asia/Tokyo", "Asia/Seoul",
  "Australia/Perth", "Australia/Sydney", "Pacific/Auckland",
];

/** Whether the runtime knows this IANA zone. Keeps a stray string from the server out of the select. */
export function isValidTimezone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The device's own timezone, or null when the browser won't say. */
export function deviceTimezone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && isValidTimezone(zone) ? zone : null;
  } catch {
    return null;
  }
}

/** Device zone first, then the saved one, then everything else once, in the order given. */
export function orderTimezones(list: readonly string[], device: string | null, saved: string | null): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const zone of [device, saved, ...list]) {
    if (!zone || seen.has(zone)) continue;
    seen.add(zone);
    out.push(zone);
  }
  return out;
}

/** Accepts ["Africa/Lagos"], { timezones: [...] }, or arrays of { id | name | value | zone }. Anything else is an empty list. */
export function parseTimezones(payload: unknown): string[] {
  const source = Array.isArray(payload) ? payload : payload && typeof payload === "object" && Array.isArray((payload as { timezones?: unknown }).timezones) ? (payload as { timezones: unknown[] }).timezones : [];
  const zones: string[] = [];
  for (const item of source) {
    const zone = typeof item === "string" ? item : item && typeof item === "object" ? (["id", "name", "value", "zone"] as const).map((k) => (item as Record<string, unknown>)[k]).find((v): v is string => typeof v === "string") : undefined;
    if (zone && isValidTimezone(zone)) zones.push(zone);
  }
  return zones;
}

/** GET /api/meta/timezones. Rejects (so the caller falls back) on a network error, a non-2xx answer, a non-JSON body or an empty list. */
export async function fetchTimezones(signal?: AbortSignal): Promise<string[]> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(TIMEZONES_URL, { headers: { Accept: "application/json" }, credentials: "same-origin", signal: controller.signal });
    if (!response.ok) throw new Error(`Timezones request failed (${response.status})`);
    const type = response.headers.get("content-type") ?? "";
    if (!type.includes("json")) throw new Error("Timezones answer was not JSON");
    const zones = parseTimezones(await response.json());
    if (zones.length === 0) throw new Error("Timezones answer was empty");
    return zones;
  } finally {
    window.clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

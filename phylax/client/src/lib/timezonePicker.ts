import { ABBREVIATIONS, COUNTRY_ZONES, LEGACY_ZONES, SEARCH_WORDS } from "./timezoneData";

/**
 * The logic behind the account page's timezone picker: how a zone is named and grouped, what a person's query matches, and
 * what time it is in a zone. Pure and DOM-free, so it is tested on its own (timezonePicker.test.ts).
 */

export type ZoneInfo = {
  id: string;
  /** "Buenos Aires" for America/Argentina/Buenos_Aires. */
  city: string;
  /** Country, or the sub-region / continent when the zone has no country (UTC, Etc/*). */
  place: string;
  region: string;
  /** Normalised text a query is matched against: city, place, id, search words. */
  words: string[];
  abbrs: string[];
};

export type ZoneClock = { offset: number; time: string; dayShift: -1 | 0 | 1 };

// ---- Names -----------------------------------------------------------------------------------------------------------

const REGIONS: Record<string, string> = { Africa: "Africa", America: "Americas", Antarctica: "Antarctica", Arctic: "Arctic", Asia: "Asia", Atlantic: "Atlantic", Australia: "Australia", Europe: "Europe", Indian: "Indian Ocean", Pacific: "Pacific" };
export const OTHER_REGION = "UTC & fixed offsets";

let countryOf: Map<string, string> | null = null;
let abbrsOf: Map<string, string[]> | null = null;
let regionNames: Intl.DisplayNames | null | undefined;

function countryCode(zone: string): string | undefined {
  if (!countryOf) {
    countryOf = new Map();
    for (const [code, zones] of Object.entries(COUNTRY_ZONES)) for (const z of zones.split(" ")) countryOf.set(z, code);
  }
  return countryOf.get(zone);
}

function countryName(code: string): string {
  if (regionNames === undefined) {
    try { regionNames = new Intl.DisplayNames(["en"], { type: "region" }); } catch { regionNames = null; }
  }
  try { return regionNames?.of(code) ?? code; } catch { return code; }
}

function abbreviationsFor(zone: string): string[] {
  if (!abbrsOf) {
    abbrsOf = new Map();
    for (const [abbr, zones] of Object.entries(ABBREVIATIONS)) for (const z of zones.split(" ")) abbrsOf.set(z, [...(abbrsOf.get(z) ?? []), abbr]);
  }
  return abbrsOf.get(zone) ?? [];
}

/** Lower-case, accents and punctuation out, so "São Paulo", "sao_paulo" and "SAO PAULO" are one thing. */
export function normalize(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9+:\- ]+/g, " ").replace(/[_/]+/g, " ").replace(/\s+/g, " ").trim();
}

export function canonicalZone(zone: string): string {
  return LEGACY_ZONES[zone] ?? zone;
}

const infoCache = new Map<string, ZoneInfo>();

export function describeZone(rawId: string): ZoneInfo {
  const cached = infoCache.get(rawId);
  if (cached) return cached;
  const id = canonicalZone(rawId);
  const parts = id.split("/");
  const head = parts[0];
  const fixed = /^Etc\/GMT([+-])(\d{1,2})$/.exec(id);
  let city = (parts[parts.length - 1] ?? id).replace(/_/g, " ");
  let place: string;
  let region = REGIONS[head] ?? OTHER_REGION;
  if (fixed) {
    // Etc/GMT+5 is five hours *behind* UTC; the sign is the other way round on purpose, so say it the way people read it.
    city = `UTC${fixed[1] === "+" ? "−" : "+"}${fixed[2].padStart(2, "0")}:00`;
    place = "Fixed offset, no daylight saving";
    region = OTHER_REGION;
  } else if (id === "UTC") {
    city = "UTC";
    place = "Coordinated Universal Time";
  } else {
    const code = countryCode(id);
    place = code ? countryName(code) : parts.length > 2 ? parts[1].replace(/_/g, " ") : (REGIONS[head] ?? head);
  }
  const abbrs = abbreviationsFor(id);
  const words = [city, place, id, parts.slice(1, -1).join(" "), SEARCH_WORDS[id] ?? ""].map(normalize).filter(Boolean);
  const info: ZoneInfo = { id: rawId, city, place, region, words, abbrs };
  infoCache.set(rawId, info);
  return info;
}

export function sameZone(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  return canonicalZone(a) === canonicalZone(b);
}

// ---- Grouping ---------------------------------------------------------------------------------------------------------

export type ZoneGroup = { label: string; zones: string[] };

/** Continent groups in alphabetical order (fixed offsets last), each sorted by city. */
export function groupByRegion(zones: readonly string[]): ZoneGroup[] {
  const groups = new Map<string, string[]>();
  for (const zone of zones) {
    const { region } = describeZone(zone);
    groups.set(region, [...(groups.get(region) ?? []), zone]);
  }
  return [...groups.entries()]
    .map(([label, list]) => ({ label, zones: list.sort((a, b) => describeZone(a).city.localeCompare(describeZone(b).city, "en", { numeric: true })) }))
    .sort((a, b) => (a.label === OTHER_REGION ? 1 : b.label === OTHER_REGION ? -1 : a.label.localeCompare(b.label)));
}

// ---- Clocks -----------------------------------------------------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat | null>();

function formatterFor(zone: string | undefined): Intl.DateTimeFormat | null {
  const key = zone ?? "";
  let f = formatters.get(key);
  if (f === undefined) {
    try {
      f = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    } catch { f = null; }
    formatters.set(key, f);
  }
  return f;
}

/** Builds the formatter for a zone ahead of time, so the first open of the picker does not pay for hundreds at once. */
export function warmZone(zone: string): void {
  formatterFor(zone);
}

function readParts(f: Intl.DateTimeFormat, at: Date) {
  const v: Record<string, number> = {};
  for (const p of f.formatToParts(at)) if (p.type !== "literal") v[p.type] = Number(p.value);
  return { y: v.year, mo: v.month, d: v.day, h: v.hour % 24, mi: v.minute, s: v.second };
}

/** Whether the device shows a 12-hour clock. */
export function deviceUses12Hour(): boolean {
  try {
    const cycle = new Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions().hourCycle;
    return cycle === "h12" || cycle === "h11";
  } catch { return false; }
}

export function formatClock(h: number, mi: number, twelve: boolean): string {
  const mm = String(mi).padStart(2, "0");
  if (!twelve) return `${String(h).padStart(2, "0")}:${mm}`;
  return `${h % 12 === 0 ? 12 : h % 12}:${mm} ${h < 12 ? "AM" : "PM"}`;
}

/** The zone's local time, its UTC offset in minutes right now, and whether its date is the device's yesterday / tomorrow. Null for an unknown zone. */
export function zoneClock(zone: string, at: Date, twelve = false): ZoneClock | null {
  const f = formatterFor(zone), here = formatterFor(undefined);
  if (!f || !here) return null;
  const p = readParts(f, at), q = readParts(here, at);
  const offset = Math.round((Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(at.getTime() / 1000) * 1000) / 60000);
  const days = Math.round((Date.UTC(p.y, p.mo - 1, p.d) - Date.UTC(q.y, q.mo - 1, q.d)) / 864e5);
  return { offset, time: formatClock(p.h, p.mi, twelve), dayShift: days > 0 ? 1 : days < 0 ? -1 : 0 };
}

/** "UTC+01:00", "UTC−05:30", "UTC±00:00" for zero. */
export function formatOffset(minutes: number): string {
  if (minutes === 0) return "UTC+00:00";
  const abs = Math.abs(minutes);
  return `UTC${minutes < 0 ? "−" : "+"}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

// ---- Search -----------------------------------------------------------------------------------------------------------

/** "+01:00", "-5", "+5:30", "UTC+1", "gmt-0530" become minutes; anything else is null. `exact` is false when only the hour was typed ("+5" also finds +5:30). */
export function parseOffsetQuery(query: string): { minutes: number; exact: boolean } | null {
  const m = /^(?:utc|gmt)?\s*([+\-−])\s*(\d{1,2})(?::?(\d{2}))?$/i.exec(query.trim());
  if (!m) return null;
  const hours = Number(m[2]), mins = m[3] ? Number(m[3]) : 0;
  if (hours > 14 || mins > 59) return null;
  return { minutes: (m[1] === "+" ? 1 : -1) * (hours * 60 + mins), exact: m[3] !== undefined };
}

function isSubsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (const ch of hay) if (ch === needle[i] && ++i === needle.length) return true;
  return needle.length === 0;
}

/** One-edit distance (insert, delete, substitute, swap): forgives "londn", "lagso", "tokya". */
function withinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (i === a.length || i === b.length) return true;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1) || (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2));
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

/** Lower is better; Infinity is no match. Scores one query word against one field of words. */
function scoreToken(token: string, field: string, primary: boolean): number {
  const base = primary ? 0 : 20;
  if (field === token) return base;
  if (field.startsWith(token)) return base + 2;
  const words = field.split(" ");
  if (words.some((w) => w.startsWith(token))) return base + 4;
  if (token.length > 1 && field.includes(token)) return base + 8;
  if (token.length >= 3 && words.some((w) => w.length >= 4 && withinOneEdit(token, w.slice(0, Math.max(token.length, 4))))) return base + 12;
  // Letters in order ("bnsaires"): only against the city, and only for a real word, or "nigeria" would find Los Angeles.
  if (primary && token.length >= 4 && isSubsequence(token, field.replace(/ /g, ""))) return base + 16;
  return Infinity;
}

function scoreZone(info: ZoneInfo, tokens: string[]): number {
  let total = 0;
  for (const raw of tokens) {
    const token = raw.toLowerCase();
    let best = Infinity;
    if (info.abbrs.some((a) => a.toLowerCase() === token)) best = 1;
    info.words.forEach((field, i) => { best = Math.min(best, scoreToken(token, field, i === 0)); });
    if (best === Infinity) return Infinity;
    total += best;
  }
  return total;
}

/**
 * The zones a query matches, best first. Handles names ("lagos", "new york", "nigeria"), abbreviations ("est", "wat") and
 * offsets ("+01:00", "-5"). `offsetOf` supplies a zone's current offset in minutes, and is only called for offset queries.
 */
export function searchZones(zones: readonly string[], query: string, offsetOf: (zone: string) => number | null): string[] {
  const q = query.trim();
  if (!q) return [...zones];
  const wanted = parseOffsetQuery(q);
  if (wanted) {
    const hits: { zone: string; rank: number }[] = [];
    for (const zone of zones) {
      const offset = offsetOf(zone);
      if (offset === null) continue;
      if (offset === wanted.minutes) hits.push({ zone, rank: 0 });
      else if (!wanted.exact && Math.trunc(offset / 60) === Math.trunc(wanted.minutes / 60) && Math.sign(offset) === Math.sign(wanted.minutes)) hits.push({ zone, rank: 1 });
    }
    return hits.sort((a, b) => a.rank - b.rank || describeZone(a.zone).city.localeCompare(describeZone(b.zone).city)).map((h) => h.zone);
  }
  const tokens = normalize(q).split(" ").filter(Boolean);
  if (!tokens.length) return [];
  return zones
    .map((zone, order) => ({ zone, order, score: scoreZone(describeZone(zone), tokens) }))
    .filter((h) => h.score !== Infinity)
    .sort((a, b) => a.score - b.score || a.order - b.order)
    .map((h) => h.zone);
}

// ---- Recent picks -------------------------------------------------------------------------------------------------------

export const RECENT_KEY = "phylax:timezones:recent";
export const RECENT_MAX = 4;
export const SUGGESTED: readonly string[] = ["UTC", "America/New_York", "America/Los_Angeles", "Europe/London"];

/** Newest first, no repeats, at most RECENT_MAX. */
export function pushRecent(list: readonly string[], zone: string): string[] {
  return [zone, ...list.filter((z) => !sameZone(z, zone))].slice(0, RECENT_MAX);
}

export function readRecent(storage: Pick<Storage, "getItem"> | null): string[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((z): z is string => typeof z === "string").slice(0, RECENT_MAX) : [];
  } catch { return []; }
}

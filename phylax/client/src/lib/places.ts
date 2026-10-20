// Suggestions for the "Log a shift" form, read from shifts the person has already logged. Pure and framework-free:
// the form hands in its history and what has been typed so far, and gets back a short, ranked list.
import type { Shift } from "./shifts";

export type FacilityHit = { facility: string; address: string; uses: number; last: string };
export type AddressHit = { address: string; facility: string; uses: number; last: string };

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** 0 = the text starts with the query, 1 = a word in it does, 2 = it appears inside, -1 = no match. An empty query matches everything. */
export function rank(text: string, query: string): number {
  const q = norm(query);
  if (!q) return 0;
  const t = norm(text);
  if (t.startsWith(q)) return 0;
  if (t.includes(" " + q)) return 1;
  return t.includes(q) ? 2 : -1;
}

/** Splits `text` around the first case-insensitive match of `query`, for highlighting. */
export function splitMatch(text: string, query: string): [string, string, string] {
  const q = query.trim();
  const at = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  return at < 0 ? [text, "", ""] : [text.slice(0, at), text.slice(at, at + q.length), text.slice(at + q.length)];
}

type Tally = { name: string; other: string; uses: number; last: string; otherLast: string };

// One pass over the history, grouped by `key`. `name` is the spelling from the most recent shift; `other` is the most
// recent non-empty value of the paired field (a facility's address, or an address's facility).
function tally(history: Shift[], key: (s: Shift) => string, name: (s: Shift) => string, other: (s: Shift) => string): Tally[] {
  const groups = new Map<string, Tally>();
  for (const s of history) {
    const k = norm(key(s));
    if (!k) continue;
    const g = groups.get(k);
    const o = other(s).trim();
    if (!g) { groups.set(k, { name: name(s).trim(), other: o, uses: 1, last: s.date, otherLast: o ? s.date : "" }); continue; }
    g.uses += 1;
    if (s.date >= g.last) { g.last = s.date; g.name = name(s).trim(); }
    if (o && s.date >= g.otherLast) { g.other = o; g.otherLast = s.date; }
  }
  return [...groups.values()];
}

const order = (a: { uses: number; last: string }, b: { uses: number; last: string }) => b.uses - a.uses || (a.last < b.last ? 1 : a.last > b.last ? -1 : 0);

/** Facilities from past shifts that match what is typed: closest match first, then most used, then most recent. */
export function suggestFacilities(history: Shift[], query: string, limit = 5): FacilityHit[] {
  return tally(history, (s) => s.facility, (s) => s.facility, (s) => s.address ?? "")
    .map((g) => ({ hit: { facility: g.name, address: g.other, uses: g.uses, last: g.last }, r: rank(g.name, query) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || order(a.hit, b.hit) || a.hit.facility.localeCompare(b.hit.facility))
    .slice(0, limit)
    .map((x) => x.hit);
}

/**
 * Addresses from past shifts that match what is typed. When a facility is already filled in, its own addresses come first,
 * so picking a known facility and then opening the address field offers the right one straight away.
 */
export function suggestAddresses(history: Shift[], query: string, facility = "", limit = 5): AddressHit[] {
  const f = norm(facility);
  const atFacility = (a: string) => Boolean(f) && history.some((s) => norm(s.facility) === f && norm(s.address ?? "") === norm(a));
  return tally(history, (s) => s.address ?? "", (s) => s.address ?? "", (s) => s.facility)
    .map((g) => ({ hit: { address: g.name, facility: g.other, uses: g.uses, last: g.last }, r: rank(g.name, query) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => Number(atFacility(b.hit.address)) - Number(atFacility(a.hit.address)) || a.r - b.r || order(a.hit, b.hit) || a.hit.address.localeCompare(b.hit.address))
    .slice(0, limit)
    .map((x) => x.hit);
}

export const sameText = (a: string, b: string) => norm(a) === norm(b);

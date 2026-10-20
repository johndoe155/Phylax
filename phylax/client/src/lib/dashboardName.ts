/**
 * The name written over "YOUR" in the dashboard's "YOUR STACK" heading (pages/Dashboard.tsx, .dash-name in dashboard.css).
 * Pure, so the page and the tests share the sizing rule.
 *
 * SIZE. The note is Marker Hand, set in em of the heading (so it keeps its place from a phone to a wide desktop) and it
 * gets smaller the longer the name is, so a short name is big and bold while a long one still fits over the heading:
 *
 *     size = clamp(NAME_SIZE_MIN, NAME_SIZE_BASE / characters, NAME_SIZE_MAX)
 *
 * "characters" counts what the person sees in "<name>'s". Marker Hand averages about 0.68em per character, so
 * NAME_SIZE_BASE (8.5) aims for a line about 5.8 heading-ems wide, well wider than "YOUR" so it spans the word. The two limits are what keep the extremes sensible:
 *   - NAME_SIZE_MAX: a one- or two-letter name does not turn into a banner taller than the word it replaces.
 *   - NAME_SIZE_MIN: a 40-character name (the longest the account page accepts) stays legible on a 320px phone. A name that
 *     is still too wide at this size wraps onto a second line inside the page's width (see .dash-name-box) instead of
 *     shrinking further or running off the screen.
 */
import { displayNameLength, normalizeDisplayName } from "./displayName";

/** Smallest the name is ever written, in em of the heading (about 26px on a 360px phone, where the heading is 52px). */
export const NAME_SIZE_MIN = 0.5;
/** Largest the name is ever written, in em of the heading: a little taller than the heading's own letters. */
export const NAME_SIZE_MAX = 1.25;
/** Heading-ems of line width the size aims for, divided by Marker Hand's ~0.68em average advance. */
export const NAME_SIZE_BASE = 8.5;

/** "Sam" -> "Sam's". Undefined when there is no name to show (nobody signed in, or the stored name is blank). */
export function possessiveName(raw: string | null | undefined): string | undefined {
  const name = typeof raw === "string" ? normalizeDisplayName(raw) : "";
  return name ? `${name}'s` : undefined;
}

/** Font size for this label, in em of the heading, never outside [NAME_SIZE_MIN, NAME_SIZE_MAX]. */
export function nameSizeEm(label: string): number {
  const characters = Math.max(1, displayNameLength(label));
  const size = Math.min(NAME_SIZE_MAX, Math.max(NAME_SIZE_MIN, NAME_SIZE_BASE / characters));
  return Math.round(size * 1000) / 1000;
}

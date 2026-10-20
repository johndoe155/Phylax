/**
 * Rules for the name a person picks in the account flow (pages/Onboarding.tsx).
 *
 * Pure, so the browser and the server apply exactly the same rule. The server has to: the browser's check is a
 * convenience, and the server's is the one that counts.
 */

/** The longest name the product allows. */
export const DISPLAY_NAME_MAX = 40;

/** Trims the ends and collapses runs of whitespace, so "  Sam   Ortiz " is stored as "Sam Ortiz". */
export function normalizeDisplayName(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

// One visible character per grapheme, so an emoji or an accented letter built from several code points counts once.
const segmenter =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

/** How many characters the person sees in the (normalised) name. */
export function displayNameLength(raw: string): number {
  const value = normalizeDisplayName(raw);
  return segmenter ? Array.from(segmenter.segment(value)).length : Array.from(value).length;
}

/** The message to show for this name, or undefined when it is fine. Written as what to do, not what went wrong. */
export function validateDisplayName(raw: string): string | undefined {
  if (!normalizeDisplayName(raw)) return "Enter the name you'd like to be called.";
  if (displayNameLength(raw) > DISPLAY_NAME_MAX) return `Use ${DISPLAY_NAME_MAX} characters or fewer.`;
  return undefined;
}

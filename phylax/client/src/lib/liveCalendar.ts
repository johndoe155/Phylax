/**
 * Live day-of-month for the tear-off-calendar sketch (assets/pricing-icons/2-tear-off-calendar.svg).
 *
 * The SVG file carries its own <script> that does this when the file is opened on its own. Inside the app the sketches
 * are inlined with dangerouslySetInnerHTML, where browsers never run <script>, so PricingIconCycle strips it and draws
 * the date itself.
 *
 * The date is written INTO THE MARKUP (`withCalendarDay`) before it is handed to React, rather than patched into the
 * DOM after mount. The old approach mutated nodes inside a React-owned dangerouslySetInnerHTML subtree from a
 * mount-only effect; any time that subtree was re-created the patch was lost and the file's static "14" came back.
 * With the digits part of the string, the right day is there on first paint and whenever the markup is re-set.
 */

/** Matches the <script> blocks that must be removed before an SVG is injected as markup. */
const SCRIPT_RE = /<script[\s\S]*?<\/script>/gi;

/** The date slot in the calendar file: everything between these two comments is replaced. */
const DATE_SLOT_RE = /(<!--cal-date-->)[\s\S]*?(<!--\/cal-date-->)/;

/** Removes <script> blocks from raw SVG markup (they cannot run via innerHTML anyway). */
export function stripSvgScripts(markup: string): string {
  return markup.replace(SCRIPT_RE, "");
}

/** One hand-drawn digit (glyph ids cal-d0 ... cal-d9) at x, with the faint second pass like the rest of the sketch.
 * Both `href` and `xlink:href` are given so older Safari, which only knows the latter, still resolves it. */
function digitMarkup(digit: string, x: number): string {
  const ref = `href="#cal-d${digit}" xlink:href="#cal-d${digit}"`;
  return (
    `<g transform="translate(${x},47)"><use ${ref}/>` +
    `<use ${ref} transform="translate(0.5,-0.4)" stroke-width="1" opacity="0.5"/></g>`
  );
}

/** The digits for a day of month (1-31): a single digit is centred, two digits sit side by side. */
export function dayDigitsMarkup(day: number): string {
  const s = String(Math.min(31, Math.max(1, Math.trunc(day) || 1)));
  return s.length === 1 ? digitMarkup(s, 44) : digitMarkup(s.charAt(0), 37) + digitMarkup(s.charAt(1), 51);
}

/** Returns the calendar SVG markup with `day` drawn in its date slot and in its aria-label. */
export function withCalendarDay(markup: string, day: number): string {
  return markup
    .replace(DATE_SLOT_RE, (_m, open: string, close: string) => `${open}${dayDigitsMarkup(day)}${close}`)
    .replace('aria-label="Tear-off calendar"', `aria-label="Tear-off calendar, day ${day}"`);
}

/** Viewer's LOCAL day of month (not the server's, not UTC). */
export function localDay(now: Date = new Date()): number {
  return now.getDate();
}

/** Milliseconds until one second past the next local midnight. Built from local date parts so DST changes are handled
 * by the Date constructor rather than by adding 24h of milliseconds. */
export function msUntilNextLocalDay(now: Date = new Date()): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1);
  return Math.max(1000, next.getTime() - now.getTime());
}

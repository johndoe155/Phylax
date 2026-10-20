/**
 * The shift domain: the rules that decide whether two shifts clash.
 *
 * This module is the single source of truth for that maths. It is imported by the browser (through the `@shared`
 * alias) AND by the Express server (through the esbuild `--alias:@shared` flag), so the conflict the person sees in
 * the app and the conflict the reminder scheduler emails them about can never disagree.
 *
 * It is deliberately free of any runtime dependency: no React, no Node, no DOM. Everything is plain data and pure
 * functions, which is what makes it shareable and testable.
 *
 * TIME MODEL
 * A shift is a `date` (the day it STARTS, `YYYY-MM-DD`) plus `start` and `end`, both in MINUTES AFTER MIDNIGHT.
 * A pattern whose `end` is not after its `start` runs overnight and belongs to two calendar days: it is the
 * continuous block from `start` on `date` to `end` on the following day.
 *
 * The rules the product calls "the three checks" live in `compare` below.
 */

/** The staffing apps a shift can be logged against. The order is the order the picker shows them in. */
export const PLATFORMS = ["ShiftKey", "CareRev", "ShiftMed", "Clipboard Health", "IntelyCare"] as const;
export type Platform = (typeof PLATFORMS)[number];

/** A saved "tile": a facility plus the hours worked there, without a date. */
export type Pattern = {
  id: string;
  facility: string;
  label: string;
  start: number;
  end: number;
  /** Where it is worked. Optional: added in migration 018, absent on rows saved before it. */
  address?: string | null;
};

/** A logged shift: a pattern, plus the app it came from and the day it starts. */
export type Shift = Pattern & {
  platform: string;
  date: string;
  note?: string | null;
  /** Who to call about this shift. Optional: added in migration 018, absent on rows saved before it. */
  contact?: string | null;
  /** Server version for optimistic concurrency. Anonymous/local shifts have no server version. */
  version?: number;
};

/** The person's own thresholds, editable on the dashboard. */
export type Rules = { travelMin: number; cancelHrs: number };

/** What went wrong between two shifts. */
export type Issue = {
  kind: "overlap" | "tight";
  /** The other shift involved. */
  other: Shift;
  /** How long the problem lasts, in minutes. */
  minutes: number;
  /** For an overlap: the absolute start and end of the shared window. */
  overlap?: [number, number];
};

export const DEFAULT_RULES: Rules = { travelMin: 60, cancelHrs: 24 };

/** The same saved patterns the landing page's "Saved tiles" section shows. */
export const DEFAULT_PATTERNS: Pattern[] = (
  [
    ["Riverside Manor", "Day", 7, 19],
    ["Riverside Manor", "Night", 19, 7],
    ["St. Anne's", "8-hour day", 7, 15],
    ["Greenfield Rehab", "Evening", 15, 23],
    ["Harbor View", "Early", 6, 14],
    ["Maple Court", "Short", 16, 20],
  ] as const
).map(([facility, label, s, e], i) => ({
  id: `p${i}`,
  facility,
  label,
  start: s * 60,
  end: e * 60,
}));

export const HOUR = 3600000;
export const MINUTES_PER_DAY = 1440;

/** A short, collision-resistant id for a row created in the browser. */
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/** "07:30" -> 450. Anything that is not a valid time reads as midnight, so a stray value never breaks the form. */
export const toMin = (v: string) => {
  const [h, m] = v.split(":").map(Number);
  return h * 60 + m;
};

/** Minutes -> "HH:MM", always zero-padded, always inside a day. */
export const clockValue = (mins: number) => {
  const m = (((Math.round(mins) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

/** `YYYY-MM-DD` for a Date, in LOCAL time. */
export const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** `YYYY-MM-DD` for the day `n` days from `from`. */
export const inDays = (n: number, from: Date | number = Date.now()) => {
  const d = new Date(from);
  d.setDate(d.getDate() + n);
  return ymd(d);
};

/**
 * The absolute start and end of a shift, as epoch milliseconds.
 * A pattern whose end is not after its start runs overnight, so it ends on the NEXT day.
 */
export const span = (s: Pick<Shift, "date" | "start" | "end">): [number, number] => {
  const [y, m, d] = s.date.split("-").map(Number);
  const start = new Date(y, m - 1, d, 0, s.start).getTime();
  const end = new Date(y, m - 1, d + (s.end <= s.start ? 1 : 0), 0, s.end).getTime();
  return [start, end];
};

/**
 * How far ahead of UTC a timezone is, in milliseconds, at a given instant.
 *
 * The offset is not a constant: a zone that is one hour ahead in winter is two hours ahead in summer, and the
 * change happens on different days in different places. So it has to be looked up for the moment in question,
 * which is what `Intl.DateTimeFormat` does.
 */
const zoneFormatters=new Map<string,Intl.DateTimeFormat>();
export const zoneOffsetMs = (timeZone: string, at: number): number => {
  let formatter=zoneFormatters.get(timeZone);
  if(!formatter){formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  if(zoneFormatters.size>=64)zoneFormatters.delete(zoneFormatters.keys().next().value!);zoneFormatters.set(timeZone,formatter);}
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(new Date(at))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  const hour = parts.hour === 24 ? 0 : (parts.hour ?? 0);
  const asUtc = Date.UTC(parts.year ?? 1970, (parts.month ?? 1) - 1, parts.day ?? 1, hour, parts.minute ?? 0, parts.second ?? 0);
  return asUtc - at;
};

/**
 * The absolute start and end of a shift, in a named timezone.
 *
 * `span` above uses the machine's own timezone, which is right in the browser: the person is looking at their
 * own clock. It is wrong on the server, which runs in UTC and deals with people in other zones: a 7 p.m. shift
 * in Europe/London is not 7 p.m. UTC, and the difference decides when a cancellation window closes.
 *
 * The wall-clock time is first read as though it were UTC, and then the zone's offset at that moment is taken
 * off. The offset is looked up twice, once for each end, so a shift that crosses a daylight-saving change is
 * still the right number of hours long.
 */
export const spanIn = (
  s: Pick<Shift, "date" | "start" | "end">,
  timeZone: string,
): [number, number] => {
  const [y, m, d] = s.date.split("-").map(Number);
  const startWall = Date.UTC(y, m - 1, d, 0, s.start);
  const endWall = Date.UTC(y, m - 1, d + (s.end <= s.start ? 1 : 0), 0, s.end);
  const instant = (wall: number) => {
    const candidate = wall - zoneOffsetMs(timeZone, wall);
    // Re-evaluate at the actual instant, not the provisional UTC wall time, near DST transitions.
    const adjusted = wall - zoneOffsetMs(timeZone, candidate);
    return adjusted;
  };
  const start = instant(startWall);
  const end = instant(endWall);
  return [start, end];
};

/** The calendar day, in a named timezone, as `YYYY-MM-DD`. */
export const localDate = (timeZone: string, at: number = Date.now()): string => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(at));
  return parts;
};

/** The length of a shift in minutes. Equal start and end is not a shift (0). */
export const lengthBetween = (start: number, end: number) => (end === start ? 0 : (end - start + MINUTES_PER_DAY) % MINUTES_PER_DAY);

/** "7P" / "6:30A" — the landing page's compact clock. */
export const t = (m: number) =>
  `${Math.floor(m / 60) % 12 || 12}${m % 60 ? ":" + String(m % 60).padStart(2, "0") : ""}${Math.floor(m / 60) % 24 >= 12 ? "P" : "A"}`;

/** "7" / "6:30" — the same clock without the meridiem. */
export const hr = (m: number) =>
  `${Math.floor(m / 60) % 12 || 12}${m % 60 ? ":" + String(m % 60).padStart(2, "0") : ""}`;

/** "7P–7A" */
export const clockRange = (s: Pick<Shift, "start" | "end">) => `${t(s.start)}–${t(s.end)}`;

/** "FRI, MAR 14" */
export const dateLabel = (date: string) =>
  new Date(date + "T00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }).toUpperCase();

/** "8 HR 30 MIN" */
export const dur = (min: number) => {
  const m = Math.round(min);
  const h = Math.floor(m / 60);
  const r = m % 60;
  return [h && `${h} HR`, r && `${r} MIN`].filter(Boolean).join(" ") || "0 MIN";
};

/** "3 hours" / "45 minutes" / "9 days" — a rough, human duration. */
export const left = (ms: number) => {
  const h = ms / HOUR;
  if (h < 1) return `${Math.max(1, Math.round(ms / 60000))} minutes`;
  if (h < 48) return `${Math.round(h)} hours`;
  return `${Math.round(h / 24)} days`;
};

/**
 * THE FIRST CHECK: do two shifts overlap?
 *
 * An overlap wins outright, whatever the facilities are: a 7 p.m. to 7 a.m. shift is one continuous block, so it is
 * checked against the next morning too.
 *
 * The SECOND CHECK (a tight travel window) only applies between DIFFERENT facilities: the same facility twice in a
 * row is a long shift, not a drive.
 *
 * @returns null when the two shifts are fine together.
 */
export function compare(a: Shift, b: Shift, rules: Rules, timeZone?: string): Omit<Issue, "other"> | null {
  const [as, ae] = timeZone ? spanIn(a, timeZone) : span(a);
  const [bs, be] = timeZone ? spanIn(b, timeZone) : span(b);
  return compareSpans(a,b,rules,[as,ae],[bs,be]);
}
export function compareSpans(a:Shift,b:Shift,rules:Rules,[as,ae]:[number,number],[bs,be]:[number,number]):Omit<Issue,"other">|null {
  const lo = Math.max(as, bs);
  const hi = Math.min(ae, be);
  if (hi > lo) return { kind: "overlap", minutes: (hi - lo) / 60000, overlap: [lo, hi] };
  const gap = (as >= be ? as - be : bs - ae) / 60000;
  const sameSite = a.facility.trim().toLowerCase() === b.facility.trim().toLowerCase();
  return !sameSite && gap < rules.travelMin ? { kind: "tight", minutes: gap } : null;
}

/** Sweep upcoming spans once. Output-sensitive O(n log n + nearby pairs), not all-pairs timezone formatting. */
export function conflictPairs(shifts:Shift[],rules:Rules,zone?:string,now=Number.NEGATIVE_INFINITY){
 const items=shifts.map(s=>({s,t:zone?spanIn(s,zone):span(s)})).filter(x=>x.t[1]>now).sort((a,b)=>a.t[0]-b.t[0]);
 const result:{a:Shift;b:Shift;issue:Omit<Issue,"other">;expires:number}[]=[];
 for(let i=0;i<items.length;i++)for(let j=i+1;j<items.length && items[j].t[0]<=items[i].t[1]+rules.travelMin*60000;j++){
  const issue=compareSpans(items[i].s,items[j].s,rules,items[i].t,items[j].t);
  if(issue)result.push({a:items[i].s,b:items[j].s,issue,expires:Math.min(items[i].t[1],items[j].t[1])});
 }return result;
}
export function issuesByShift(shifts:Shift[],rules:Rules,zone?:string){
 const map=Object.fromEntries(shifts.map(s=>[s.id,[] as Issue[]]));
 for(const p of conflictPairs(shifts,rules,zone)){map[p.a.id].push({...p.issue,other:p.b});map[p.b.id].push({...p.issue,other:p.a});}return map;
}

/** Every issue between one shift and a list of others, overlaps first. */
export const issuesFor = (shift: Shift, others: Shift[], rules: Rules, timeZone?: string): Issue[] =>
  others
    .filter((o) => o.id !== shift.id && Math.abs(Date.parse(o.date)-Date.parse(shift.date))<=3*86400000)
    .flatMap((o) => {
      const r = compare(shift, o, rules, timeZone);
      return r ? [{ ...r, other: o }] : [];
    })
    .sort((x, y) => Number(y.kind === "overlap") - Number(x.kind === "overlap"));

/**
 * THE THIRD CHECK: the cancellation window.
 *
 * The alert names each platform's cancellation window and how much time is left, so the person can choose which
 * commitment is safer to drop. Policies vary and change, so this is guidance, never a guarantee.
 */
export const cancelNote = (s: Shift, rules: Rules, now: number, timeZone?: string) => {
  const ms = (timeZone ? spanIn(s,timeZone) : span(s))[0] - rules.cancelHrs * HOUR - now;
  return ms > 0
    ? `Your assumed ${rules.cancelHrs}-hour cutoff for ${s.platform} is in ${left(ms)}.`
    : `Your assumed ${rules.cancelHrs}-hour cutoff for ${s.platform} has passed.`;
};

/** True when the shift's cancellation window is still open at `now`. */
export const cancelWindowOpen = (s: Shift, rules: Rules, now: number) => span(s)[0] - rules.cancelHrs * HOUR > now;

/** The five shifts the dashboard's "Load example week" button creates. */
export function example(now: number = Date.now()): Shift[] {
  const mk = (day: number, platform: string, facility: string, label: string, s: number, e: number, i: number): Shift => ({
    id: `ex${i}`,
    platform,
    facility,
    label,
    date: inDays(day, now),
    start: s * 60,
    end: e * 60,
  });
  return [
    mk(1, "ShiftKey", "Riverside Manor", "Night", 19, 7, 0),
    mk(2, "CareRev", "St. Anne's", "Early", 6, 14, 1),
    mk(4, "Clipboard Health", "Greenfield Rehab", "Evening", 15, 23, 2),
    mk(6, "ShiftMed", "Harbor View", "Early", 6, 14, 3),
    { ...mk(6, "IntelyCare", "Maple Court", "Short", 0, 0, 4), start: 14 * 60 + 30, end: 18 * 60 + 30 },
  ];
}

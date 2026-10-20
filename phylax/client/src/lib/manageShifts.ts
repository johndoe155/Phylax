/**
 * Pure, framework-free helpers for the Manage shifts page (pages/ManageShifts.tsx). Nothing here touches the DOM,
 * storage or the network, so all of it is covered by lib/manageShifts.test.ts.
 *
 *   - limits and the range rules (what a bound is, when a CSV is capped, when a delete is allowed)
 *   - 24-hour display with the "(next day)" marker
 *   - RFC 4180 CSV
 *   - import: file checks, the two accepted JSON shapes, per-row validation, duplicate keys, request IDs
 *   - the edit form: validation, patch, and "what changed elsewhere"
 */
import { kindOf, shiftType, type Shift } from "./shifts";

// ---- Limits (one place, so the page, the adapter and the tests agree) -----------------------------------------------

export const IMPORT_MAX_BYTES = 60 * 1024; // 60 KB
export const IMPORT_MIN_ROWS = 1;
export const IMPORT_MAX_ROWS = 200;
/** A CSV export without both date bounds stops here, and says so. */
export const CSV_UNBOUNDED_LIMIT = 5000;
export const EXPORT_FORMAT = "phylax.shifts";
export const EXPORT_VERSION = 1;
export const FIELD_MAX = { platform: 32, facility: 120, label: 40, notes: 500, address: 200 } as const;

// ---- Types ------------------------------------------------------------------------------------------------------------

/** A shift as the adapter stores it: the dashboard's Shift plus a version that moves on every write (absent means 1). */
export type StoredShift = Shift & { version?: number };
/** YYYY-MM-DD bounds, both inclusive. An empty string leaves that side open. */
export type Range = { from: string; to: string };

export const versionOf = (s: Pick<StoredShift, "version">) => (typeof s.version === "number" && s.version >= 1 ? s.version : 1);

const pad = (n: number) => String(n).padStart(2, "0");
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

// ---- Dates, times, zone -----------------------------------------------------------------------------------------------

/** A real calendar day written YYYY-MM-DD (2026-02-30 is not one). */
export function isYmd(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number);
  const at = new Date(Date.UTC(y, m - 1, d));
  return y >= 1970 && y <= 2100 && at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d;
}

/** "07:00" or "7:00" to minutes after midnight; null for anything else (24:00 included). */
export function parseClock(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const hit = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!hit) return null;
  const h = Number(hit[1]), m = Number(hit[2]);
  return h <= 23 && m <= 59 ? h * 60 + m : null;
}

/** Minutes after midnight as 24-hour "HH:MM". */
export const clock24 = (mins: number) => `${pad(Math.floor(mins / 60) % 24)}:${pad(mins % 60)}`;
/** An end at or before the start runs past midnight (the rule lib/shifts.ts already uses). */
export const endsNextDay = (s: Pick<Shift, "start" | "end">) => s.end <= s.start;
export const timesParts = (s: Pick<Shift, "start" | "end">) => ({ start: clock24(s.start), end: clock24(s.end), nextDay: endsNextDay(s) });
/** "19:00–07:00 (next day)" */
export const timesText = (s: Pick<Shift, "start" | "end">) => `${clock24(s.start)}–${clock24(s.end)}${endsNextDay(s) ? " (next day)" : ""}`;
/** "Thu, Oct 22, 2026" */
export const dayText = (date: string) => new Date(`${date}T00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
export const shortDay = (date: string) => new Date(`${date}T00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

/** The zone's short name and the time in it right now, or null when the zone is not one this browser knows. */
export function zoneInfo(zone: string, at = Date.now()): { zone: string; abbr: string; time: string } | null {
  try {
    const abbr = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "short" }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? "";
    const time = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
    return { zone, abbr, time };
  } catch {
    return null;
  }
}

/** Shifts in the order a person reads them: day, then start, then place. */
export const byDay = (a: StoredShift, b: StoredShift) =>
  a.date.localeCompare(b.date) || a.start - b.start || a.facility.localeCompare(b.facility) || a.id.localeCompare(b.id);

// ---- Range ------------------------------------------------------------------------------------------------------------

export const hasBound = (r: Range) => Boolean(r.from || r.to);
export const hasBothBounds = (r: Range) => Boolean(r.from && r.to);
export const inRange = (date: string, r: Range) => (!r.from || date >= r.from) && (!r.to || date <= r.to);
/** Cap for a CSV export: none when both bounds are set, 5,000 rows otherwise. */
export const exportLimit = (r: Range): number | null => (hasBothBounds(r) ? null : CSV_UNBOUNDED_LIMIT);

export function rangeError(r: Range): string | null {
  if (r.from && !isYmd(r.from)) return "From isn't a valid date.";
  if (r.to && !isYmd(r.to)) return "To isn't a valid date.";
  if (r.from && r.to && r.from > r.to) return "From must be on or before To.";
  return null;
}

export function rangeLabel(r: Range): string {
  if (r.from && r.to) return r.from === r.to ? shortDay(r.from) : `${shortDay(r.from)} to ${shortDay(r.to)}`;
  if (r.from) return `From ${shortDay(r.from)}`;
  if (r.to) return `Up to ${shortDay(r.to)}`;
  return "All dates";
}

export const sameRange = (a: Range, b: Range) => a.from === b.from && a.to === b.to;

// ---- CSV (RFC 4180) ---------------------------------------------------------------------------------------------------

export const CSV_HEADER = ["date", "start", "end", "ends_next_day", "platform", "facility", "label", "note", "address"] as const;

/** A field is quoted when it holds a comma, a double quote or a line break; quotes inside are doubled (RFC 4180, section 2). */
export const csvField = (value: string) => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

/**
 * Spreadsheets run a cell that starts with = + - @ (or a tab or return) as a formula. Text the person typed or imported is
 * defused with a leading apostrophe, which spreadsheets show as plain text. Dates and times are ours, so they pass untouched.
 */
const defuse = (value: string) => (/^[=+\-@\t\r]/.test(value) ? `'${value}` : value);

/**
 * Records are separated by CRLF, the header is the first record, and the last record ends with CRLF. No byte-order mark:
 * the format does not define one. Serve it as text/csv; charset=utf-8; header=present.
 */
export function toCsv(shifts: StoredShift[]): string {
  const lines = [CSV_HEADER.join(",")];
  for (const s of shifts) {
    lines.push([
      s.date, clock24(s.start), clock24(s.end), endsNextDay(s) ? "true" : "false",
      defuse(s.platform), defuse(s.facility), defuse(shiftType(s)), defuse(s.notes ?? ""), defuse(s.address ?? ""),
    ].map(csvField).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

export function csvFileName(r: Range): string {
  return hasBound(r) ? `phylax-shifts-${r.from || "start"}_to_${r.to || "end"}.csv` : "phylax-shifts-all.csv";
}

// ---- Import -----------------------------------------------------------------------------------------------------------

export type ImportRow = { platform: string; facility: string; label: string; date: string; start: number; end: number; notes?: string; address?: string };
export type ParsedImport = { format: "array" | "export"; rows: ImportRow[] };
export type ParseResult = ({ ok: true } & ParsedImport) | { ok: false; errors: string[] };

export const formatBytes = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

/** The checks that need only the file's name, type and size, so a wrong or oversized file is turned away before it is read. */
export function fileProblem(f: { name: string; size: number; type: string }): string | null {
  if (!/\.json$/i.test(f.name) && !/json/i.test(f.type)) return "That isn't a JSON file. Choose a file that ends in .json.";
  if (f.size === 0) return "That file is empty.";
  if (f.size > IMPORT_MAX_BYTES) return `That file is ${formatBytes(f.size)}. The limit is ${formatBytes(IMPORT_MAX_BYTES).replace(".0", "")}.`;
  return null;
}

/** Two rows are the same shift when platform, facility, day and both times match, ignoring case and spacing. */
export const dupKey = (s: { platform: string; facility: string; date: string; start: number; end: number }) =>
  [norm(s.platform), norm(s.facility), s.date, s.start, s.end].join("|");

function text(raw: Record<string, unknown>, key: string, label: string, max: number, row: number, errors: string[], required: boolean): string | undefined {
  const v = raw[key];
  if (v === undefined || v === null || v === "") {
    if (required) errors.push(`Row ${row}: ${label} is required.`);
    return undefined;
  }
  if (typeof v !== "string") { errors.push(`Row ${row}: ${label} must be text.`); return undefined; }
  const t = v.trim();
  if (!t) { if (required) errors.push(`Row ${row}: ${label} is required.`); return undefined; }
  if (t.length > max) { errors.push(`Row ${row}: ${label} is ${t.length} characters. The limit is ${max}.`); return undefined; }
  return t;
}

function parseRow(raw: unknown, index: number, errors: string[]): ImportRow | null {
  const row = index + 1;
  if (!isObject(raw)) { errors.push(`Row ${row}: expected an object with platform, facility, date, start and end.`); return null; }
  const before = errors.length;
  const platform = text(raw, "platform", "Platform", FIELD_MAX.platform, row, errors, true);
  const facility = text(raw, "facility", "Facility", FIELD_MAX.facility, row, errors, true);
  const label = text(raw, "label", "Label", FIELD_MAX.label, row, errors, false);
  const address = text(raw, "address", "Address", FIELD_MAX.address, row, errors, false);
  // "note" is the name the page uses; "notes" is what the dashboard stores. Either is read.
  const notes = text(raw, raw.note !== undefined ? "note" : "notes", "Note", FIELD_MAX.notes, row, errors, false);

  if (!isYmd(raw.date)) errors.push(`Row ${row}: Date must be a real day written YYYY-MM-DD.`);
  const start = parseClock(raw.start), end = parseClock(raw.end);
  if (start === null) errors.push(`Row ${row}: Start must be a 24-hour time such as 07:00.`);
  if (end === null) errors.push(`Row ${row}: End must be a 24-hour time such as 19:00.`);
  if (start !== null && end !== null && start === end) errors.push(`Row ${row}: Start and end match. Change one to set a length.`);

  if (errors.length > before || !platform || !facility || !isYmd(raw.date) || start === null || end === null) return null;
  return { platform, facility, label: label ?? kindOf(start, end), date: raw.date, start, end, ...(notes ? { notes } : {}), ...(address ? { address } : {}) };
}

/**
 * Reads the text of an import file. Two shapes are accepted:
 *   - a plain array:           [ { "platform": "CareRev", "facility": "...", "date": "2026-10-22", "start": "07:00", "end": "19:00" } ]
 *   - a Phylax export:         { "format": "phylax.shifts", "version": 1, "shifts": [ ...the same rows... ] }
 * The whole file is checked before anything is staged: one bad row rejects it, and every problem is reported with its row
 * number, so the person fixes the file once rather than once per error.
 */
export function parseImport(source: string): ParseResult {
  const fail = (...errors: string[]): ParseResult => ({ ok: false, errors });
  let data: unknown;
  try { data = JSON.parse(source.replace(/^\uFEFF/, "")); } catch { return fail("This file isn't valid JSON. Look for a stray comma or an unclosed bracket."); }

  let list: unknown[];
  let format: ParsedImport["format"];
  if (Array.isArray(data)) {
    list = data; format = "array";
  } else if (isObject(data)) {
    if (data.format !== EXPORT_FORMAT) return fail(`This JSON isn't a Phylax export. Expected "format": "${EXPORT_FORMAT}", or a plain array of shifts.`);
    if (data.version !== EXPORT_VERSION) return fail(`This export is version ${String(data.version)}. This page reads version ${EXPORT_VERSION}.`);
    if (!Array.isArray(data.shifts)) return fail('The export has no "shifts" array.');
    list = data.shifts; format = "export";
  } else {
    return fail("Expected a JSON array of shifts or a Phylax export.");
  }

  if (list.length < IMPORT_MIN_ROWS) return fail("The file has no shifts to import.");
  if (list.length > IMPORT_MAX_ROWS) return fail(`The file has ${plural(list.length, "shift")}. The limit is ${IMPORT_MAX_ROWS} per import.`);

  const errors: string[] = [];
  const rows: ImportRow[] = [];
  list.forEach((raw, i) => { const r = parseRow(raw, i, errors); if (r) rows.push(r); });
  return errors.length ? { ok: false, errors } : { ok: true, format, rows };
}

/** A fresh UUID for one import request. The same ID is sent again on a retry, so the server can recognise it. */
export function makeRequestId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(b); else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => pad2hex(x)).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const pad2hex = (n: number) => n.toString(16).padStart(2, "0");

// ---- Edit form --------------------------------------------------------------------------------------------------------

/** What the edit panel holds: times as the "HH:MM" strings the pickers use. */
export type EditForm = { platform: string; facility: string; label: string; date: string; start: string; end: string; notes: string };
export type EditErrors = Partial<Record<keyof EditForm | "times", string>>;

export const formFrom = (s: StoredShift): EditForm => ({
  platform: s.platform, facility: s.facility, label: s.label === "Custom" ? "" : s.label, date: s.date,
  start: clock24(s.start), end: clock24(s.end), notes: s.notes ?? "",
});

export function validateEdit(f: EditForm): EditErrors {
  const e: EditErrors = {};
  if (!f.platform.trim()) e.platform = "Choose a platform.";
  else if (f.platform.trim().length > FIELD_MAX.platform) e.platform = `Platform can be up to ${FIELD_MAX.platform} characters.`;
  if (!f.facility.trim()) e.facility = "Enter the facility.";
  else if (f.facility.trim().length > FIELD_MAX.facility) e.facility = `Facility can be up to ${FIELD_MAX.facility} characters.`;
  if (f.label.trim().length > FIELD_MAX.label) e.label = `Label can be up to ${FIELD_MAX.label} characters.`;
  if (!isYmd(f.date)) e.date = "Choose a date.";
  const a = parseClock(f.start), b = parseClock(f.end);
  if (a === null || b === null) e.times = "Set both a start and an end time.";
  else if (a === b) e.times = "Start and end match. Change one to set a length.";
  if (f.notes.length > FIELD_MAX.notes) e.notes = `Note can be up to ${FIELD_MAX.notes} characters.`;
  return e;
}

/** The fields an update writes. Assumes validateEdit passed. An empty label falls back to the kind the times make. */
export type ShiftPatch = Pick<StoredShift, "platform" | "facility" | "label" | "date" | "start" | "end"> & { notes?: string };
export function toPatch(f: EditForm): ShiftPatch {
  const start = parseClock(f.start) ?? 0, end = parseClock(f.end) ?? 0;
  const notes = f.notes.trim();
  return { platform: f.platform.trim(), facility: f.facility.trim(), label: f.label.trim() || kindOf(start, end), date: f.date, start, end, ...(notes ? { notes } : {}) };
}

export const sameForm = (a: EditForm, b: EditForm) =>
  a.platform.trim() === b.platform.trim() && a.facility.trim() === b.facility.trim() && a.label.trim() === b.label.trim() &&
  a.date === b.date && a.start === b.start && a.end === b.end && a.notes.trim() === b.notes.trim();

/** Names of the fields that differ between two versions of a shift, for "changed elsewhere: Facility, Note". */
export function changedFields(a: StoredShift, b: StoredShift): string[] {
  const out: string[] = [];
  if (a.platform !== b.platform) out.push("Platform");
  if (a.facility !== b.facility) out.push("Facility");
  if (shiftType(a) !== shiftType(b)) out.push("Label");
  if (a.date !== b.date) out.push("Date");
  if (a.start !== b.start) out.push("Start time");
  if (a.end !== b.end) out.push("End time");
  if ((a.notes ?? "") !== (b.notes ?? "")) out.push("Note");
  return out;
}

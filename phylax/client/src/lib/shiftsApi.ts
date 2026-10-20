/**
 * Shifts adapter for the Manage shifts page (pages/ManageShifts.tsx) and, through lib/shiftStore.ts, for the dashboard.
 *
 * This is the REAL adapter over the backend's shift routes. The page was written against a suggested REST shape; the
 * server's shape is close but not the same, so everything that differs is translated here and the page is untouched:
 *
 *   reads          GET /shifts?from=YYYY-MM-DD&to=YYYY-MM-DD
 *                  -> { timezone, shifts[], patterns[], rules{travelMin,cancelHrs}, platforms[] }  (an ENVELOPE, not a bare
 *                  array). `note` on the wire is `notes` on this side. The range defaults to [-30d, +365d] when a bound is
 *                  omitted, and an answer over 5,000 rows is a hard 400 `range_too_large` — never a silent truncation.
 *   one shift      GET /shifts/:id  (the id must be the server's UUID; `validateId` refuses anything else with invalid_id)
 *   update         PUT /shifts/:id  { ...fields, expectedVersion }   (the page's suggested verb was PATCH; partial bodies are
 *                  accepted, so only what changed is sent). A stale version is 409 `version_conflict` whose body carries
 *                  `currentVersion` but NOT the shift, so ConflictError.current is filled by re-reading GET /shifts/:id.
 *   delete one     DELETE /shifts/:id  -> 200 {ok, id} (the page expected 204; both are treated as success)
 *   delete range   DELETE /shifts/bulk {from, to}  (a DELETE with a JSON body; the suggested `DELETE /shifts?from&to`
 *                  does not exist). The server refuses both-or-neither selector, and caps an id list at 500.
 *   import         POST /shifts/import { requestId: UUID, shifts: [...], detectDuplicates: true }
 *                  -> 201 { shifts[], skipped[{index (0-based), reason:"duplicate"}] }
 *                  The zod schema STRIPS unknown keys, so `notes` must be sent as `note` or it is silently dropped. There is
 *                  no `replayed` flag: a repeat of the same requestId is idempotent per (requestId, index) server-side and
 *                  answers with the rows that already exist.
 *   export         There is no /shifts/export JSON endpoint and no count endpoint. Both are answered from the list read here
 *                  and the CSV is built in the browser (lib/manageShifts.ts `toCsv`).
 *   patterns       POST /shifts/patterns (max 200 tiles: 400 `pattern_capacity`), DELETE /shifts/patterns/:id
 *
 * RULES (travelMin/cancelHrs) live on the ACCOUNT (`PUT /account/settings`), not on a shift, so they arrive inside the list
 * envelope and are written by lib/shiftStore.ts.
 *
 * IDS. A shift created in the browser cannot invent its id: the server issues a UUID and every /shifts/:id route validates
 * it. Dashboard-created shifts therefore go out with the client's `uid()` as the POST body's `id` — the backend's
 * account-scoped idempotency key — and the returned row's UUID replaces it locally (lib/shiftStore.ts does the swap).
 *
 * Contract kept from the original placeholder, because the page depends on it:
 *   - resolve                -> the value described on the function
 *   - reject ConflictError   -> the shift moved on since it was read; `current` is what the server holds now
 *   - reject NotFoundError   -> the shift no longer exists
 *   - reject ApiError        -> something the person can read and act on (`message`)
 *   - reject AbortError      -> the caller cancelled (swallowed silently)
 *   - reject anything else   -> treated as "couldn't reach Phylax"
 */
import { ApiError as HttpError, apiFetch, withQuery } from "./apiClient";
import { PLATFORMS } from "./shifts";
import {
  CSV_UNBOUNDED_LIMIT, IMPORT_MAX_ROWS, IMPORT_MIN_ROWS, byDay, hasBound, inRange, rangeError, versionOf,
  type ImportRow, type Range, type ShiftPatch, type StoredShift,
} from "./manageShifts";

export class ApiError extends Error {
  constructor(message: string) { super(message); this.name = "ApiError"; }
}
export class NotFoundError extends ApiError {
  constructor() { super("This shift no longer exists."); this.name = "NotFoundError"; }
}
export class ConflictError extends ApiError {
  current: StoredShift;
  constructor(current: StoredShift) { super("This shift was changed somewhere else."); this.name = "ConflictError"; this.current = current; }
}

export type ImportResult = {
  requestId: string;
  imported: number;
  skipped: number;
  /** One entry per skipped source row, by its 1-based position in the file. */
  skippedRows: { row: number; reason: "exists" | "repeated" }[];
  /** Always false here: the backend has no "this is a replay" flag. See the header. */
  replayed: boolean;
};

// ---- The wire shapes -------------------------------------------------------------------------------------------------

type ShiftRow = {
  id: string;
  platform: string;
  facility: string;
  label: string;
  start: number;
  end: number;
  date: string;
  note?: string | null;
  /** Present once migration 018 has been applied (see phylax-backend/server/migrations/018_*). */
  address?: string | null;
  contact?: string | null;
  version: number;
};

type PatternRow = { id: string; facility: string; label: string; start: number; end: number; address?: string | null };

export type ShiftsEnvelope = {
  timezone: string;
  shifts: StoredShift[];
  patterns: { id: string; facility: string; label: string; start: number; end: number; address?: string }[];
  rules: { travelMin: number; cancelHrs: number };
  platforms: string[];
};

/**
 * An optional text column, as a spreadable fragment: `{ address: "12 Marina Rd" }` when the server holds a value, `{}`
 * when it does not. `null` and `undefined` both mean "no address", and the page's `Pattern` draws the difference nowhere,
 * so they collapse to absent here rather than leaking a null into a type that does not allow one.
 */
function optional<K extends string>(key: K, value: string | null | undefined): { [P in K]?: string } {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? ({ [key]: trimmed } as { [P in K]?: string }) : {};
}

/** `note` -> `notes`, and `address`/`contact` pass through when the backend stores them. */
function toStored(row: ShiftRow): StoredShift {
  return {
    id: row.id,
    platform: row.platform,
    facility: row.facility,
    label: row.label ?? "",
    date: row.date,
    start: row.start,
    end: row.end,
    ...(row.note ? { notes: row.note } : {}),
    ...(row.address ? { address: row.address } : {}),
    ...(row.contact ? { contact: row.contact } : {}),
    version: typeof row.version === "number" ? row.version : 1,
  };
}

/** `notes` -> `note`. An empty note is sent as null so the server clears the column instead of keeping the old text. */
function toWire(shift: Partial<StoredShift>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (shift.platform !== undefined) body.platform = shift.platform;
  if (shift.facility !== undefined) body.facility = shift.facility;
  if (shift.label !== undefined) body.label = shift.label;
  if (shift.date !== undefined) body.date = shift.date;
  if (shift.start !== undefined) body.start = shift.start;
  if (shift.end !== undefined) body.end = shift.end;
  if (shift.notes !== undefined) body.note = shift.notes.trim() ? shift.notes : null;
  if (shift.address !== undefined) body.address = shift.address || null;
  if (shift.contact !== undefined) body.contact = shift.contact || null;
  return body;
}

/** Map a failed call onto the three errors the page branches on, keeping the server's own sentence for everything else. */
function translate(error: unknown): unknown {
  if (!(error instanceof HttpError)) return error;
  if (error.status === 404) return new NotFoundError();
  return new ApiError(error.message);
}

const rangeBody = (range: Range) => ({
  ...(range.from ? { from: range.from } : {}),
  ...(range.to ? { to: range.to } : {}),
});

const guardRange = (range: Range) => {
  const problem = rangeError(range);
  if (problem) throw new ApiError(problem);
};

// ---- Account facts that arrive with the list -------------------------------------------------------------

/** The account's timezone as the server reported it (last read), else the device's. Synchronous for the page's render. */
let zoneCache: string | null = null;
let rulesCache = { travelMin: 60, cancelHrs: 24 };
let platformsCache: string[] = [...PLATFORMS];
const zoneListeners = new Set<() => void>();

function publishZone(next: string): void {
  if (next === zoneCache) return;
  zoneCache = next;
  for (const listener of zoneListeners) {
    try { listener(); } catch { /* one bad listener must not stop the rest */ }
  }
}

/** The account's timezone as an IANA name: what the last read said, else what the device reports. */
export function getAccountTimezone(): string {
  if (zoneCache) return zoneCache;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Calls `onChange` when the account's timezone changes (it changed on the Account page, or a later read disagreed). */
export function subscribeToTimezone(onChange: () => void): () => void {
  zoneListeners.add(onChange);
  return () => { zoneListeners.delete(onChange); };
}

/** The person's own thresholds, from the same envelope (the server keeps them on /account/settings). */
export function getAccountRules(): { travelMin: number; cancelHrs: number } {
  return { ...rulesCache };
}

/** The apps the deployment knows about. Custom names live only in this browser (see listCustomPlatforms). */
export function listServerPlatforms(): string[] {
  return [...platformsCache];
}

const PLATFORMS_KEY = "phylax.platforms";

/** Apps added with "Add platform", read-only. The backend stores the name on each shift, but keeps no list of its own. */
export function listCustomPlatforms(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PLATFORMS_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((p): p is string => typeof p === "string" && p.trim() !== "") : [];
  } catch {
    return [];
  }
}

/** Saves an app name to the same list the dashboard reads, unless it is already there. */
export function addCustomPlatform(name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  const have = [...PLATFORMS, ...listCustomPlatforms()].some((p) => p.toLowerCase() === trimmed.toLowerCase());
  if (have) return;
  try { localStorage.setItem(PLATFORMS_KEY, JSON.stringify([...listCustomPlatforms(), trimmed])); } catch { /* the name still works for this edit */ }
}

// ---- Reads -----------------------------------------------------------------------------------------------

/**
 * The whole envelope: shifts in the range plus patterns, rules, timezone and platforms.
 *
 * This is the one read the page, the dashboard store and the import/export paths all use — the server builds the envelope
 * in a single request, so asking for any one part of it costs the same as asking for all of it.
 */
export async function loadShifts(range: Range, signal?: AbortSignal): Promise<ShiftsEnvelope> {
  const path = withQuery("/api/shifts", { from: range.from || undefined, to: range.to || undefined });
  let payload: {
    timezone?: string;
    shifts?: ShiftRow[];
    patterns?: PatternRow[];
    rules?: { travelMin?: number; cancelHrs?: number };
    platforms?: string[];
  };
  try {
    payload = await apiFetch(path, { signal });
  } catch (error) {
    throw translate(error);
  }

  if (payload.timezone) publishZone(payload.timezone);
  if (payload.rules) rulesCache = { travelMin: payload.rules.travelMin ?? 60, cancelHrs: payload.rules.cancelHrs ?? 24 };
  if (Array.isArray(payload.platforms) && payload.platforms.length) platformsCache = payload.platforms;

  return {
    timezone: payload.timezone ?? getAccountTimezone(),
    shifts: (payload.shifts ?? []).map(toStored).sort(byDay),
    patterns: (payload.patterns ?? []).map((p) => ({
      id: p.id,
      facility: p.facility,
      label: p.label,
      start: p.start,
      end: p.end,
      ...optional("address", p.address),
    })),
    rules: { ...rulesCache },
    platforms: [...platformsCache],
  };
}

/** Every shift in the range, oldest first. Never paginated or capped by this adapter: the server's 5,000-row limit is an error, not a truncation. */
export async function listShifts(range: Range, signal?: AbortSignal): Promise<StoredShift[]> {
  const problem = rangeError(range);
  if (problem) throw new ApiError(problem);
  const envelope = await loadShifts(range, signal);
  // A range with a bound is applied again here so a server default window can never widen what was asked for.
  return hasBound(range) ? envelope.shifts.filter((s) => inRange(s.date, range)) : envelope.shifts;
}

export async function getShift(id: string, signal?: AbortSignal): Promise<StoredShift> {
  try {
    return toStored(await apiFetch<ShiftRow>(`/api/shifts/${encodeURIComponent(id)}`, { signal }));
  } catch (error) {
    throw translate(error);
  }
}

/**
 * How many shifts are in the range. There is no count endpoint, so this is the length of the list read.
 *
 * The page uses it only to say how many a delete would remove, so paying for the rows is acceptable; and because the read
 * is the same one the list uses, the number and the list can never disagree.
 */
export async function countShifts(range: Range, signal?: AbortSignal): Promise<number> {
  return (await listShifts(range, signal)).length;
}

/**
 * The rows for a CSV. `limit` is a hard ceiling: the answer holds at most that many rows (the earliest first) and `total`
 * says how many matched, so the caller can tell the person when it stopped short. The CSV itself is built in the browser.
 */
export async function exportShifts(range: Range, limit: number | null, signal?: AbortSignal): Promise<{ shifts: StoredShift[]; total: number }> {
  const all = await listShifts(range, signal);
  const cap = limit === null ? all.length : Math.min(limit, CSV_UNBOUNDED_LIMIT);
  return { shifts: all.slice(0, cap), total: all.length };
}

// ---- Writes ----------------------------------------------------------------------------------------------

/**
 * Create a shift.
 *
 * `clientId` is the browser's own id for this row. The server stores it as the account-scoped idempotency key and, if the
 * same one arrives twice (a retry after a dropped connection), answers with the row that already exists instead of adding a
 * second. The response carries the server's UUID, which is what every later write must use.
 */
export async function createShift(input: Omit<ShiftPatch, "notes"> & { notes?: string; clientId?: string; pattern?: { id: string; facility: string; label: string; start: number; end: number } }, signal?: AbortSignal): Promise<StoredShift> {
  const body: Record<string, unknown> = { ...toWire(input), ...(input.clientId ? { id: input.clientId } : {}) };
  if (input.pattern) body.pattern = input.pattern;
  try {
    return toStored(await apiFetch<ShiftRow>("/api/shifts", { method: "POST", body, signal }));
  } catch (error) {
    throw translate(error);
  }
}

/**
 * Optimistic concurrency. `expectedVersion` is the version the edit was based on.
 *
 * A 409 `version_conflict` carries only `currentVersion`, not the row, so the current shift is re-read here: the page's
 * "changed elsewhere" panel needs the whole record to show what actually moved.
 */
export async function updateShift(id: string, patch: ShiftPatch, expectedVersion: number, signal?: AbortSignal): Promise<StoredShift> {
  try {
    const row = await apiFetch<ShiftRow>(`/api/shifts/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: { ...toWire(patch), expectedVersion },
      signal,
    });
    return toStored(row);
  } catch (error) {
    if (error instanceof HttpError && error.code === "version_conflict") {
      // The conflict body names the version the server holds; the row itself has to be fetched.
      const current = await getShift(id, signal).catch(() => null);
      if (!current) throw new NotFoundError();
      throw new ConflictError(current);
    }
    throw translate(error);
  }
}

/** Remove one shift. The server answers 200 `{ok, id}`; the page only cares that it did not throw. */
export async function deleteShift(id: string, signal?: AbortSignal): Promise<void> {
  try {
    await apiFetch(`/api/shifts/${encodeURIComponent(id)}`, { method: "DELETE", signal });
  } catch (error) {
    throw translate(error);
  }
}

/**
 * Remove every shift in the range and answer how many.
 *
 * The server's bulk route takes EITHER a list of ids (max 500) OR a from/to range, never both and never neither, so a range
 * with no bound is refused here before it is sent — that also protects the person from a request that would clear everything.
 */
export async function deleteRange(range: Range, signal?: AbortSignal): Promise<number> {
  if (!hasBound(range)) throw new ApiError("Set a From or To date before deleting a range.");
  guardRange(range);
  try {
    const payload = await apiFetch<{ deleted?: number }>("/api/shifts/bulk", { method: "DELETE", body: rangeBody(range), signal });
    return payload.deleted ?? 0;
  } catch (error) {
    throw translate(error);
  }
}

/**
 * Append the rows. Never removes or changes a stored shift, and safe to send twice with the same `requestId`: the server
 * keys each row's idempotency on `(requestId, index)`.
 *
 * `detectDuplicates: true` asks the server to skip a row whose facility, date and times it already holds (whatever app or
 * label it came in under) and to report those rows back by their 0-BASED index. The page reports file rows 1-based, so the
 * index is shifted here. The backend distinguishes only one reason ("duplicate"), not the page's exists-vs-repeated, so
 * every skipped row is reported as "exists".
 */
export async function importShifts(input: { requestId: string; rows: ImportRow[] }, signal?: AbortSignal): Promise<ImportResult> {
  const { requestId, rows } = input;
  if (!requestId) throw new ApiError("The import has no request ID.");
  if (rows.length < IMPORT_MIN_ROWS || rows.length > IMPORT_MAX_ROWS) throw new ApiError(`An import holds ${IMPORT_MIN_ROWS} to ${IMPORT_MAX_ROWS} shifts.`);

  const shifts = rows.map((row) => ({
    platform: row.platform,
    facility: row.facility,
    label: row.label,
    date: row.date,
    start: row.start,
    end: row.end,
    ...(row.notes ? { note: row.notes } : {}),
    ...(row.address ? { address: row.address } : {}),
  }));

  let payload: { shifts?: ShiftRow[]; skipped?: { index: number; reason: string }[] };
  try {
    payload = await apiFetch("/api/shifts/import", { method: "POST", body: { requestId, shifts, detectDuplicates: true }, signal });
  } catch (error) {
    if (error instanceof HttpError && error.code === "invalid_shifts") {
      throw new ApiError("That import was refused. Check the dates and times in the file and try again.");
    }
    throw translate(error);
  }

  const skippedRows = (payload.skipped ?? []).map((s) => ({ row: s.index + 1, reason: "exists" as const }));
  return {
    requestId,
    imported: payload.shifts?.length ?? rows.length - skippedRows.length,
    skipped: skippedRows.length,
    skippedRows,
    replayed: false,
  };
}

// ---- Saved patterns -------------------------------------------------------------------------------------

/**
 * Save a tile (POST /shifts/patterns). The account may hold at most 200; the server answers 400 `pattern_capacity` and that
 * sentence is surfaced as it is, because it is the only explanation the person can act on.
 */
export async function savePattern(input: { id?: string; facility: string; label: string; start: number; end: number; address?: string }, signal?: AbortSignal): Promise<PatternRow> {
  try {
    return await apiFetch<PatternRow>("/api/shifts/patterns", {
      method: "POST",
      body: {
        ...(input.id ? { id: input.id } : {}),
        facility: input.facility,
        label: input.label,
        start: input.start,
        end: input.end,
        ...(input.address ? { address: input.address } : {}),
      },
      signal,
    });
  } catch (error) {
    throw translate(error);
  }
}

/** Remove a tile. Answers 200 `{ok, id}`; a 404 means it was already gone, which the caller may treat as success. */
export async function deletePattern(id: string, signal?: AbortSignal): Promise<void> {
  try {
    await apiFetch(`/api/shifts/patterns/${encodeURIComponent(id)}`, { method: "DELETE", signal });
  } catch (error) {
    throw translate(error);
  }
}

// ---- Rules -----------------------------------------------------------------------------------------------

/**
 * Save the person's own thresholds. They live on the account (PUT /account/settings), not on a shift, so every screen that
 * shows a travel or cutoff warning reads the same numbers.
 */
export async function saveRules(rules: { travelMin: number; cancelHrs: number }, signal?: AbortSignal): Promise<void> {
  try {
    await apiFetch("/api/account/settings", { method: "PUT", body: { travelMin: rules.travelMin, cancelHrs: rules.cancelHrs }, signal });
    rulesCache = { ...rules };
  } catch (error) {
    throw translate(error);
  }
}

/** The version a shift is at, for a caller that only has the stored row (kept for parity with manageShifts.versionOf). */
export const versionOfShift = (shift: Pick<StoredShift, "version">): number => versionOf(shift);

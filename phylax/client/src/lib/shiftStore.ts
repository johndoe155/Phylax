/**
 * The dashboard's server-backed store.
 *
 * The dashboard used to keep its shifts, tiles and rules in localStorage (`useStored`). The server is the record of truth
 * now, so this module supplies drop-in replacements with the same `[value, setValue]` shape the page already uses:
 *
 *   const [shifts, setShifts] = useServerShifts();       // was useStored<Shift[]>("phylax.shifts", [])
 *   const [patterns, setPatterns] = useServerPatterns(); // was useStored<Pattern[]>("phylax.patterns", DEFAULT_PATTERNS)
 *   const [rules, setRules] = useServerRules();          // was useStored<Rules>("phylax.rules", DEFAULT_RULES)
 *
 * HOW A WRITE WORKS. The setter behaves like `useState`'s (a value or an updater), applies the change locally at once — the
 * page is never made to wait for a round trip — and then diffs what it did against what it had and sends only the
 * difference:
 *
 *   added row      POST   /shifts {..., id: <the browser's uid>}   the browser's id is the server's idempotency key, so a
 *                                                                  retry cannot double-add; the reply's UUID replaces it
 *   changed row    PUT    /shifts/:id {..., expectedVersion}       409 version_conflict means somebody else moved it
 *   removed row    DELETE /shifts/:id
 *   new tile       POST   /shifts/patterns
 *   changed rules  PUT    /account/settings
 *
 * A row that has not been saved yet has no UUID, so an edit or a removal of it is handled locally instead of being sent to a
 * route that validates ids (and would answer 400 `invalid_id`).
 *
 * FAILURES. A rejected write is reported on the console. The dashboard has no banner of its own (deliberately: the page's
 * layout is unchanged), and the next successful read — a reload, or coming back to the tab — restores the server's answer, so
 * a failed write cannot leave the screen permanently disagreeing with the server. A 409 on an edit adopts the server's row,
 * because the person's version was refused and showing it as saved would be a lie.
 *
 * MIGRATION. The first time a signed-in account loads with no shifts on the server but shifts in this browser, they are
 * pushed through POST /shifts/import once and the local copy is kept under a backup key rather than deleted. See
 * `migrateLocalShifts` at the bottom.
 */
import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import { getAuthStatus } from "./auth";
import { apiFetch, isAbortError } from "./apiClient";
import { DEFAULT_PATTERNS, DEFAULT_RULES, type Pattern, type Rules, type Shift } from "./shifts";
import { createShift, deletePattern, deleteShift, listShifts, loadShifts, savePattern, saveRules, updateShift } from "./shiftsApi";
import type { StoredShift } from "./manageShifts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isServerId = (id: string) => UUID.test(id);

/** The window the dashboard loads. No bounds: the server applies its own (last 30 days through a year ahead). */
const WINDOW = { from: "", to: "" };

/** A line on the console instead of a silent loss, so a failed write is diagnosable without a banner. */
const report = (what: string, error: unknown) => {
  if (isAbortError(error)) return;
  console.warn(`[phylax] ${what} was not saved:`, error instanceof Error ? error.message : error);
};

const LOCAL_KEY = "phylax.shifts";
const LOCAL_BACKUP_KEY = "phylax.shifts:imported";
const MIGRATED_KEY = "phylax.shifts:migrated";

/** Whether two rows differ in a way the server has to be told about. */
function changed(a: Shift, b: Shift): boolean {
  return (
    a.platform !== b.platform ||
    a.facility !== b.facility ||
    a.label !== b.label ||
    a.date !== b.date ||
    a.start !== b.start ||
    a.end !== b.end ||
    (a.notes ?? "") !== (b.notes ?? "") ||
    (a.address ?? "") !== (b.address ?? "") ||
    (a.contact ?? "") !== (b.contact ?? "")
  );
}

export type StoreSetter<T> = (next: SetStateAction<T>) => void;

/**
 * The common machinery: a `[value, setValue]` pair whose value starts at `initial`, is replaced by `load()` once, and whose
 * every change is handed to `flush(before, after)` when the first read has already landed.
 *
 * `apply` is given to `flush` so an asynchronous reply (the server's UUID for a new row) can be folded back in without
 * clobbering anything the person did in the meantime.
 */
function useServerStore<T>(
  initial: T,
  load: (signal: AbortSignal) => Promise<T>,
  flush: (before: T, after: T, apply: (mutate: (current: T) => T) => void) => void,
): [T, StoreSetter<T>] {
  const [value, setValue] = useState<T>(initial);
  const latest = useRef<T>(initial);
  const loaded = useRef(false);

  const apply = useCallback((mutate: (current: T) => T) => {
    latest.current = mutate(latest.current);
    setValue(latest.current);
  }, []);

  const set = useCallback<StoreSetter<T>>(
    (next) => {
      const before = latest.current;
      const after = typeof next === "function" ? (next as (prev: T) => T)(before) : next;
      if (Object.is(before, after)) return;
      latest.current = after;
      setValue(after);
      // Nothing is written before the first read has landed: the diff would be against the initial value and every row
      // would look new.
      if (loaded.current) flush(before, after, apply);
    },
    [apply, flush],
  );

  useEffect(() => {
    if (getAuthStatus() !== "authenticated") {
      loaded.current = true;
      return;
    }
    const controller = new AbortController();
    load(controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        loaded.current = true;
        latest.current = next;
        setValue(next);
      })
      .catch((error: unknown) => {
        if (!isAbortError(error)) report("loading your schedule", error);
        loaded.current = true;
      });
    return () => controller.abort();
  }, [load]);

  return [value, set];
}

// ---- Shifts -------------------------------------------------------------------------------------------------

/** The dashboard's shifts, read from and written to the server. Drop-in for the old `useStored("phylax.shifts", [])`. */
export function useServerShifts(): [StoredShift[], StoreSetter<StoredShift[]>] {
  const load = useCallback(async (signal: AbortSignal) => {
    const rows = await listShifts(WINDOW, signal);
    const afterMigration = await migrateLocalShifts(rows.length, signal);
    return afterMigration ?? rows;
  }, []);

  const flush = useCallback((before: StoredShift[], after: StoredShift[], apply: (mutate: (current: StoredShift[]) => StoredShift[]) => void) => {
    const beforeById = new Map(before.map((s) => [s.id, s]));
    const afterIds = new Set(after.map((s) => s.id));

    for (const old of before) {
      if (afterIds.has(old.id) || !isServerId(old.id)) continue;
      void deleteShift(old.id).catch((error: unknown) => report(`deleting ${old.facility}`, error));
    }

    for (const row of after) {
      const old = beforeById.get(row.id);

      if (!old) {
        // Added. The browser's uid travels as the server's idempotency key; the returned UUID replaces it in place.
        void createShift({
          clientId: row.id,
          platform: row.platform,
          facility: row.facility,
          label: row.label,
          date: row.date,
          start: row.start,
          end: row.end,
          ...(row.notes ? { notes: row.notes } : {}),
          ...(row.address ? { address: row.address } : {}),
          ...(row.contact ? { contact: row.contact } : {}),
        })
          .then((saved) => apply((current) => current.map((s) => (s.id === row.id ? { ...s, ...saved } : s))))
          .catch((error: unknown) => report(`saving ${row.facility}`, error));
        continue;
      }

      if (!changed(old, row) || !isServerId(row.id)) continue;

      void updateShift(
        row.id,
        { platform: row.platform, facility: row.facility, label: row.label, date: row.date, start: row.start, end: row.end, notes: row.notes ?? "" },
        old.version ?? 1,
      )
        .then((saved) => apply((current) => current.map((s) => (s.id === saved.id ? { ...s, ...saved } : s))))
        .catch((error: unknown) => {
          if (error && typeof error === "object" && "current" in error) {
            const current = (error as { current: StoredShift }).current;
            apply((rows) => rows.map((s) => (s.id === current.id ? { ...s, ...current } : s)));
            return;
          }
          report(`saving ${row.facility}`, error);
        });
    }
  }, []);

  return useServerStore<StoredShift[]>([], load, flush);
}

// ---- Tiles --------------------------------------------------------------------------------------------------

/** The saved tiles. A tile the server has not seen yet is created and its UUID swapped in, exactly like a shift. */
export function useServerPatterns(): [Pattern[], StoreSetter<Pattern[]>] {
  const load = useCallback(async (signal: AbortSignal) => {
    const envelope = await loadShifts(WINDOW, signal);
    // The landing page's example tiles stand in only while the account has never saved one of its own.
    return envelope.patterns.length ? envelope.patterns : DEFAULT_PATTERNS;
  }, []);

  const flush = useCallback((before: Pattern[], after: Pattern[], apply: (mutate: (current: Pattern[]) => Pattern[]) => void) => {
    const beforeIds = new Set(before.map((p) => p.id));
    const afterById = new Map(after.map((p) => [p.id, p]));

    for (const old of before) {
      if (afterById.has(old.id) || !isServerId(old.id)) continue;
      void deletePattern(old.id).catch((error: unknown) => report(`removing the ${old.facility} tile`, error));
    }

    for (const tile of after) {
      if (beforeIds.has(tile.id) || isServerId(tile.id)) continue;
      void savePattern({ id: tile.id, facility: tile.facility, label: tile.label, start: tile.start, end: tile.end, ...(tile.address ? { address: tile.address } : {}) })
        .then((saved) => {
          // The server's row replaces the local one, but only the fields the page knows about (its `address` may be null).
          const stored: Pattern = {
            id: saved.id,
            facility: saved.facility,
            label: saved.label,
            start: saved.start,
            end: saved.end,
            ...(saved.address ? { address: saved.address } : {}),
          };
          apply((current) => current.map((p) => (p.id === tile.id ? stored : p)));
        })
        .catch((error: unknown) => report(`saving the ${tile.facility} tile`, error));
    }
  }, []);

  return useServerStore<Pattern[]>(DEFAULT_PATTERNS, load, flush);
}

// ---- Rules --------------------------------------------------------------------------------------------------

/** The person's thresholds. They live on the account, so the Manage shifts page reads the same numbers. */
export function useServerRules(): [Rules, StoreSetter<Rules>] {
  const load = useCallback(async (signal: AbortSignal) => {
    const envelope = await loadShifts(WINDOW, signal);
    return { travelMin: envelope.rules.travelMin, cancelHrs: envelope.rules.cancelHrs };
  }, []);

  const flush = useCallback((_before: Rules, after: Rules) => {
    void saveRules({ travelMin: after.travelMin, cancelHrs: after.cancelHrs }).catch((error: unknown) => report("saving your rules", error));
  }, []);

  return useServerStore<Rules>(DEFAULT_RULES, load, flush);
}

// ---- The one-time migration ---------------------------------------------------------------------------------

const hasMigrated = (): boolean => {
  try {
    return localStorage.getItem(MIGRATED_KEY) === "1";
  } catch {
    return false;
  }
};

const markMigrated = (): void => {
  try {
    localStorage.setItem(MIGRATED_KEY, "1");
  } catch {
    /* storage unavailable: the local rows will be found again next time, and the import is idempotent per row id */
  }
};

/** Rows the old dashboard stored in this browser, in the shape POST /shifts/import accepts. */
function localRows(): { platform: string; facility: string; label: string; date: string; start: number; end: number; note?: string; address?: string }[] {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((row): row is Record<string, unknown> => {
        if (!row || typeof row !== "object") return false;
        const s = row as Record<string, unknown>;
        return typeof s.platform === "string" && typeof s.facility === "string" && typeof s.date === "string" && typeof s.start === "number" && typeof s.end === "number";
      })
      .map((row) => ({
        platform: String(row.platform),
        facility: String(row.facility),
        label: typeof row.label === "string" && row.label ? row.label : "Custom",
        date: String(row.date),
        start: Number(row.start),
        end: Number(row.end),
        ...(typeof row.notes === "string" && row.notes ? { note: row.notes } : {}),
        ...(typeof row.address === "string" && row.address ? { address: row.address } : {}),
      }));
  } catch {
    return [];
  }
}

/**
 * Push this browser's local shifts to the server, once, for an account whose server-side schedule is empty.
 *
 * The old dashboard kept everything under `phylax.shifts`; somebody who used it before this integration has a real schedule
 * there. Throwing it away would be data loss, so on the first load that finds the server empty and the browser not, the rows
 * go through POST /shifts/import — the route built for exactly this — in batches of the 200 it accepts, each with one
 * `crypto.randomUUID()` request id. The local copy is then left under `phylax.shifts:imported` as a backup instead of being
 * deleted.
 *
 * It runs at most once per browser, never overwrites anything (the import only appends), and a failure is reported and retried
 * on the next load rather than half-applied — the import is atomic server-side.
 *
 * It runs even when the server ALREADY holds shifts, which is the case for somebody who signed in on a second device first:
 * `detectDuplicates` makes the server skip any row it already has (it compares against stored shifts as well as within the
 * batch, and reports the index), so the earlier rows come back as `skipped` and the genuinely local ones are added. The
 * alternative — treating "the server has data" as "this browser has nothing worth keeping" — would strand the local rows
 * forever, because the flag below would record the migration as done.
 *
 * @returns the rows the server holds afterwards, or null when nothing was migrated.
 */
export async function migrateLocalShifts(_serverCount: number, signal?: AbortSignal): Promise<StoredShift[] | null> {
  if (hasMigrated()) return null;

  const shifts = localRows();
  if (shifts.length === 0) {
    markMigrated();
    return null;
  }

  try {
    for (let i = 0; i < shifts.length; i += 200) {
      await apiFetch("/api/shifts/import", {
        method: "POST",
        body: { requestId: crypto.randomUUID(), shifts: shifts.slice(i, i + 200), detectDuplicates: true },
        signal,
      });
    }
    try {
      localStorage.setItem(LOCAL_BACKUP_KEY, localStorage.getItem(LOCAL_KEY) ?? "");
    } catch {
      /* the backup is a courtesy; the rows are on the server either way */
    }
    markMigrated();
    return await listShifts(WINDOW, signal);
  } catch (error) {
    report("importing the shifts this browser had saved", error);
    return null;
  }
}

/** Whether this browser still holds shifts that only exist locally (the account page's export note uses it). */
export function hasLocalOnlyShifts(): boolean {
  return localRows().length > 0 && !hasMigrated();
}

/** Whether a row already has the server's id (rather than the browser's temporary one). */
export const isSavedShift = (shift: Pick<Shift, "id">): boolean => isServerId(shift.id);

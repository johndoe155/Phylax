import { accountWriteGuard } from "../guards.js";
import { validateId } from "../validation.js";
import { Router, type Request, type Response } from "express";
import { asyncHandler, badRequest, notFound, HttpError } from "../http.js";
import { requireAuth } from "../middleware.js";
import { z } from "zod";
import { query, queryOne, execute, withTransaction } from "../db.js";
import { ensureSettings } from "../accounts.js";
import { PLATFORMS, type Shift } from "@shared/shifts";

/** Enforce every rolling 29-calendar-day window containing this new/moved shift, not just +/-14. */
export async function assertWindowCapacity(accountId:string,date:string,exclude:string|null=null,client?:import("pg").PoolClient){
 const sql="SELECT date FROM shifts WHERE account_id=$1 AND ($3::uuid IS NULL OR id<>$3::uuid) AND date BETWEEN $2::date-28 AND $2::date+28 ORDER BY date";
 const rows=client?(await client.query<{date:string}>(sql,[accountId,date,exclude])).rows:await query<{date:string}>(sql,[accountId,date,exclude]);
 const dates=[...rows.map(s=>Date.parse(s.date)),Date.parse(date)].sort((a,b)=>a-b);let left=0;
 for(let right=0;right<dates.length;right++){while(dates[right]-dates[left]>28*86400000)left++;if(right-left+1>500)throw badRequest("window_capacity","At most 500 shifts may be stored in any rolling 29-day window.");}
}

/**
 * The shifts, patterns and rules.
 *
 * The dashboard's data. The client keeps a copy in localStorage so the page still works offline and before the
 * account is connected; the server is the record of truth.
 *
 * The shape of a shift on the wire mirrors the domain: minutes after midnight, and the day the shift STARTS.
 */

/**
 * The most shifts one read will return.
 *
 * A person with years of shifts behind them should not send them all to the browser on every page load. The
 * range is the way to ask for more, deliberately.
 */
const MAX_SHIFTS = 5000;

type ShiftRow = {
  id: string;
  platform: string;
  facility: string;
  label: string;
  start_minute: number;
  end_minute: number;
  date: string;
  note?: string | null;
  /** Migration 018. The site's address, as the person typed it. */
  address?: string | null;
  /** Migration 018. Who to call about this shift. */
  contact?: string | null;
  version: number;
};

type PatternRow = {
  id: string;
  facility: string;
  label: string;
  start_minute: number;
  end_minute: number;
  /** Migration 018. Where the tile is worked. */
  address?: string | null;
};

const toShift = (row: ShiftRow) => ({
  id: row.id,
  platform: row.platform,
  facility: row.facility,
  label: row.label,
  start: row.start_minute,
  end: row.end_minute,
  date: row.date,
  note: row.note ?? null,
  // Both are nullable and always present in the answer, so a client never has to tell "empty" from "not sent".
  address: row.address ?? null,
  contact: row.contact ?? null,
  // Surfaced on every read so a client can send it back as `expectedVersion` on the next write. A write that
  // names a version the row no longer has is refused with 409 instead of silently clobbering a concurrent edit.
  version: row.version,
});

const toPattern = (row: PatternRow) => ({
  id: row.id,
  facility: row.facility,
  label: row.label,
  start: row.start_minute,
  end: row.end_minute,
  address: row.address ?? null,
});

/**
 * The optional text columns, as the route accepts them.
 *
 * `undefined` means "not mentioned" (leave it as it is on an update), `null` or an empty string means "clear it". The
 * ceiling matches the database CHECK added in migration 018, so a too-long value is a 400 that names the field rather
 * than a 23514 surfaced as invalid_input.
 */
const optionalText = (value: unknown, label: string): string | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw badRequest("invalid_input", `${label} has to be text.`);
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > 200) throw badRequest("invalid_input", `${label} can be up to 200 characters.`);
  return trimmed;
};

/** A date in `YYYY-MM-DD` form, and a real one. */
const validDate = (value: unknown): value is string => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && value === d.toISOString().slice(0, 10);
};

/** Minutes after midnight, inside a day. */
const validMinute = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1439;

/**
 * The date bounds the database enforces (`shifts_date_bounds`: 2000-01-01 .. CURRENT_DATE + 10 years), checked
 * here first so an out-of-range date is a clear 400 rather than a CHECK-constraint failure surfaced as a 500.
 *
 * The upper bound moves with "today", so it is computed per call in UTC — the same frame the DB's CURRENT_DATE
 * uses on this server. The route check is deliberately a hair wider than nothing: if it ever disagrees at the
 * edge, the DB constraint is the final authority and still refuses the row.
 */
const SHIFT_DATE_MIN = "2000-01-01";
function shiftDateMax(today = new Date()): string {
  const max = new Date(Date.UTC(today.getUTCFullYear() + 10, today.getUTCMonth(), today.getUTCDate()));
  return max.toISOString().slice(0, 10);
}
/** Throws a 400 when a syntactically-valid date falls outside the storable window. */
function assertShiftDateBounds(date: string): void {
  if (date < SHIFT_DATE_MIN || date > shiftDateMax()) {
    throw badRequest(
      "date_out_of_range",
      `Choose a date between ${SHIFT_DATE_MIN} and ${shiftDateMax()} (ten years out).`,
    );
  }
}

export function shiftRoutes(): Router {
  const router = Router();
  router.param("id", (req, res, next) => validateId(req, res, next));
  router.use(requireAuth());
  router.use(accountWriteGuard());

  // ---- everything the dashboard needs, in one read -------------------------------------------
  //
  // The list takes a date range. Without one, the answer grows for as long as the account is used: somebody
  // who has been logging shifts for two years would send two years of rows on every page load. The range
  // defaults to a sensible window, and a range that is asked for explicitly is honoured.
  router.get(
    "/",
    asyncHandler(async (req: Request, res: Response) => {
      const accountId = req.account!.id;
      const settings = await ensureSettings(accountId);

      if ((req.query.from !== undefined && !validDate(req.query.from)) || (req.query.to !== undefined && !validDate(req.query.to))) throw badRequest("range_invalid", "Use YYYY-MM-DD dates in the range.");
      const localDay = new Intl.DateTimeFormat("en-CA",{timeZone:settings?.timezone??"UTC",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
      const day = (n:number) => new Date(Date.parse(localDay+"T12:00:00Z")+n*86400000).toISOString().slice(0,10);
      const from = validDate(req.query.from) ? (req.query.from as string) : day(-30);
      const to = validDate(req.query.to) ? (req.query.to as string) : day(365);
      if (from && to && from > to) throw badRequest("range_invalid", "The start of the range is after the end of it.");

      const shifts = await query<ShiftRow>(
        `SELECT id, platform, facility, label, start_minute, end_minute, date, note, address, contact, version FROM shifts
          WHERE account_id = $1
            AND ($2::date IS NULL OR date >= $2::date)
            AND ($3::date IS NULL OR date <= $3::date)
          ORDER BY date, start_minute
          LIMIT $4`,
        [accountId, from, to, MAX_SHIFTS + 1],
      );
      if (shifts.length > MAX_SHIFTS) throw badRequest("range_too_large", "Choose a smaller date range (maximum 5,000 shifts). Nothing has been truncated.");
      const patterns = await query<PatternRow>(
        `SELECT id, facility, label, start_minute, end_minute, address FROM patterns WHERE account_id = $1 ORDER BY facility, label`,
        [accountId],
      );
      res.json({
        timezone: settings?.timezone ?? "UTC",
        shifts: shifts.map(toShift),
        patterns: patterns.map(toPattern),
        rules: {
          travelMin: settings?.travel_minutes ?? 60,
          cancelHrs: settings?.cancel_hours ?? 24,
        },
        platforms: PLATFORMS,
      });
    }),
  );

  // ---- log a shift ----------------------------------------------------------------------------
  router.post(
    "/",
    asyncHandler(async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as {
        id?: string;
        platform?: string;
        facility?: string;
        label?: string;
        start?: number;
        end?: number;
        date?: string;
        note?: string;
        address?: string | null;
        contact?: string | null;
      };
      // Migration 018: the two optional text columns, validated before anything is written.
      const address = optionalText((req.body ?? {}).address, "Address") ?? null;
      const contact = optionalText((req.body ?? {}).contact, "Contact") ?? null;
      const facility = (body.facility ?? "").trim();
      if (!facility) throw badRequest("facility_required", "Which facility is this shift at?");
      if (!validDate(body.date)) throw badRequest("date_invalid", "Choose a date for the shift.");
      assertShiftDateBounds(body.date);
      if (!validMinute(body.start) || !validMinute(body.end)) throw badRequest("time_invalid", "Choose the start and end times.");
      if (body.start === body.end) throw badRequest("time_invalid", "A shift has to be longer than nothing.");
      const platform = (body.platform ?? "").trim();
      if (!platform) throw badRequest("platform_required", "Which app is this shift from?");

      const count = await queryOne<{n:number}>("SELECT count(*)::int AS n FROM shifts WHERE account_id=$1",[req.account!.id]);
      const retry = body.id ? await queryOne("SELECT id FROM shifts WHERE account_id=$1 AND client_id=$2",[req.account!.id,body.id]) : null;
      if ((count?.n??0)>=5000 && !retry) throw badRequest("account_capacity", "Archive/export and remove old shifts before exceeding 5,000 records.");
      if(!retry)await assertWindowCapacity(req.account!.id,body.date);
      const rawPattern=req.body.pattern;
      const parsedPattern=rawPattern===undefined?null:z.object({id:z.string().min(1).max(128),facility:z.string().trim().min(1).max(200),label:z.string().max(200),start:z.number().int().min(0).max(1439),end:z.number().int().min(0).max(1439)}).refine(p=>p.start!==p.end).safeParse(rawPattern);
      if(parsedPattern && !parsedPattern.success)throw badRequest("invalid_pattern","Check the saved tile.");
      const result=await withTransaction(async client=>{
      const inserted = await client.query<ShiftRow>(
        `INSERT INTO shifts (account_id, platform, facility, label, start_minute, end_minute, date, note, address, contact, client_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (account_id, client_id) WHERE client_id IS NOT NULL DO UPDATE SET client_id = EXCLUDED.client_id
         RETURNING id, platform, facility, label, start_minute, end_minute, date, note, address, contact, version`,
        [
          req.account!.id,
          platform,
          facility,
          (body.label ?? "").trim(),
          body.start,
          body.end,
          body.date,
          body.note ?? null,
          address,
          contact,
          body.id ?? null,
        ],
      );
        let pattern:PatternRow|null=null;
        if(parsedPattern?.success){const p=parsedPattern.data;const count=(await client.query<{n:number}>("SELECT count(*)::int AS n FROM patterns WHERE account_id=$1",[req.account!.id])).rows[0].n;if(count>=200 && !(await client.query("SELECT id FROM patterns WHERE account_id=$1 AND client_id=$2",[req.account!.id,p.id])).rowCount)throw badRequest("pattern_capacity","Remove unused tiles before adding more.");
         pattern=(await client.query<PatternRow>(`INSERT INTO patterns(account_id,facility,label,start_minute,end_minute,client_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(account_id,client_id) WHERE client_id IS NOT NULL DO UPDATE SET client_id=EXCLUDED.client_id RETURNING *`,[req.account!.id,p.facility,p.label,p.start,p.end,p.id])).rows[0];
        }
        return {shift:inserted.rows[0],pattern};
      });
      // A new shift can create a conflict: re-evaluate this account on the next scan instead of waiting for the
      // rotating cursor to come back around.
      await execute("UPDATE accounts SET needs_scan = true WHERE id = $1", [req.account!.id]);
      res.status(201).json({...toShift(result.shift),...(result.pattern?{pattern:toPattern(result.pattern)}:{})});
    }),
  );

  // The destructive `PUT /batch` replace-everything endpoint was REMOVED, not disabled. Bulk replacement deleted
  // the account's shifts and re-inserted them, which lost ids, versions and reminder lineage for anything the
  // client had not sent back verbatim. Appending is done by `POST /import` below, which is idempotent per
  // (requestId, index). A request to the old path now falls through to `PUT /:id`, where `validateId` rejects
  // "batch" as a non-UUID with 400 `invalid_id` — the same answer as any other malformed shift id.
  router.post("/import", asyncHandler(async(req,res)=>{
    const parsed=z.object({requestId:z.string().uuid(),detectDuplicates:z.boolean().optional(),shifts:z.array(z.object({
      platform:z.string().trim().min(1).max(100),facility:z.string().trim().min(1).max(200),label:z.string().max(200).default(""),
      start:z.number().int().min(0).max(1439),end:z.number().int().min(0).max(1439),date:z.string().refine(validDate),note:z.string().max(4000).nullable().optional(),
      // Migration 018. Without these two keys here, zod would strip them and an imported file would silently lose the
      // address and the contact — which is exactly the failure this column set exists to stop.
      address:z.string().max(200).nullable().optional(),contact:z.string().max(200).nullable().optional()
    }).refine(s=>s.start!==s.end)).min(1).max(200)}).safeParse(req.body);
    if(!parsed.success)throw badRequest("invalid_shifts","Import 1–200 valid shifts with a request UUID.");
    const shifts=parsed.data.shifts;
    const detectDuplicates=parsed.data.detectDuplicates===true;
    // Date bounds, checked before any write so an out-of-range row is a clear 400 naming the row, not a
    // CHECK-constraint failure part-way through the batch.
    const maxDate=shiftDateMax();
    for(const [i,s] of shifts.entries()){
      if(s.date<SHIFT_DATE_MIN||s.date>maxDate)throw badRequest("date_out_of_range",`Shift ${i+1} is dated outside the storable range (${SHIFT_DATE_MIN} to ${maxDate}).`);
    }
    const {rows,skipped}=await withTransaction(async c=>{
      const accountId=req.account!.id;
      const count=(await c.query<{n:number}>("SELECT count(*)::int AS n FROM shifts WHERE account_id=$1",[accountId])).rows[0].n;
      // Retries: rows whose deterministic client_id already exists (the same requestId re-sent). These are
      // idempotent re-assertions, never new capacity and never "duplicates" to report.
      const existing=new Set((await c.query<{client_id:string}>("SELECT client_id FROM shifts WHERE account_id=$1 AND client_id=ANY($2::text[])",[accountId,shifts.map((_,i)=>`import:${parsed.data.requestId}:${i}`)])).rows.map(x=>x.client_id));
      // Content already stored for the dates in this batch, so a duplicate is one query, not one per row. The key
      // is facility+date+start+end: the same shift at the same place and time, whatever app or label it came in
      // under. Intra-batch duplicates are caught by adding each planned row's key as we go.
      const seen=new Set<string>();
      if(detectDuplicates){
        const dates=[...new Set(shifts.map(s=>s.date))];
        const stored=await c.query<{facility:string;date:string;start_minute:number;end_minute:number}>(
          "SELECT facility,date::text AS date,start_minute,end_minute FROM shifts WHERE account_id=$1 AND date=ANY($2::date[])",[accountId,dates]);
        for(const r of stored.rows)seen.add(`${r.facility}|${r.date}|${r.start_minute}|${r.end_minute}`);
      }
      const plan=shifts.map((s,i)=>{
        const clientId=`import:${parsed.data.requestId}:${i}`;
        const isRetry=existing.has(clientId);
        const key=`${s.facility}|${s.date}|${s.start}|${s.end}`;
        const isDuplicate=detectDuplicates&&!isRetry&&seen.has(key);
        if(detectDuplicates&&!isRetry)seen.add(key);
        return {i,s,clientId,isRetry,isDuplicate};
      });
      const newInserts=plan.filter(p=>!p.isRetry&&!p.isDuplicate).length;
      if(count+newInserts>5000)throw badRequest("account_capacity","Import would exceed 5,000 shifts.");
      const rows:ShiftRow[]=[];
      const skipped:{index:number;reason:string}[]=[];
      for(const p of plan){
        if(p.isDuplicate){skipped.push({index:p.i,reason:"duplicate"});continue;}
        if(!p.isRetry)await assertWindowCapacity(accountId,p.s.date,null,c);
        const result=await c.query<ShiftRow>(`INSERT INTO shifts(account_id,platform,facility,label,start_minute,end_minute,date,note,address,contact,client_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(account_id,client_id) WHERE client_id IS NOT NULL DO UPDATE SET client_id=EXCLUDED.client_id RETURNING *`,
         [accountId,p.s.platform,p.s.facility,p.s.label,p.s.start,p.s.end,p.s.date,p.s.note??null,p.s.address??null,p.s.contact??null,p.clientId]);rows.push(result.rows[0]);
      }
      return {rows,skipped};
    });
    // An import can create many conflicts at once.
    await execute("UPDATE accounts SET needs_scan = true WHERE id = $1", [req.account!.id]);
    res.status(201).json({shifts:rows.map(toShift),skipped});
  }));

  // ---- change a shift -------------------------------------------------------------------------
  //
  // A shift can be moved, shortened or renamed. The reminders that were worked out for it are dropped: they
  // were about the shift as it was, and they would be wrong about the shift as it is.
  router.put(
    "/:id",
    asyncHandler(async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as {
        platform?: string;
        facility?: string;
        label?: string;
        start?: number;
        end?: number;
        date?: string;
        note?: string;
        address?: string | null;
        contact?: string | null;
        /** Optimistic concurrency: the `version` the client last read. Optional, so older clients keep working. */
        expectedVersion?: number;
      };
      // Migration 018, with the same three-way meaning as the create route: undefined keeps, null or "" clears.
      const address = optionalText((req.body ?? {}).address, "Address");
      const contact = optionalText((req.body ?? {}).contact, "Contact");

      const expectedVersion = body.expectedVersion;
      if (expectedVersion !== undefined && (!Number.isInteger(expectedVersion) || expectedVersion < 1)) {
        throw badRequest("version_invalid", "expectedVersion must be a positive whole number.");
      }

      const existing = await queryOne<ShiftRow>(
        `SELECT id, platform, facility, label, start_minute, end_minute, date, note, address, contact, version FROM shifts
          WHERE id = $1 AND account_id = $2`,
        [req.params.id, req.account!.id],
      );
      if (!existing) throw notFound("not_found", "That shift is not there any more.");

      const facility = body.facility === undefined ? existing.facility : (body.facility ?? "").trim();
      if (!facility) throw badRequest("facility_required", "Which facility is this shift at?");
      const platform = body.platform === undefined ? existing.platform : (body.platform ?? "").trim();
      if (!platform) throw badRequest("platform_required", "Which app is this shift from?");
      const date = body.date === undefined ? existing.date : body.date;
      if (!validDate(date)) throw badRequest("date_invalid", "Choose a date for the shift.");
      assertShiftDateBounds(date);
      const start = body.start === undefined ? existing.start_minute : body.start;
      const end = body.end === undefined ? existing.end_minute : body.end;
      if (!validMinute(start) || !validMinute(end)) throw badRequest("time_invalid", "Choose the start and end times.");
      if (start === end) throw badRequest("time_invalid", "A shift has to be longer than nothing.");

      await assertWindowCapacity(req.account!.id,date,req.params.id);
      // The version guard is in the WHERE, and the increment is in the SET, so a concurrent edit that lands between
      // the read above and this statement makes the UPDATE match no rows — the losing writer finds out instead of
      // silently overwriting the winner. `$10 IS NULL` disables the guard when the client sent no expectedVersion.
      const row = await query<ShiftRow>(
        `UPDATE shifts
            SET platform = $3, facility = $4, label = $5, start_minute = $6, end_minute = $7, date = $8,
                note = $9, address = $10, contact = $11, version = version + 1, updated_at = now()
          WHERE id = $1 AND account_id = $2 AND ($12::int IS NULL OR version = $12::int)
        RETURNING id, platform, facility, label, start_minute, end_minute, date, note, address, contact, version`,
        [
          req.params.id,
          req.account!.id,
          platform,
          facility,
          body.label === undefined ? existing.label : (body.label ?? "").trim(),
          start,
          end,
          date,
          body.note === undefined ? existing.note ?? null : body.note,
          address === undefined ? existing.address ?? null : address,
          contact === undefined ? existing.contact ?? null : contact,
          expectedVersion ?? null,
        ],
      );
      if (!row[0]) {
        // No rows: either the shift was removed, or its version moved on. Tell the two apart so the client knows
        // whether to reload-and-retry (conflict) or drop it (gone).
        const current = await queryOne<{ version: number }>(
          "SELECT version FROM shifts WHERE id = $1 AND account_id = $2",
          [req.params.id, req.account!.id],
        );
        if (!current) throw notFound("not_found", "That shift is not there any more.");
        throw new HttpError(409, "version_conflict", "That shift changed since you loaded it. Reload it and try again.", {
          details: { currentVersion: current.version },
        });
      }

      // The warnings that were worked out for the old version of this shift no longer apply.
      await execute("UPDATE reminders SET status='suppressed',error='shift_changed' WHERE account_id=$2 AND sent_at IS NULL AND (shift_id=$1 OR dedupe_key LIKE 'conflict:%'||$1||'%')", [req.params.id,req.account!.id]);
      // A moved shift changes every conflict it was part of, in both directions.
      await execute("UPDATE accounts SET needs_scan = true WHERE id = $1", [req.account!.id]);

      res.json(toShift(row[0]!));
    }),
  );

  // ---- remove many shifts at once -------------------------------------------------------------
  //
  // "Clear out last year" should not be five hundred round trips. This takes EITHER a list of ids (at most 500)
  // OR a date range, refuses both-or-neither, and does the work in ONE transaction so a bulk delete can never
  // half-apply. Queued (never-sent) reminders for the deleted shifts are suppressed first — while their shift_id
  // is still populated — so the scheduler does not keep re-rendering alerts for shifts that are gone; already-sent
  // reminders are left alone as history. Registered before DELETE /:id so "bulk" is not read as a shift id.
  router.delete(
    "/bulk",
    asyncHandler(async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as { ids?: unknown; from?: unknown; to?: unknown };
      const hasIds = Array.isArray(body.ids);
      const hasRange = body.from !== undefined || body.to !== undefined;
      // Exactly one of the two selectors: ids XOR range. Both, or neither, is a mistake worth naming.
      if (hasIds === hasRange) {
        throw badRequest("bulk_invalid", "Provide either a list of shift ids or a date range (from/to) — not both, and not neither.");
      }
      const accountId = req.account!.id;
      const deleted = await withTransaction(async c => {
        if (hasIds) {
          const ids = body.ids as unknown[];
          if (ids.length === 0 || ids.length > 500) throw badRequest("bulk_invalid", "Delete between 1 and 500 shifts by id at a time.");
          if (!ids.every((x) => typeof x === "string" && z.string().uuid().safeParse(x).success)) {
            throw badRequest("invalid_id", "Every id in the list must be a valid shift id.");
          }
          await c.query(
            "UPDATE reminders SET status='suppressed', error='shift_deleted' WHERE account_id=$1 AND sent_at IS NULL AND status='queued' AND shift_id=ANY($2::uuid[])",
            [accountId, ids],
          );
          const result = await c.query("DELETE FROM shifts WHERE account_id=$1 AND id=ANY($2::uuid[])", [accountId, ids]);
          await c.query("UPDATE accounts SET needs_scan=true WHERE id=$1", [accountId]);
          return result.rowCount ?? 0;
        }
        const from = body.from;
        const to = body.to;
        if (from !== undefined && !validDate(from)) throw badRequest("range_invalid", "Use YYYY-MM-DD dates in the range.");
        if (to !== undefined && !validDate(to)) throw badRequest("range_invalid", "Use YYYY-MM-DD dates in the range.");
        if (from !== undefined && to !== undefined && (from as string) > (to as string)) throw badRequest("range_invalid", "The start of the range is after the end of it.");
        await c.query(
          `UPDATE reminders SET status='suppressed', error='shift_deleted'
            WHERE account_id=$1 AND sent_at IS NULL AND status='queued'
              AND shift_id IN (SELECT id FROM shifts WHERE account_id=$1
                                 AND ($2::date IS NULL OR date >= $2::date)
                                 AND ($3::date IS NULL OR date <= $3::date))`,
          [accountId, from ?? null, to ?? null],
        );
        const result = await c.query(
          `DELETE FROM shifts WHERE account_id=$1
             AND ($2::date IS NULL OR date >= $2::date)
             AND ($3::date IS NULL OR date <= $3::date)`,
          [accountId, from ?? null, to ?? null],
        );
        await c.query("UPDATE accounts SET needs_scan=true WHERE id=$1", [accountId]);
        return result.rowCount ?? 0;
      });
      res.json({ deleted });
    }),
  );

  // ---- remove a shift -------------------------------------------------------------------------
  router.delete(
    "/:id",
    asyncHandler(async (req: Request, res: Response) => {
      const removed = await execute("DELETE FROM shifts WHERE id = $1 AND account_id = $2", [req.params.id, req.account!.id]);
      if (!removed) throw notFound("not_found", "That shift is not there any more.");
      // Removing a shift can resolve a conflict — but it can also create one with a shift that used to overlap
      // a third one. Re-evaluate rather than assume.
      await execute("UPDATE accounts SET needs_scan = true WHERE id = $1", [req.account!.id]);
      res.json({ ok: true, id: req.params.id });
    }),
  );

  // ---- the saved tiles -------------------------------------------------------------------------
  router.post(
    "/patterns",
    asyncHandler(async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as { id?: string; facility?: string; label?: string; start?: number; end?: number; address?: string | null };
      const address = optionalText((req.body ?? {}).address, "Address") ?? null;
      const facility = (body.facility ?? "").trim();
      if (!facility) throw badRequest("facility_required", "Which facility is this for?");
      if (!validMinute(body.start) || !validMinute(body.end)) throw badRequest("time_invalid", "Choose the start and end times.");
      const count=await queryOne<{n:number}>("SELECT count(*)::int n FROM patterns WHERE account_id=$1",[req.account!.id]);
      const retry=body.id?await queryOne("SELECT id FROM patterns WHERE account_id=$1 AND client_id=$2",[req.account!.id,body.id]):null;
      if((count?.n??0)>=200 && !retry)throw badRequest("pattern_capacity","Remove unused tiles before adding more.");
      if(body.start===body.end)throw badRequest("time_invalid","A pattern must have a duration.");
      const row = await query<PatternRow>(
        `INSERT INTO patterns (account_id, facility, label, start_minute, end_minute, address, client_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (account_id, client_id) WHERE client_id IS NOT NULL DO UPDATE SET client_id = EXCLUDED.client_id
         RETURNING id, facility, label, start_minute, end_minute, address`,
        [req.account!.id, facility, (body.label ?? "Custom").trim(), body.start, body.end, address, body.id ?? null],
      );
      res.status(201).json(toPattern(row[0]!));
    }),
  );

  router.delete(
    "/patterns/:id",
    asyncHandler(async (req: Request, res: Response) => {
      const removed = await execute("DELETE FROM patterns WHERE id = $1 AND account_id = $2", [req.params.id, req.account!.id]);
      if (!removed) throw notFound("not_found", "That tile is not there any more.");
      res.json({ ok: true, id: req.params.id });
    }),
  );

  // ---- the reminders that have gone out --------------------------------------------------------
  router.get(
    "/reminders",
    asyncHandler(async (req: Request, res: Response) => {
      const rows = await query<{ id: string; kind: string; status:string; scheduled_for: Date; sent_at: Date | null; channel: string | null; error: string | null }>(
        `SELECT id, kind, status, scheduled_for, sent_at, channel, error FROM reminders
          WHERE account_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [req.account!.id],
      );
      res.json({
        reminders: rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          status:r.status,
          acceptedAt:r.sent_at,
          scheduledFor: r.scheduled_for,
          sentAt: r.sent_at,
          channel: r.channel,
          error: r.error,
        })),
      });
    }),
  );

  // ---- export to CSV --------------------------------------------------------------------------
  //
  // A person leaving, or moving to another tool, has to be able to take their data with them (and the 5,000-shift
  // cap means an account can outgrow what the screen shows). Same range semantics as the list read, same 5,000
  // ceiling, but the body is RFC 4180 CSV rather than JSON. Registered before GET /:id so "export.csv" is not read
  // as a shift id.
  router.get(
    "/export.csv",
    asyncHandler(async (req: Request, res: Response) => {
      const accountId = req.account!.id;
      if ((req.query.from !== undefined && !validDate(req.query.from)) || (req.query.to !== undefined && !validDate(req.query.to))) {
        throw badRequest("range_invalid", "Use YYYY-MM-DD dates in the range.");
      }
      // No default window here, unlike the list read: an export means "give me my data", so an absent range is
      // every shift (still capped at 5,000, with a clear error telling the user to narrow it if they exceed that).
      const from = validDate(req.query.from) ? (req.query.from as string) : null;
      const to = validDate(req.query.to) ? (req.query.to as string) : null;
      if (from && to && from > to) throw badRequest("range_invalid", "The start of the range is after the end of it.");
      const shifts = await query<ShiftRow>(
        `SELECT id, platform, facility, label, start_minute, end_minute, date, note, address, contact, version FROM shifts
          WHERE account_id = $1
            AND ($2::date IS NULL OR date >= $2::date)
            AND ($3::date IS NULL OR date <= $3::date)
          ORDER BY date, start_minute
          LIMIT $4`,
        [accountId, from, to, MAX_SHIFTS + 1],
      );
      if (shifts.length > MAX_SHIFTS) throw badRequest("range_too_large", "Choose a smaller date range (maximum 5,000 shifts). Nothing has been truncated.");
      // RFC 4180: a field is quoted when it contains a comma, a double-quote, CR or LF; an embedded quote is
      // doubled. Everything is quoted-or-safe, so a facility named `St Mary's, "Annexe"` cannot break the columns.
      const csvField = (value: string | number | null): string => {
        const s = value === null || value === undefined ? "" : String(value);
        return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const minutesToHHMM = (m: number): string => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
      // `address` and `contact` join the export with migration 018: a person taking their data has to get the two fields
      // the screen has been collecting. They are appended, so a reader that knows the old header keeps working.
      const header = ["date", "start", "end", "platform", "facility", "label", "note", "address", "contact", "id", "version"];
      const lines = [header.join(",")];
      for (const s of shifts) {
        lines.push([
          csvField(s.date),
          csvField(minutesToHHMM(s.start_minute)),
          csvField(minutesToHHMM(s.end_minute)),
          csvField(s.platform),
          csvField(s.facility),
          csvField(s.label),
          csvField(s.note ?? ""),
          csvField(s.address ?? ""),
          csvField(s.contact ?? ""),
          csvField(s.id),
          csvField(s.version),
        ].join(","));
      }
      // A leading BOM makes Excel open the UTF-8 file without mangling accented facility names. CRLF is the line
      // ending the RFC specifies.
      const csv = "\uFEFF" + lines.join("\r\n") + "\r\n";
      const stamp = new Date().toISOString().slice(0, 10);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="phylax-shifts-${stamp}.csv"`);
      res.setHeader("Cache-Control", "no-store");
      res.send(csv);
    }),
  );

  // ---- one shift ------------------------------------------------------------------------------
  //
  // This is last on purpose. A path like `/:id` matches anything, so it has to come after the named paths
  // (`/patterns`, `/reminders`, `/export.csv`) — otherwise `GET /api/shifts/reminders` would be read as a shift
  // whose id is "reminders", and the reminders would never be found.
  router.get(
    "/:id",
    asyncHandler(async (req: Request, res: Response) => {
      const row = await queryOne<ShiftRow>(
        `SELECT id, platform, facility, label, start_minute, end_minute, date, note, address, contact, version FROM shifts
          WHERE id = $1 AND account_id = $2`,
        [req.params.id, req.account!.id],
      );
      if (!row) throw notFound("not_found", "That shift is not there any more.");
      res.json(toShift(row));
    }),
  );

  return router;
}

export { toShift, toPattern };
export type { Shift };

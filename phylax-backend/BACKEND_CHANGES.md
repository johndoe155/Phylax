# Backend changes

`../phylax/UI_CHANGES_LOG.md` covers the interface, and `../phylax/VERIFICATION.md` records what was run. This file covers the **two files** that had to change on the server side, and
why. The standing rule for this work was that the backend is the mature source of truth and is not to be refactored; the
changes below are additive, small, and each one exists only because the browser has been collecting a field the schema
never stored.

Nothing else in `server/` was touched. `server/index.ts`, `server/routes/auth.ts` (except as noted), `csrf.ts`,
`config.ts`, `app.ts`, the scheduler and the mailer are unchanged.

---

## 1. `server/migrations/018_shift_address_contact.sql` (new)

Adds three nullable `text` columns, each with a 200-character CHECK:

| Table | Column | Why |
|---|---|---|
| `shifts` | `address` | The site's address. The dashboard shows it, the edit panel edits it, the CSV export has a column for it. |
| `shifts` | `contact` | Who to call about the shift. Filled from the shift's detail sheet (the note field's placeholder has always offered "contact"). |
| `patterns` | `address` | A saved tile is what a shift is logged from, so the address shown on the tile has to come from the server too. |

**The choice this records.** The alternative was to delete `address` and `contact` from the browser's model and let them
go. They cannot be deleted without lying: `client/src/lib/shifts.ts` and `lib/manageShifts.ts` both carry them, the
detail sheet writes them, the export column exists, and `lib/manageShifts.ts`'s own `FIELD_MAX` already caps the address
at 200 characters. Keeping them in `localStorage` only would split one shift across two stores — the same row with an
address on this device and none on another, and an export that disagrees with the account.

**Why it is safe.** Everything is additive and nullable: an account that never used the fields is unaffected, no backfill
is needed, no existing query or index changes, and re-running the file is a no-op (`ADD COLUMN IF NOT EXISTS`, and the
CHECKs are added behind a `pg_constraint` guard so a partial failure cannot leave a duplicate).

**Migration order.** It is the last migration, and `npm run dev` / boot applies it automatically
(`migrations applied: [... "017_oauth_state_binding", "018_shift_address_contact"]`).

## 2. `server/routes/shifts.ts` (+ `server/validation.ts`) — carrying the fields through

The route file already read shifts, patterns, imports and CSV; the changes are the plumbing for the two new columns and
nothing else:

| Route | Change |
|---|---|
| `GET /api/shifts` | selects `address`/`contact` (shifts) and `address` (patterns); `toShift`/`toPattern` always include them, as `null` when absent, so a client never has to tell "empty" from "not sent" |
| `POST /api/shifts` | accepts `address`/`contact`, validated by `optionalText` (trim, empty → `null`, over 200 chars → `400 invalid_input` naming the field rather than a CHECK violation surfacing as `invalid_input`) |
| `PUT /api/shifts/:id` | same three-way meaning as everywhere else: **absent** = leave as it is, `null` or `""` = clear. The update keeps `expectedVersion`, the version bump and the 409 body exactly as they were |
| `POST /api/shifts/import` | the per-row zod schema gains `address`/`contact`. **This was the actual data-loss bug**: zod strips unknown keys, so an imported file's addresses were being silently dropped |
| `POST /api/shifts/patterns` | accepts and stores `address` |
| `GET /api/shifts/export.csv` | `address` and `contact` appended to the header and the rows |
| `server/validation.ts` | `address`/`contact` named in the body schema (≤200) so an oversized value is a clear `400` |

**CSV compatibility.** The two columns are *appended* (after `note`, before `id`), so a reader written against the old
header keeps working; only the column order after `note` shifts.

---

## What deliberately was **not** changed

- **`shared/shifts.ts`** gains the two optional fields on its types — a type change only, no behaviour.
- **No route was renamed, no verb changed, no status code moved.** The browser adapts to the API, not the reverse:
  `note`↔`notes`, `reminderLeadMinutes`↔`leadMinutes`, `emailEnabled`↔`emailAlerts`, `PUT` not `PATCH`, `/shifts/bulk`
  with a JSON body, `/shifts/import` with `requestId` + 0-based `skipped[].index`, all of it lives in
  `client/src/lib/{accountApi.real,shiftsApi,shiftStore}.ts`.
- **The old `"password"` sign-up branch in `server/routes/auth.ts`** was already gone from this backend; the client-side
  counterpart in `SignUpMethod` was removed to match.
- **No new endpoint for custom platforms.** The account page's platform list stays in `localStorage` (`phylax.platforms`)
  because the API has no write route for it; adding one would have been a product decision, not an adapter.

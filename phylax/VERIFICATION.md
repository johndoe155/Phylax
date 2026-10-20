# Verification

What was actually run, against what, and what came back. Everything below was executed in this workspace; nothing here
is a plan or an expectation.

## The stack that was verified

| Piece | Detail |
|---|---|
| API | `/home/user/phylax-backend`, `npm run dev` → `PORT=3100`, `NODE_ENV=development`, `MAIL_PROVIDER=log` (so one-time links are printed to the server log), `SCHEDULER_ENABLED=false` (no reminder messages for test shifts) |
| Database | PostgreSQL **17.11**, local cluster, `postgres://phylax:phylax@127.0.0.1:5432/phylax`; all migrations applied on boot, including the new `018_shift_address_contact` |
| App (dev) | `/home/user/phylax`, `npx pnpm dev` → Vite on `:3000`, proxying `/api` → `127.0.0.1:3100` |
| App (same-origin) | `npm run build` + `node scripts/copy-build.mjs`, then the API serves the built app from `:3100` |
| Browser | Chromium via `playwright-cli` |

Three `APP_URL` values were used during the work, each matching the origin the page was actually served from:
`https://3000-<sandbox>.e2b.app` (the workspace preview, the value `phylax-backend/.env` now carries),
`http://localhost:3000` (the Vite dev server opened locally), and `http://localhost:3100` while the built app was served
by the API itself. This is not a nicety: with a mismatched `APP_URL` every `POST` is refused `403 cross_origin`, which is
exactly what happened the first time and is why the value is commented in `.env` with the three cases.

## Automated checks

```
phylax-backend:  npx tsc --noEmit          -> 0 errors
phylax-backend:  npx vitest run            -> 9 files passed, 114 tests passed (43 skipped: integration/oauth need a DSN)
phylax:          npx tsc --noEmit          -> 2 errors, both PRE-EXISTING and untouched by this work
                                             (PageLoader.tsx:135 SVG cast, TimezonePicker.tsx:221 setTimeout on never)
phylax:          npx vitest run            -> 20 files, 296 tests passed
phylax:          npx vite build            -> success (index.html 7.22 kB, was 374.24 kB before the plugin removal)
```

## Contract checks (curl, through the Vite proxy — the real same-origin path)

| Check | Result |
|---|---|
| `GET /api/auth/session` | `200`, sets `phylax_csrf` (Lax, readable by JS, `Max-Age=86400`), body `{"account":null}` |
| `POST` without `X-CSRF-Token` | `403 {"error":{"code":"csrf_failed",…}}` |
| `POST` with a foreign `Origin` | `403 {"error":{"code":"cross_origin",…}}` |
| `POST` with cookie + header, correct `Origin` | `200 {"status":"link-sent"}` |
| `GET /api/auth/providers` | `{providers:{apple:false,google:false},passkey:true,email:true,sms:true,turnstile:null}` |
| `GET /api/legal` | `{version:"2026-10-17.2",approved:false,…}` |
| Magic-link GET (`/api/auth/magic-link?token=…`) | `302` to `/redeem-link?token=…` |
| `POST /api/auth/magic-link/redeem` in the browser that asked | `{"redirect":"/welcome"}` for an unknown address, then a pending sign-up |
| `POST /api/auth/magic-link/redeem` from another client | `400 link_wrong_browser`, and the link is **not** consumed |
| `POST /api/account` with display name + consent | `{"id":"…","displayName":"Ada Nurse"}`; session now reports the account |
| `POST /api/shifts` with `address`+`contact` | `201`, both fields echoed back |
| `PUT /api/shifts/:id` with `note:null` | `200`, note cleared, `version` 1 → 2, address/contact preserved |
| `PUT` with a stale `expectedVersion` | `409 version_conflict` + `details.currentVersion` |
| `POST /api/shifts/patterns` with `address` | `201`, address stored and returned by `GET /api/shifts` |
| `POST /api/shifts/import` (2 rows, one duplicate) | `201 {shifts:[…], skipped:[{index:0,reason:"duplicate"}]}` — 0-based, as the adapter expects |
| Same import replayed with the same `requestId` and `detectDuplicates:false` | a second set of rows (the idempotency key is per-row `import:<requestId>:<index>`, so a *different* payload under the same id is a new row — the adapter therefore mints a fresh `requestId` per import) |
| `GET /api/shifts/export.csv` | header `date,start,end,platform,facility,label,note,address,contact,id,version` — the two new columns appended |
| `DELETE /api/shifts/bulk` with `{ids:[…]}` | `{"deleted":3}` |
| `GET /api/shifts/not-a-uuid` | `400 invalid_id` |
| `GET /api/meta/timezones` | `200`, the account page's picker list |

## Browser walk-through (Chromium, built app served by the API)

1. `/login` renders with the email, passkey and password options; no providers configured on this deployment.
2. Email link → "Email me a link" → `200`, the link printed in the server log → opened in the **same** browser →
   `/redeem-link?token=…` prefilled → "Continue sign-in" → **`/dashboard`**, signed in. (The same link opened from a
   different client was refused with `link_wrong_browser` and stayed usable — the intended behaviour.)
3. Pending sign-up → account created → dashboard renders with the account's display name in the greeting.
4. "Log a shift": ShiftKey + the saved tile + tomorrow today → "Save shift" → `POST /api/shifts 201`; the tile appears
   in the week strip and "Shifts in range (1)" on `/shifts`.
5. `/shifts` → Edit → note saved → `PUT … 200`, `version` 2, and the row keeps its `address`.
6. **Conflict**: another client bumped the same shift, then Save in the panel → `409`, the panel shows *"Changed
   somewhere else — Label was updated after you opened this shift. Nothing of yours was saved."* with **Load latest** and
   **Keep my edits**; "Load latest" refilled the form with the server's `version` and the panel became saveable again.
7. Delete → confirmation dialog → accept → `DELETE … 200`, the list drops to "(0)".
8. Import: a `phylax.shifts` v1 file with two rows (one carrying `address`) → staged preview shows both → "Confirm
   append" → `201`; `GET /api/shifts` shows both rows, the address intact.
9. `/account`: display name, email, devices list ("This device", plus the curl session opened during the API checks,
   each with **Revoke**), timezone list from `/api/meta/timezones`, reminder lead time 180, alert switches, passkeys
   section, history panel — all populated from the account, no console errors.
10. Sign out → `POST /api/auth/logout 200`; `/dashboard` then redirects to `/login?next=%2Fdashboard`; `/account` shows
    its "Signed out — Sign in to manage your account" card (it is not wrapped in the redirect, on purpose).

## CSP and same-origin deployment

With the built app in place, the API serves `/` and sets:

```
script-src 'self' 'sha256-KJcAqeZbBFFLlpU2yFGRVN2Dec3RIWAc2WjyrubrQn8='
```

That hash was recomputed independently from the inline script in the served `index.html` and matches. It is the **only**
inline script left (the page-loader gate). `connect-src 'self'` covers every request the app makes — all of them are
relative paths to `/api/…`. Turnstile's origins are added by the server only when both Turnstile keys are configured.

## Known gaps in this environment

- **No WebAuthn end-to-end run.** The browser in this sandbox has no authenticator, so the passkey ceremonies
  (`POST /auth/passkey/options` → `navigator.credentials.create/get` → `/verify`, and the re-authentication variants) were
  verified by contract and by the transport code path (`client/src/lib/webauthn.ts` ↔ `@simplewebauthn/server` 13.x
  base64url JSON), not by a real ceremony.
- **No OAuth end-to-end run.** This deployment has no provider client ids; `GET /auth/providers` correctly reports
  `apple:false, google:false`, and the buttons are disabled accordingly. The `?error=oauth` handler on `/login` was
  exercised by visiting the URL directly.
- **Mail is the log provider**, so the one-time links were read from the server log rather than an inbox. The link
  format, TTL and browser binding are the same either way.
- **The two pre-existing TypeScript errors** (`PageLoader.tsx`, `TimezonePicker.tsx`) were left alone: they are unrelated
  to this work, they are in files this work did not touch, and fixing them would have meant editing UI files without a
  functional reason.

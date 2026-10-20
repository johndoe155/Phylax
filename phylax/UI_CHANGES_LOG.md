# UI changes log

Every change made to the interface while connecting the app to the real API. The rule this file follows is the one set
at the start of the work: **the interface stays as it was unless a change is forced by the backend's contract**, and
anything that did change is written down here, conservatively — what changed, why it had to, and what a person will
actually see differently.

"UI" here means anything a person can see or touch: markup, copy, layout, controls, focus order, what a button does. It
does **not** mean the adapter layer behind it (`lib/apiClient.ts`, `lib/auth.ts`, `lib/accountApi.real.ts`,
`lib/shiftsApi.ts`, `lib/shiftStore.ts`), which is where almost all of the work happened and which changes no pixels.

---

## Summary

| # | Screen | Change | Kind |
|---|--------|--------|------|
| 1 | All signed-in pages | Rendered only once the session is known (a hold, not a spinner) | Behavioural, no new visuals |
| 2 | `/dashboard`, `/shifts` | Signed out → redirected to `/login?next=…` | Behavioural |
| 3 | `/account` | Unchanged: keeps its own "Signed out" card | None (a planned wrapper was removed) |
| 4 | `/login` | `?error=oauth` / `?error=linking` now shows a message | Copy path already existed, now fed |
| 5 | `/login` → email tab | "We'll email you a link…" helper unchanged; the send is now a real request | None visually |
| 6 | `/login` → password tab | No "create an account with this password" branch | Branch removed (nothing rendered it) |
| 7 | `/shifts` → Edit shift | Conflict notice ("Changed somewhere else") | Built into the page before this work; now reachable |
| 8 | `/shifts` → Import | File labelled "Phylax export" and per-row `address` carried through | None visually |
| 9 | `/dashboard` | Schedule, tiles and rules now come from the account, not this browser | Same pixels, different source |
| 10 | Every page | No Manus runtime script, no analytics tag, no debug collector | **Removed** from the document head/body |
| 11 | `/account` → Delivery | `reminderLeadMinutes`, alert toggles and timezone are the account's values | Same controls, real values |

Nothing above added, removed or restyled a component in `client/src/components/`. There are **no new screens, no new
controls and no new stylesheets** in this work.

---

## The changes in detail

### 1. Signed-in pages render only after the session is known

**What changed for a person:** on a slow connection, `/dashboard`, `/shifts` and `/account` show the page's dark
background (and the page loader already playing over it) for a moment longer than before, instead of drawing an empty
schedule and then filling it in.

**Why it was forced:** the session is an `httpOnly` cookie. Before this work the app answered "is anybody signed in?" from
`localStorage`, synchronously, so every page could render immediately. It now has to ask the server
(`GET /api/auth/session`), and until that answers there is no honest answer to give. Rendering the signed-out layout in
the meantime would show a *wrong* state and, worse, issue data requests on a guess.

**How it was kept invisible:** the hold draws nothing of its own — it is the same `site-shell` background the pages
already sit on, with the existing page loader over it. No spinner, no skeleton, no new component was introduced. After
the answer arrives, rendering is identical to before.

- `client/src/components/RequireSession.tsx` (new, 26 lines, draws only a bare shell while waiting)
- `client/src/App.tsx` (waits for the first session read before mounting the router)

### 2. `/dashboard` and `/shifts` send a signed-out visitor to sign in

**What changed for a person:** opening either page without a session lands on `/login?next=/dashboard` (or `/shifts`).
Signing in returns them to the page they asked for.

**Why it was forced:** both pages assume an account — the dashboard's schedule and the shifts page's range reads are
per-account. Previously a visitor with no local data saw an empty dashboard that looked like a real, empty account. The
server would have answered `401` for every read.

**Note on the "next" parameter:** the sign-in page already reads `next` from the query string; it is now supplied.

### 3. `/account` deliberately did **not** get the same treatment

The account page already renders its own signed-out card ("Signed out — Sign in to manage your account") and its own busy
shell. Wrapping it in the redirect would have removed the one screen that explains *why* nothing is shown, so the route
was left unwrapped and the page keeps guarding itself exactly as before. (An earlier draft of this work wrapped it; that
wrapper was removed — see `client/src/App.tsx`.)

### 4. `/login` can now show the reason a provider sign-in failed

**What changed for a person:** arriving at `/login?error=oauth` (a provider callback that failed), `?error=linking`
(a provider sign-in while already signed in, used to link), or `?error=link` (a malformed or expired email link) now puts
a sentence in the form's error slot and moves the sheet to its error state.

**Why:** the server redirects to those URLs. The sign-in page already had the error state and the copy; it had nothing
reading the query string. No new element was added — the existing error paragraph is reused.

- `client/src/pages/Login.tsx` (a `QUERY_ERRORS` map plus one effect)

### 5. The email tab's helper text is unchanged, but the send is real

No copy changed. The paragraph under the email field still says the link signs you in without a password, which is now
literally true of the backend rather than a simulation.

### 6. The password tab no longer offers to create an account

**What changed for a person:** nothing visible. The backend never registers an address from a typed password (a password
can only be *added* to an account that was created by an email link, a passkey or a provider), and the client-side
`"password"` sign-up method — which existed only to serve the old simulation — has been deleted from
`SignUpMethod` and from the pending-signup flow. Nothing in the render tree referenced it, so no markup changed.

**Why it matters anyway:** it removes the possibility of a screen offering something the API will refuse.

### 7. "Changed somewhere else" on the edit panel is now reachable

**What changed for a person:** if a shift is edited in another tab or on another device while the edit panel is open,
saving shows the panel's existing notice — *"Changed somewhere else. \<Field\> was updated after you opened this shift.
Nothing of yours was saved."* — with **Load latest** and **Keep my edits**.

**Why:** the page already had this notice and these two buttons, written for a local store that could not actually
produce the conflict. The API now does (a `409 version_conflict` on an out-of-date `expectedVersion`), and the adapter
fills the notice's data. No copy or markup was written for this work; it was verified end to end (see the verification
notes).

### 8. Import: the address now survives the round trip

**What changed for a person:** nothing visible. A row with an `address` imports with its address, and the staged table
shows what it always showed. Before the schema change described in `phylax-backend/BACKEND_CHANGES.md`, the address was silently
dropped by the API's validator.

### 9. The dashboard's data source changed, not its design

The three stores that held the schedule (`shifts`, saved tiles, alert rules) now read and write the account instead of
`localStorage`:

```diff
-  const [shifts, setShifts] = useStored<Shift[]>("phylax.shifts", []);
-  const [patterns, setPatterns] = useStored<Pattern[]>("phylax.patterns", DEFAULT_PATTERNS);
-  const [rules, setRules] = useStored<Rules>("phylax.rules", DEFAULT_RULES);
+  const [shifts, setShifts] = useServerShifts();
+  const [patterns, setPatterns] = useServerPatterns();
+  const [rules, setRules] = useServerRules();
```

Three lines in `pages/Dashboard.tsx`; the rest of the file — every component, every handler, every string — is
untouched, because the replacement hooks keep the `[value, setter]` shape the page already used. Custom platforms stay
in `localStorage` (`phylax.platforms`): the API has no write route for them, so moving them would have meant inventing an
endpoint.

The visible consequence, which is the point of the whole integration: the schedule now follows the account to any
device, and a shift logged on a phone appears on a laptop.

### 10. Third-party and development scripts removed from the document

**What changed for a person:** no visual difference. Three Manus plugins injected scripts into the app; all three are
gone, and the analytics tag was removed from `client/index.html`.

| Removed | Where it came from | Why it had to go |
|---|---|---|
| `vitePluginManusRuntime` | `vite.config.ts` | Injected a ~350 kB inline script into **every production build**. The API computes its CSP `script-src` hashes from the built `index.html` at boot, so that script had to be hashed on every start, and any drift between build and boot blocked the page's own loader gate. |
| `vitePluginManusDebugCollector` (+ `/__manus__/logs`, `client/public/__manus__/debug-collector.js`) | `vite.config.ts` | Posted this browser's console output, network log and "session replay" events to a local file in development. Nothing about Phylax needs that, and shipping it to production would have been a leak. |
| `vitePluginStorageProxy` (`/manus-storage/*`) | `vite.config.ts` | Redirected to a bucket using `BUILT_IN_FORGE_API_*` credentials from the environment. No code in the app ever requested that path. |
| `<script src="%VITE_ANALYTICS_ENDPOINT%/umami">` | `client/index.html` | An unresolvable placeholder that produced a **broken external `<script>` on every page**, and would have needed a CSP exception for a domain nobody configured. |
| `client/public/manus-routes.json` | `client/public/` | Preview-host route metadata, served publicly and unused. |
| `components/ManusDialog.tsx` | `client/src/components/` | Unreferenced component from the hosting template. |

**Result:** the built `index.html` went from **374 kB to 7 kB**, and the only inline script left is the page-loader gate,
whose hash the API reads from that file at boot (verified: the hash in the served `Content-Security-Policy` matches the
inline script byte for byte).

### 11. The account page's values are the account's values

No control changed. What a person sees differs only in being correct and shared: the reminder lead time, the email/SMS
alert switches, the timezone and the "Signed-in devices" list all reflect the account rather than this browser. Two
field names are translated by the adapter and nowhere else, so no label or input was renamed:

| On screen (unchanged) | API field |
|---|---|
| "Reminder lead time (minutes)" | `settings.reminderLeadMinutes` |
| "Email alerts" | `settings.emailEnabled` |
| "Text alerts" | `settings.smsEnabled` |
| Display name | `account.displayName` |
| Passkeys list | `GET /auth/passkeys` |
| Email / Google / Apple buttons | `methods[]` from `GET /account`, `providers` from `GET /auth/providers` |

The "Link Google" / "Link Apple" buttons on the account page now follow `GET /auth/providers`: on a deployment without
provider credentials the server answers `503` for the start route, so the buttons are disabled rather than leading to a
dead page. (The flags are a runtime value, not a build-time constant, so the same build behaves correctly on a
deployment that does configure them.)

---

## What was checked, and how

Verified in a real browser against the real API and a real PostgreSQL 17 database (see `VERIFICATION.md` for the full
transcript): the sign-in page with no providers configured, an email link end to end (including the "wrong browser"
refusal), account creation, the dashboard, logging a shift, editing it, a **409 conflict in the edit panel** and its
"Load latest" recovery, deleting a shift through the confirmation dialog, importing a file (with `address`), the account
page (devices list, timezone list, alert settings, passkeys section), sign-out, and the redirect from `/dashboard` to
`/login?next=%2Fdashboard`. Console output was clean apart from the deliberate `400`/`409` responses being exercised.

---

## Things that were deliberately *not* changed

- **Copy, layout, spacing, colour, motion, fonts, icons:** untouched.
- **Navigation structure** (header links, the "Log a shift" sheet, the week strip, the shift detail sheet): untouched.
- **The account page's section order and headings:** untouched.
- **Error wording:** where the API supplies a sentence, it is shown as written. The adapter only picks which field an
  error sits under and whether it becomes a "sign in again" prompt.
- **The page loader and its 30-minute cooldown** (`index.html`, `components/PageLoader.tsx`): untouched, including the
  inline script whose hash the CSP must preserve.
- **`address` / `contact` on shift forms:** the forms already had them (the note field's placeholder has always said
  "Door code, contact, anything to remember"), so the fix was on the server side, not in the UI — see
  `../phylax-backend/BACKEND_CHANGES.md`.

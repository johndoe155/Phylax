# API — current corrective revision

Same-origin `/api`, JSON, session cookie and `X-CSRF-Token` double-submit protection for browser mutations. GET `/api/auth/session` establishes the readable `phylax_csrf` cookie. Operations require independent `X-Ops-Token` and are blocked at production nginx; access Express on loopback. Webhooks use their own authentication and are exempt from browser CSRF.

Errors: `{error:{code,message,field?}}`; safe 400/401/403/404/409/413/429/503 responses. An `account_busy` 409 is retryable, not a successful save. Request validation lives in `server/validation.ts`; routes are authoritative for endpoint-specific limits.

## Identity

- POST `/auth/password` `{email,password}`: existing valid credentials → `signed-in`; unknown/wrong credentials → generic 401 `invalid_credentials`. **No password signup branch.**
- POST `/auth/magic-link` `{email}`: generic `link-sent`; GET link is preview/redirect only. POST `/auth/magic-link/redeem` explicitly consumes a valid token. Existing account signs in; unknown proved address creates a pending signup.
- GET `/auth/pending`; POST `/account` `{displayName,timezone,consent:{termsVersion,privacyVersion,acceptedAt}}` completes a proved non-passkey pending signup. Current consent version: **2026-10-17.2**.
- Passkey signup: POST `/auth/passkey/register/start`, `/auth/passkey/register/options`, `/auth/passkey/register/verify`. Authentication: POST `/auth/passkey/options`, `/auth/passkey/verify`. Consult `server/routes/auth.ts` and client auth wrappers for ceremony payloads; WebAuthn requires challenge/origin/RP/user verification, not just credential IDs.
- POST `/auth/password/forgot` `{email}` is generic. POST `/auth/password/reset` `{token,newPassword}` checks delivered-email binding, consumes once, revokes sessions and commits security notice with the change.
- POST `/auth/password/add` `{newPassword}`, `/auth/password/change` `{currentPassword,newPassword}`. Email proof/recent authentication applies as enforced by route.
- POST `/auth/reauthenticate` `{password}` grants a fresh 10-minute security window; `POST /auth/reauthenticate/passkey/options` starts the equivalent passkey step-up. `POST /auth/reauthenticate/link` sends a current-session-bound email link for accounts that have a verified email.
- DELETE `/auth/providers/:provider`, `/auth/password`, and `/auth/email` require recent authentication and refuse to remove the last usable sign-in method.
- GET `/meta/timezones` lists timezone names accepted by both ICU and PostgreSQL.
- GET `/shifts/export.csv` exports bounded shift rows. DELETE `/shifts/bulk` atomically deletes selected IDs or a date range; edits accept `expectedVersion` and return 409 on stale writes. Import can request duplicate detection.
- GET `/ops/reminders?status=dead,failed` lists paginated dead/failed reminders; ops replay/acknowledgement use the returned IDs.
- POST `/auth/email/verification`; POST `/auth/email/change` `{email}`; POST `/auth/email/confirm` `{token}`. Email changes need the requesting account's fresh live session. The confirm response includes `credentialsReset` for provisional-email takeover protection.
- POST `/auth/phone/verification` `{phone}` and `/auth/phone/confirm` `{code}` prove phone ownership under durable send/attempt budgets.
- GET `/auth/passkeys`, POST `/auth/passkey/add/options`, `/auth/passkey/add/verify`, DELETE `/auth/passkeys/:id` (cannot remove final sign-in method).
- GET `/auth/sessions`; DELETE `/auth/sessions/:id`; POST `/auth/sessions/others`; POST `/auth/logout`.
- GET `/auth/security-events`: latest 50 account-scoped changes.
- OAuth starts at GET `/auth/oauth/:provider/start`, callbacks `/auth/oauth/callback`; new provider linking requires fresh authentication to the verified existing account, not matching email alone.

## Account and shifts

- GET `/account`: account/settings/methods/consents. PUT `/account` changes display name.
- PUT `/account/settings`: timezone, travel/cutoff/lead, opt-in verified email/SMS contacts. Unavailable or unverified channels cannot be enabled.
- POST `/account/consent` `{consent:{termsVersion,privacyVersion,acceptedAt}}` accepts current version.
- GET `/account/export`; DELETE `/account` requires fresh proof and current password for password accounts. Live deletion and backup expiry differ.
- GET `/shifts?from=YYYY-MM-DD&to=YYYY-MM-DD`: records including notes, patterns/rules/timezone. 5,000 account records maximum; excess is an explicit error, not silent oldest-2,000 truncation.
- POST `/shifts`: `{id?,platform,facility,label,start,end,date,note?,pattern?}`. `start/end` are minutes 0–1439, unequal; real calendar date required. Optional `id` is account-scoped idempotency key; optional saved pattern is created in the same transaction.
- PUT `/shifts/:id` updates supported fields; DELETE `/shifts/:id` removes only that record. Active delivery guards make conflicting mutation retryable.
- POST `/shifts/import` `{requestId:UUID,shifts:[...]}` appends 1–200 validated rows atomically, account/idempotency scoped. Repeating a committed request at capacity returns existing rows. PUT `/shifts/batch` is disabled; it never destructively replaces data.
- POST `/shifts/patterns`, DELETE `/shifts/patterns/:id` manage tiles. Max 200 tiles; 500 shifts in every rolling 29-day window. `GET /shifts/reminders` returns latest 50 with `status`, `scheduledFor`, `acceptedAt` and compatibility `sentAt`; acceptance is not delivery.

## Operator and callbacks

- GET `/health`: DB/scheduler health; 503 when unhealthy.
- GET `/ops/status`: protected heartbeat, queue/dead/delivery failures, current-provider delivered counts in last 24h, pending security notices and provider configuration.
- POST `/ops/scheduler/run`: one guarded tick.
- POST `/ops/probe` `{email?,phone?}`: send to operator-owned destinations; verify physical receipt AND authenticated callbacks.
- POST `/ops/reminders/:id/replay`: live dead/failed entry → queued, increment idempotency generation. POST `.../acknowledge`: dispose dead/failed/bounced entry without pretending it delivered. DELETE `/ops/suppressions/:hash`: deliberate recipient unblock after investigation.
- POST `/webhooks/resend`: raw-body Svix verification (`svix-id/timestamp/signature`). POST `/webhooks/twilio`: exact public URL/sorted form signature with Twilio token. Postmark, SMTP and custom SMS relay routes use configured secrets; see `server/routes/webhooks.ts` for exact event contracts before wiring a relay. Do not assume arbitrary provider payloads are compatible.

See [release remediation](RELEASE-REMEDIATION.md) for real delivery/restore/legal gates and evidence limits.

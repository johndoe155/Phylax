# Phylax — integrated codebase

Two projects: the React app (`phylax/`) and the API it now talks to (`phylax-backend/`). The app's data used to live in
`localStorage`; it now lives in the account on the server, and everything that bridges the two contracts sits in adapter
files rather than in components.

```
phylax/                 the frontend (Vite 7, React 19, TypeScript). Root of the Vite project is phylax/client.
  client/src/lib/       apiClient.ts, auth.ts, webauthn.ts, accountApi.real.ts, shiftsApi.ts, shiftStore.ts   <- the adapters
  client/src/hooks/     useAuth.ts
  client/src/components/RequireSession.tsx
  UI_CHANGES_LOG.md     every interface change, and why it was forced
  VERIFICATION.md       what was actually run and what came back
  scripts/copy-build.mjs  puts a production build where the API serves it

phylax-backend/         the API (Express, PostgreSQL). This is the mature source of truth; it was not refactored.
  server/migrations/018_shift_address_contact.sql   the one schema change (additive, nullable)
  BACKEND_CHANGES.md    the two files that changed on the server side, and why
  .env                  local development values only (see "Running it" below)
```

Excluded from this archive, because they are generated: `node_modules/`, `dist/`, `var/`, and `phylax/.env.local`
(a hosting token that belongs to nobody's repository).

## Running it

Prerequisites: Node 22+, pnpm (the app pins `pnpm@10.4.1`), and PostgreSQL 15+.

```bash
# 1. the database
createdb phylax                       # or: CREATE ROLE/DB as in phylax-backend/docs

# 2. the API (applies its own migrations on boot)
cd phylax-backend
npm install
#    .env ships with throwaway development values. Set DATABASE_URL to your own database, and set APP_URL to the
#    origin the page will be served from — that is what `requireSameOrigin` compares a POST's Origin against:
#      http://localhost:3000        when using `npm run dev` below
#      http://localhost:3100        when the API serves the built app itself
npm run dev                           # -> http://localhost:3100, mail printed to the log

# 3. the app, in a second terminal
cd phylax
npx pnpm@10.4.1 install --frozen-lockfile
npx pnpm dev                          # -> http://localhost:3000, proxying /api to :3100
```

Sign in with an email link: the link is printed in the API's terminal (`--- email (provider: log) ---`), and it only
redeems in the same browser that asked for it — that is the backend's browser binding, not a bug.

**Same-origin deployment** (which is what production is, and what session cookies, CSRF and the origin check assume):

```bash
cd phylax && npx pnpm run build:serve   # builds, then copies dist/public into phylax-backend/dist/public
cd ../phylax-backend && npm start       # serves the app and /api on :3100
```

Set `APP_URL` to that address first. The API hashes the inline loader-gate script in the built `index.html` at boot to
build its Content-Security-Policy, so the build must be served unedited.

## Checks

```bash
cd phylax          && npx tsc --noEmit   # 2 errors, both pre-existing and in files this work did not touch
cd phylax          && npx vitest run     # 296 passing
cd phylax-backend  && npx tsc --noEmit   # clean
cd phylax-backend  && npx vitest run     # 114 passing (43 skipped: integration/OAuth need a live DSN and provider keys)
```

## Where to read first

- `phylax/UI_CHANGES_LOG.md` — the interface barely moved, and this says exactly how much and why.
- `phylax-backend/BACKEND_CHANGES.md` — the two server files that changed (one additive migration, field plumbing).
- `phylax/VERIFICATION.md` — the transcript of what was exercised end to end, including the gaps (no authenticator, no
  provider credentials in the test environment).

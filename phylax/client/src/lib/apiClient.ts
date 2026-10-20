/**
 * The one HTTP client for the Phylax API.
 *
 * Everything that talks to the server goes through `apiFetch`, so the cross-cutting rules live in exactly one place:
 *
 *   CREDENTIALS. `credentials: "same-origin"`. The session is an httpOnly first-party cookie; without this the browser
 *   would not send it and every signed-in call would answer 401.
 *
 *   CSRF. The API uses the double-submit pattern (see phylax-backend `server/csrf.ts`): the server puts a signed token
 *   in a cookie JavaScript CAN read (`phylax_csrf`) and every request that changes something must echo it in
 *   `X-CSRF-Token`. The cookie is minted by any request — in practice the boot-time `GET /api/auth/session` — so this
 *   module bootstraps it once, caches that promise, and re-bootstraps if a mutation is ever refused with `csrf_failed`
 *   (a stale tab whose cookie expired, say) before retrying the request exactly once. A POST, PUT or DELETE sent
 *   without the header is a 403, so nothing here may skip it.
 *
 *   ORIGIN. The server also refuses a mutating request whose `Origin` header is not its own `APP_URL`. That is why the
 *   app must be served from the same origin as the API (in development: the Vite proxy in vite.config.ts, which keeps
 *   the browser's Origin intact instead of rewriting it).
 *
 *   ERRORS. Every failure is `{ error: { code, message, field? } }` and is turned into an `ApiError` that carries the
 *   HTTP status, the stable machine-readable `code`, the human `message` and the optional `field` that pins it under an
 *   input. `details` keeps any extra keys the server sent (for example `currentVersion` on a 409), because the shift
 *   adapter needs them.
 *
 *   ABORT. Every call takes an `AbortSignal`. A cancelled call rejects with a `DOMException` named `AbortError`, which
 *   is exactly what the pages already treat as "the person left" and swallow silently.
 *
 * A network failure (server unreachable, DNS, offline) rejects with the browser's `TypeError`, which the pages already
 * read as "Couldn't reach Phylax". Nothing here converts it into an ApiError, because the two need different words.
 */

/** The cookie the server expects echoed in `X-CSRF-Token`. Mirrors `CSRF_COOKIE` in the backend. */
export const CSRF_COOKIE = "phylax_csrf";
export const CSRF_HEADER = "X-CSRF-Token";

/** The error code the server uses when the CSRF token is missing or stale. */
export const CSRF_FAILED = "csrf_failed";

/** Every response is JSON except the CSV export, which the browser cannot read cross-escaping rules anyway (we build it here). */
export type Json = Record<string, unknown>;

/**
 * A structured failure from the API. `code` is the stable part (what the page branches on); `message` is written by the
 * server to be shown to a person; `field` pins it under one input when there is one.
 */
export class ApiError extends Error {
  status: number;
  code: string;
  field?: string;
  /** Extra keys the server sent beside `code`/`message`/`field` (e.g. `currentVersion`). */
  details: Record<string, unknown>;

  constructor(status: number, code: string, message: string, field?: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.field = field;
    this.details = details;
  }

  /** True for the codes that mean "prove it is still you" rather than "that failed". */
  get needsReauth(): boolean {
    return this.code === "reauthentication_required";
  }
}

/** Whether a rejection is a cancellation (the person left the page) rather than a failure worth showing. */
export const isAbortError = (error: unknown): boolean => error instanceof DOMException && error.name === "AbortError";

/** Whether a rejection is the browser failing to reach the server at all. */
export const isNetworkError = (error: unknown): boolean => error instanceof TypeError;

/** Read one cookie by name. Returns null on the server, or when the cookie is absent. */
export function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const parts = document.cookie ? document.cookie.split(";") : [];
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      const value = part.slice(eq + 1).trim();
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
  }
  return null;
}

/** The CSRF token this browser holds right now, or null when it has not been given one yet. */
export const csrfToken = (): string | null => readCookie(CSRF_COOKIE);

/**
 * Establish the CSRF cookie (and learn who is signed in) with one GET.
 *
 * The call is cached: everything that needs the token at boot awaits this same promise instead of firing its own
 * request. `resetCsrfBootstrap()` clears it so a `csrf_failed` can mint a fresh cookie once and retry.
 */
let bootstrapped: Promise<void> | null = null;

export function bootstrapCsrf(force = false): Promise<void> {
  if (force) bootstrapped = null;
  if (!bootstrapped) {
    bootstrapped = fetch("/api/auth/session", {
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    })
      .then(() => undefined)
      .catch(() => {
        // A failure here is not fatal: the next mutating call will try again, and a GET-only page still works.
        bootstrapped = null;
      });
  }
  return bootstrapped;
}

export type ApiRequest = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Sent as JSON. `undefined` sends no body (which is right for GET and for body-less DELETEs). */
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
};

/** Parse a failed response into an ApiError, tolerating a body that is not the documented envelope (an HTML 502, say). */
async function toApiError(response: Response): Promise<ApiError> {
  let payload: unknown = null;
  try {
    const type = response.headers.get("content-type") ?? "";
    if (type.includes("json")) payload = await response.json();
  } catch {
    payload = null;
  }
  const envelope = (payload && typeof payload === "object" ? (payload as { error?: unknown }).error : null) as
    | Record<string, unknown>
    | null;
  if (envelope && typeof envelope.code === "string") {
    const { code, message, field, ...details } = envelope;
    return new ApiError(
      response.status,
      code,
      typeof message === "string" && message ? message : "Something went wrong. Try again.",
      typeof field === "string" ? field : undefined,
      details,
    );
  }
  // No envelope: the server or a proxy answered with something else. Keep it honest but useless to the person.
  const headerCode = response.headers.get("x-error-code");
  const fallback =
    response.status === 401 ? "not_signed_in"
    : response.status === 403 ? "forbidden"
    : response.status === 404 ? "not_found"
    : response.status === 429 ? "too_many_attempts"
    : response.status >= 500 ? "unavailable"
    : "invalid_input";
  return new ApiError(
    response.status,
    headerCode || fallback,
    response.status >= 500
      ? "Phylax is having trouble right now. Try again in a moment."
      : "That request could not be completed. Reload the page and try again.",
  );
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** One attempt, with the CSRF header when the method changes something. */
async function attempt(path: string, init: ApiRequest, token: string | null): Promise<Response> {
  const method = init.method ?? "GET";
  const headers: Record<string, string> = { Accept: "application/json", ...(init.headers ?? {}) };
  if (MUTATING.has(method) && token) headers[CSRF_HEADER] = token;
  if (init.body !== undefined && !("Content-Type" in headers)) headers["Content-Type"] = "application/json";
  return fetch(path, {
    method,
    credentials: "same-origin",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal,
    // The API answers with no-store already; `cache` keeps a proxy from inventing one for a GET.
    cache: "no-store",
  });
}

/**
 * Make one API call and return the parsed JSON body (or `undefined` for a 204 / an empty body).
 *
 * Rejects with `ApiError` for a documented failure, an `AbortError` when cancelled, and the browser's `TypeError` when
 * the server could not be reached. A `csrf_failed` is retried once with a freshly minted cookie.
 */
export async function apiFetch<T = unknown>(path: string, init: ApiRequest = {}): Promise<T> {
  const method = init.method ?? "GET";
  if (MUTATING.has(method) && !csrfToken()) await bootstrapCsrf();

  let response = await attempt(path, init, csrfToken());

  if (response.status === 403) {
    // Either the token is stale (the cookie expired, or this tab predates a sign-in) or the call came from another
    // origin. Re-bootstrapping fixes the first case and is harmless for the second; the retry then reports it.
    const failure = await toApiError(response.clone());
    if (failure.code === CSRF_FAILED) {
      await bootstrapCsrf(true);
      response = await attempt(path, init, csrfToken());
    } else {
      throw failure;
    }
  }

  if (!response.ok) throw await toApiError(response);
  if (response.status === 204) return undefined as T;
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("json")) {
    // A successful non-JSON answer (should not happen for this API; the CSV export is built in the browser).
    return undefined as T;
  }
  return (await response.json()) as T;
}

/** `apiFetch` for calls whose body nobody needs (logout, delete, verify). */
export const apiPost = <T = unknown>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> =>
  apiFetch<T>(path, { method: "POST", body: body ?? {}, signal });

/** Build a query string, leaving out the keys that are empty. */
export function withQuery(path: string, query: Record<string, string | number | boolean | null | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `${path}?${text}` : path;
}

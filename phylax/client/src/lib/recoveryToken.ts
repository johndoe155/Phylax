/**
 * Token helpers for the recovery page (pages/Recovery.tsx). Pure, so the page and the tests share them.
 *
 * People arrive with a token three ways: the page's own address (`/reset-password?token=...`), a pasted full link, or a
 * bare token. `parseToken` accepts all of them, including links that were wrapped across lines by an email client, that
 * sit inside quotes or angle brackets, that carry the token in the #fragment, or that are wrapped in another link
 * (click-tracking redirects put the real link in a parameter).
 */

export interface ParsedToken {
  token: string;
  /** True when the token was pulled out of a link, so the page can say so. */
  fromLink: boolean;
}

const TOKEN_KEYS = ["token", "t", "code"] as const;
const PATH_MARKERS = new Set(["redeem-link", "redeem", "token", "link", "magic"]);
const MAX_DEPTH = 3;
const MIN_LENGTH = 6;
const MAX_LENGTH = 2048;

const WRAPPERS = /^[<>()[\]{}"'\u201c\u201d\u2018\u2019]+|[<>()[\]{}"'\u201c\u201d\u2018\u2019]+$/g;

function safeDecode(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

/** Whitespace is never part of a token, but email clients wrap long links onto several lines. */
function clean(raw: string): string {
  return raw.replace(/\s+/g, "").replace(WRAPPERS, "").replace(/[.,;:!?]+$/, "");
}

function fromParams(params: URLSearchParams, depth: number): string | null {
  for (const key of TOKEN_KEYS) {
    const value = params.get(key);
    if (value) return value;
  }
  // A link wrapped in another link: look inside any parameter whose value is itself a link.
  if (depth < MAX_DEPTH) {
    for (const value of params.values()) {
      if (/^(?:https?:)?\/\/|^\//i.test(value)) {
        const inner = fromLink(value, depth + 1);
        if (inner) return inner;
      }
    }
  }
  return null;
}

function fromLink(text: string, depth: number): string | null {
  let url: URL;
  try {
    const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : text.startsWith("//") ? `https:${text}` : /^[^/?#=]+\.[a-z]{2,}(?:[/?#]|$)/i.test(text) ? `https://${text}` : text;
    url = new URL(absolute, "https://phylax.invalid");
  } catch {
    return null;
  }
  const found = fromParams(url.searchParams, depth);
  if (found) return found;
  const hash = url.hash.replace(/^#\/?/, "");
  if (hash) {
    const query = hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : hash;
    const inHash = fromParams(new URLSearchParams(query), depth);
    if (inHash) return inHash;
  }
  // Path style: /redeem-link/<token>
  const segments = url.pathname.split("/").filter(Boolean).map(safeDecode);
  for (let i = 0; i < segments.length - 1; i++) {
    if (PATH_MARKERS.has(segments[i].toLowerCase())) return segments[i + 1];
  }
  return null;
}

export function parseToken(input: string): ParsedToken {
  const text = clean(input);
  if (!text) return { token: "", fromLink: false };

  const looksLikeLink = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(text) || /^\/[^/]/.test(text) || /^[^/?#=]+\.[a-z]{2,}[/?#]/i.test(text) || /[?&#]/.test(text);
  if (looksLikeLink) {
    const found = fromLink(text, 0);
    if (found) return { token: clean(found), fromLink: true };
  }
  // "token=abc" with no link around it.
  const pair = new RegExp(`^(?:${TOKEN_KEYS.join("|")})=([^&#]+)`, "i").exec(text);
  if (pair) return { token: clean(safeDecode(pair[1])), fromLink: true };

  return { token: text.includes("%") ? safeDecode(text) : text, fromLink: false };
}

/** A shape check only. The server decides whether the token is real; this just catches pasted prose. */
export function isPlausibleToken(token: string): boolean {
  return token.length >= MIN_LENGTH && token.length <= MAX_LENGTH && /^[\w.~+/=:%-]+$/.test(token);
}

/** The `token` in the page's own address, from the query string or the #fragment. Empty when there is none. */
export function tokenFromLocation(search: string, hash = ""): string {
  const query = new URLSearchParams(search).get("token");
  if (query) return query.trim();
  const inHash = new URLSearchParams(hash.replace(/^#\/?/, "")).get("token");
  return inHash ? inHash.trim() : "";
}

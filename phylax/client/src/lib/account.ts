/**
 * The account page's types, constants and pure helpers (pages/Account.tsx and components/account/*).
 *
 * Nothing here touches storage, the network or the clock's side effects, so it does not change when the demo backend is
 * swapped for a real one. Its tests are in account.test.ts. The calls that talk to the backend live in
 * accountApi.real.ts and reach the components through accountApi.ts, the single seam to repoint.
 */
import type { Provider } from "./auth";
import { POLICY_VERSION } from "./legal";

// ---- Types -------------------------------------------------------------------------------------------------------------

export type ChannelKey = "email" | "text";

/** What the operator publishes for everyone: which channels are switched on, the current policy version, the Turnstile site key. */
export interface AccountMeta {
  policyVersion: string;
  channels: Record<ChannelKey, boolean>;
  /** Present when the server wants a Cloudflare Turnstile challenge before it will send a phone code. */
  turnstileSiteKey: string | null;
}

export interface NotificationSettings {
  /** IANA name, e.g. "Africa/Lagos". */
  timezone: string;
  /** Minutes before a shift that a reminder goes out, 0 to 10080 (one week). */
  leadMinutes: number;
  emailAlerts: boolean;
  textAlerts: boolean;
}

export type PasskeyDeviceType = "synced" | "device-bound";

export interface PasskeyInfo {
  id: string;
  name: string;
  deviceType: PasskeyDeviceType;
  createdAt: string;
}

export interface AccountProfile {
  id: string;
  displayName: string;
  email: { address: string | null; verified: boolean };
  /** `pending` is a number a code was sent to and that is not verified yet. */
  phone: { number: string | null; verified: boolean; pending: string | null };
  /** True when a password credential exists. */
  hasPassword: boolean;
  providers: Provider[];
  passkeys: PasskeyInfo[];
  consent: { version: string | null; acceptedAt: string | null };
  settings: NotificationSettings;
  /** ISO time the "elevated" window ends, or null when the person has not re-authenticated recently. */
  reauthUntil: string | null;
}

export interface SessionInfo {
  id: string;
  current: boolean;
  userAgent: string;
  lastSeenAt: string;
}

export interface SecurityEvent {
  id: string;
  summary: string;
  at: string;
}

export type AlertStatus = "accepted" | "failed" | "skipped";

export interface AlertRecord {
  id: string;
  channel: ChannelKey;
  subject: string;
  status: AlertStatus;
  at: string;
}

export interface History {
  security: SecurityEvent[];
  alerts: AlertRecord[];
}

export type AccountErrorCode = "reauth-required" | "invalid" | "rate-limited" | "last-method" | "signed-out" | "unknown";

export class AccountError extends Error {
  code: AccountErrorCode;
  /** Pins the message under one input instead of showing it as a toast. */
  field?: string;
  constructor(message: string, code: AccountErrorCode = "unknown", field?: string) {
    super(message);
    this.name = "AccountError";
    this.code = code;
    this.field = field;
  }
}

// ---- Constants ---------------------------------------------------------------------------------------------------------

/** How long a successful re-authentication unlocks the sensitive actions. Keep in step with the server. */
export const REAUTH_MINUTES = 10;
export const LEAD_MIN = 0;
export const LEAD_MAX = 10080;
export const PASSWORD_MIN = 8;
export const PASSKEY_NAME_MAX = 40;
export const PHONE_CODE_LENGTH = 6;
export const HISTORY_LIMIT = 50;
export const EXPORT_FILENAME = "phylax-data.json";
export const OAUTH_START = (provider: Provider) => `/api/auth/oauth/${provider}/start?redirect=/account`;
/**
 * Whether the OAuth start endpoint will work on this deployment.
 *
 * It starts false and is driven at runtime from GET /auth/providers (see lib/accountApi.real.ts `getAccountMeta`): the
 * server only answers /auth/oauth/:provider/start when that provider's client id AND secret are configured, and answers
 * 503 otherwise. It is deliberately a mutable binding rather than a constant, so the account page's "Link Google" /
 * "Link Apple" buttons follow the real deployment without a rebuild and without the components knowing where the answer
 * came from — ES module live bindings mean `OAUTH_ENABLED` read inside a click handler always sees the latest value.
 */
export let OAUTH_ENABLED = false;

/** Called by the adapter once GET /auth/providers has answered. Not part of the page's vocabulary. */
export function setOAuthEnabled(enabled: boolean): void {
  OAUTH_ENABLED = enabled;
}

/** "Sign in again with another method": the sign-in page, which brings the person back here afterwards. */
export const SIGN_IN_AGAIN_URL = "/login?next=/account";

export const DEFAULT_META: AccountMeta = { policyVersion: POLICY_VERSION, channels: { email: true, text: true }, turnstileSiteKey: null };

// ---- Pure helpers (tested in account.test.ts) --------------------------------------------------------------------------

/** Strips the spaces, dashes, dots and brackets people type into a phone number. A leading + is kept. */
export function normalizePhone(raw: string): string {
  return raw.trim().replace(/[\s().-]/g, "");
}

/** E.164: a plus, a non-zero country digit, 7 to 15 digits in all. */
export function isE164(value: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(value);
}

/** The whole minutes in `value`, or null when it is not a whole number in the allowed range. */
export function parseLeadMinutes(value: string): number | null {
  const text = value.trim();
  if (!/^\d+$/.test(text)) return null;
  const minutes = Number(text);
  return minutes >= LEAD_MIN && minutes <= LEAD_MAX ? minutes : null;
}

/** "0" -> "At the start of the shift"; "90" -> "1 h 30 min before"; "1500" -> "1 d 1 h before". */
export function describeLead(minutes: number): string {
  if (minutes <= 0) return "At the start of the shift";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  const parts = [days ? `${days} d` : "", hours ? `${hours} h` : "", mins ? `${mins} min` : ""].filter(Boolean);
  return `${parts.join(" ")} before`;
}

/** Milliseconds as m:ss, never negative. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Milliseconds of re-authentication left, 0 when there is none. */
export function reauthRemaining(reauthUntil: string | null, now: number = Date.now()): number {
  if (!reauthUntil) return 0;
  const end = Date.parse(reauthUntil);
  return Number.isFinite(end) ? Math.max(0, end - now) : 0;
}

/**
 * How many independent ways of signing in the account has: a password (which needs an email to go with it), each linked
 * provider, each passkey, and a verified email (which can always receive a sign-in link). The page and the demo both
 * refuse to remove the last one, so nobody locks themselves out.
 */
export function signInMethodCount(profile: Pick<AccountProfile, "email" | "hasPassword" | "providers" | "passkeys">): number {
  return (
    (profile.hasPassword && profile.email.address ? 1 : 0) +
    (profile.email.verified ? 1 : 0) +
    profile.providers.length +
    profile.passkeys.length
  );
}

/** "Chrome on macOS" from a user-agent string; falls back to a trimmed copy of the string when nothing is recognised. */
export function describeUserAgent(userAgent: string): string {
  const ua = userAgent.trim();
  if (!ua) return "Unknown device";
  const browser =
    /\bEdg(e|A|iOS)?\//.test(ua) ? "Edge"
    : /\b(OPR|Opera)\//.test(ua) ? "Opera"
    : /\b(Firefox|FxiOS)\//.test(ua) ? "Firefox"
    : /\b(Chrome|CriOS|Chromium)\//.test(ua) ? "Chrome"
    : /\bSafari\//.test(ua) && /\bVersion\//.test(ua) ? "Safari"
    : "";
  const os =
    /\b(iPhone|iPod)\b/.test(ua) ? "iOS"
    : /\biPad\b/.test(ua) ? "iPadOS"
    : /\bAndroid\b/.test(ua) ? "Android"
    : /\bCrOS\b/.test(ua) ? "ChromeOS"
    : /\bWindows\b/.test(ua) ? "Windows"
    : /\bMac OS X\b|\bMacintosh\b/.test(ua) ? "macOS"
    : /\bLinux\b|\bX11\b/.test(ua) ? "Linux"
    : "";
  if (browser && os) return `${browser} on ${os}`;
  if (browser || os) return browser || os;
  return ua.length > 64 ? `${ua.slice(0, 61)}...` : ua;
}

export function passkeyTypeLabel(type: PasskeyDeviceType): string {
  return type === "synced" ? "Synced passkey" : "This device only";
}

/** "12 Oct 2026, 14:05". Invalid input reads as an em dash, never as "Invalid Date". */
export function formatWhen(iso: string, timeZone?: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "—";
  try {
    return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", ...(timeZone ? { timeZone } : {}) }).format(time);
  } catch {
    return new Date(time).toLocaleString();
  }
}

export function formatDay(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "—";
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" }).format(time);
}

/** "just now", "12 min ago", "3 h ago", "2 d ago", then the date. */
export function formatAgo(iso: string, now: number = Date.now()): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "—";
  const seconds = Math.round((now - time) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days} d ago`;
  return formatDay(iso);
}

/**
 * The operator details the legal pages show (pages/Legal.tsx), read from GET /api/legal.
 * Pure and framework-free, so the reading rules can be tested without a browser.
 *
 * FAIL CLOSED. Anything that is not a clear `true` approval flag counts as "not approved", so a missing endpoint, a
 * network error or an HTML fallback page (the SPA rewrite answers unknown /api paths with index.html) all leave the
 * pre-launch banner up. A missing field is `null`, which the page shows as "Not configured".
 *
 * The reader accepts a few spellings of each field so the endpoint can use whichever the operator's backend already has.
 */
export const LEGAL_API = "/api/legal";
export const NOT_CONFIGURED = "Not configured";

export type LegalConfig = {
  approved: boolean;
  operator: string | null;
  contact: string | null;
  jurisdiction: string | null;
};

export const UNCONFIGURED: LegalConfig = { approved: false, operator: null, contact: null, jurisdiction: null };

const APPROVAL_KEYS = ["isApproved", "approved", "operatorApproved"];
const OPERATOR_KEYS = ["operatorName", "operator", "operator_name"];
const CONTACT_KEYS = ["contactInformation", "contact", "contactEmail", "contact_email"];
const JURISDICTION_KEYS = ["jurisdiction", "legalJurisdiction", "legal_jurisdiction"];

/** The first of `keys` that holds a non-blank string, trimmed. */
function text(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export function parseLegalConfig(raw: unknown): LegalConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return UNCONFIGURED;
  const source = raw as Record<string, unknown>;
  const flag = APPROVAL_KEYS.map((key) => source[key]).find((value) => typeof value === "boolean");
  return {
    approved: flag === true,
    operator: text(source, OPERATOR_KEYS),
    contact: text(source, CONTACT_KEYS),
    jurisdiction: text(source, JURISDICTION_KEYS),
  };
}

/**
 * Where a contact value can be reached: an email becomes mailto:, a web address stays itself, anything else (a postal
 * address, a phone number) has no link. Other schemes (javascript:, data:) are never linked.
 */
export function contactHref(contact: string | null): string | null {
  if (!contact) return null;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(contact)) return `mailto:${contact}`;
  return /^https?:\/\/\S+$/i.test(contact) ? contact : null;
}

/**
 * Loads the configuration. Resolves to UNCONFIGURED on any failure. Rejects only when `signal` aborts, so the caller
 * can tell "the page went away" from "the endpoint is not there".
 */
export async function fetchLegalConfig(signal?: AbortSignal): Promise<LegalConfig> {
  try {
    const response = await fetch(LEGAL_API, { headers: { Accept: "application/json" }, cache: "no-store", signal });
    return response.ok ? parseLegalConfig(await response.json()) : UNCONFIGURED;
  } catch (error) {
    if (signal?.aborted) throw error;
    return UNCONFIGURED;
  }
}

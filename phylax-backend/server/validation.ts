import { LEGAL_VERSION } from "@shared/legal";
import type { RequestHandler } from "express";
import { z } from "zod";
import { badRequest } from "./http.js";

/**
 * Is this a timezone PostgreSQL can actually use in `AT TIME ZONE`?
 *
 * `Intl.DateTimeFormat` accepts a numeric UTC offset such as "+05:00", but PostgreSQL's `AT TIME ZONE` treats a
 * string like that as a POSIX zone specification — and POSIX signs are inverted, so "+05:00" means five hours
 * BEHIND UTC. A timezone that validates here but shifts every cutoff the wrong way in the database is worse
 * than one that is rejected: it silently produces wrong alert times, and a bad row used to throw out of the
 * scheduler scan and stall the whole cycle. This rejects the shapes that carry that hazard (numeric offsets and
 * hand-written "GMT+3"); the authoritative check is PostgreSQL's own pg_timezone_names, which the settings
 * endpoint also consults before a write is accepted.
 */
export function isValidIanaZone(value: string): boolean {
  if (!value || value.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(value)) return false;
  try {
    const formatter = new Intl.DateTimeFormat("en-US", { timeZone: value, timeZoneName: "longOffset" });
    return formatter.formatToParts(new Date()).some(p => p.type === "timeZoneName" && p.value);
  } catch {
    return false;
  }
}

// Reject wrong types before route handlers trim strings or pass values to PostgreSQL.
const schema = z.object({
  id: z.string().min(1).max(128).optional(),
  email: z.string().trim().max(254).optional(),
  password: z.string().max(1024).optional(),
  currentPassword: z.string().max(1024).optional(),
  newPassword: z.string().max(1024).optional(),
  displayName: z.string().max(160).optional(),
  facility: z.string().max(200).optional(),
  platform: z.string().max(100).optional(),
  label: z.string().max(200).optional(),
  note: z.string().max(4000).nullable().optional(),
  // Migration 018's two optional text columns. They would survive this middleware anyway (the schema is `.passthrough()`),
  // but naming them here means a 10 MB address is a 400 that points at `address` rather than a CHECK violation later.
  address: z.string().max(200).nullable().optional(),
  contact: z.string().max(200).nullable().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  start: z.number().int().min(0).max(1439).optional(),
  end: z.number().int().min(0).max(1439).optional(),
  travelMin: z.number().int().min(0).max(1440).optional(),
  cancelHrs: z.number().int().min(0).max(720).optional(),
  reminderLeadMinutes: z.number().int().min(0).max(10080).optional(),
  timezone: z.string().refine(isValidIanaZone).optional(),
  phone: z.string().regex(/^\+[1-9]\d{6,14}$/).nullable().optional(),
  smsEnabled: z.boolean().optional(),
  emailEnabled: z.boolean().optional(),
  code: z.string().regex(/^\d{6}$/).optional(),
  token: z.string().max(512).optional(),
  credentialIds: z.array(z.string().max(2048)).max(50).optional(),
  consent: z.object({ termsVersion: z.literal(LEGAL_VERSION), privacyVersion: z.literal(LEGAL_VERSION), acceptedAt: z.string().datetime({ offset: true }) }).optional(),
}).passthrough();
export const validateBody: RequestHandler = (req, _res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method) || req.path === "/auth/oauth/callback") return next();
  const result = schema.safeParse(req.body ?? {});
  if (!result.success) return next(badRequest("invalid_input", `Invalid ${result.error.issues[0]?.path.join(".") || "request"}.`));
  req.body = result.data;
  if (req.body.consent) req.body.consent.acceptedAt = new Date().toISOString();
  next();
};
export const validateId: RequestHandler = (req, _res, next) => {
  const id = req.params.id;
  if (id && !z.string().uuid().safeParse(id).success) return next(badRequest("invalid_id", "That identifier is not valid."));
  next();
};

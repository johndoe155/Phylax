/** The quick actions in a shift's detail sheet. Pure string builders, so they are tested without a browser. */
import { clockRange, shiftType, span, type Shift } from "./shifts";

const pad = (n: number) => String(n).padStart(2, "0");
/** Local clock time as an iCalendar floating date-time (no zone: a shift happens at the wall-clock time it says). */
const local = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`; };
const utc = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
/** iCalendar lines may not pass 75 octets; longer ones continue on the next line after a space. */
const fold = (line: string) => {
  const out: string[] = [];
  let rest = line;
  while (rest.length > 74) { out.push(rest.slice(0, 74)); rest = " " + rest.slice(74); }
  out.push(rest);
  return out.join("\r\n");
};

/** A one-event calendar file for the shift, with a reminder an hour before it starts. */
export function icsFor(s: Shift, now = Date.now()): string {
  const [a, b] = span(s);
  const notes = [`${s.platform} · ${shiftType(s)} · ${clockRange(s)}`, s.contact && `Contact: ${s.contact}`, s.notes].filter(Boolean).join("\n");
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Phylax//Shifts//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${s.id}@phylax`, `DTSTAMP:${utc(now)}`, `DTSTART:${local(a)}`, `DTEND:${local(b)}`,
    `SUMMARY:${esc(`${s.facility} (${shiftType(s)})`)}`,
    ...(s.address ? [`LOCATION:${esc(s.address)}`] : []),
    `DESCRIPTION:${esc(notes)}`,
    "BEGIN:VALARM", "TRIGGER:-PT60M", "ACTION:DISPLAY", `DESCRIPTION:${esc(`${s.facility} starts in an hour`)}`, "END:VALARM",
    "END:VEVENT", "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}
export const icsName = (s: Shift) => `${s.facility.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "shift"}-${s.date}.ics`;

/** Directions to the shift: its address when there is one, otherwise the facility's name. */
export function mapsUrl(s: Pick<Shift, "address" | "facility">, apple = false): string {
  const q = encodeURIComponent((s.address?.trim() || s.facility).trim());
  return apple ? `https://maps.apple.com/?daddr=${q}` : `https://www.google.com/maps/dir/?api=1&destination=${q}`;
}

/** A message to send to a coworker or a group chat asking someone to cover the shift. */
export function swapText(s: Shift): string {
  const [a] = span(s);
  const day = new Date(a).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
  return `Looking for someone to cover my ${shiftType(s).toLowerCase()} shift at ${s.facility} (${s.platform}) on ${day}, ${clockRange(s)}. Anyone free?`;
}

/** A tel: link for the first phone number found in a free-text contact ("Dana, charge nurse 555-0142"), or null. */
export function telHref(contact?: string): string | null {
  const hit = contact?.match(/\+?\d[\d\s().-]{5,}\d/);
  if (!hit) return null;
  const digits = hit[0].replace(/[^\d+]/g, "");
  const n = digits.replace(/\D/g, "").length;
  return n >= 7 && n <= 15 ? `tel:${digits}` : null;
}

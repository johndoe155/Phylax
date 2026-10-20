import { useCallback, useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { cancelNote, lengthOf, shiftType, span, type Issue, type Rules, type Shift } from "@/lib/shifts";
import { icsFor, icsName, mapsUrl, swapText, telHref } from "@/lib/shiftActions";
import { fmtEta, fmtHours, fmtStamp, kindOfShift } from "@/lib/weekBoard";
import { Calendar, Close, KindGlyph, Navigate, Phone, Swap, Warning } from "./icons";

// Keep in step with week.css (.wk-sheet): the slide-out before the sheet unmounts.
const EXIT_MS = 280;
const FOCUSABLE = 'a[href], button:not([disabled]), textarea, input, [tabindex]:not([tabindex="-1"])';

export type SheetPatch = Partial<Pick<Shift, "notes" | "contact" | "address">>;

const isApple = () => typeof navigator !== "undefined" && (/iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));
const coarse = () => window.matchMedia("(pointer: coarse)").matches;
const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Everything about one shift, and what to do with it. A bottom sheet on a phone (drag the handle down to dismiss), a side
 * drawer on a wide screen. Notes, contact and address are written straight back as they are typed, so closing the sheet
 * never loses anything. Quick actions: add to calendar (a .ics file, or the share sheet on a phone), navigate, offer a swap
 * (a ready-made message), and call when the contact holds a phone number.
 *
 * It is a dialog: focus moves into it and stays there, Escape or the backdrop closes it, the page behind does not scroll,
 * and focus returns to the bar it was opened from.
 */
export function ShiftSheet({ shift, issues, rules, now, opener, onUpdate, onClose }: {
  shift: Shift; issues: Issue[]; rules: Rules; now: number; opener: HTMLElement | null;
  onUpdate: (id: string, patch: SheetPatch) => void; onClose: () => void;
}) {
  const sheet = useRef<HTMLDivElement>(null);
  const timers = useRef<number[]>([]);
  const drag = useRef<{ id: number; y: number; t: number; dy: number } | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [say, setSay] = useState("");
  const titleId = useId();
  const closeRef = useRef<() => void>(() => {});

  const close = useCallback(() => {
    if (sheet.current?.dataset.leaving) return;
    setLeaving(true);
    timers.current.push(window.setTimeout(onClose, reduced() ? 0 : EXIT_MS));
  }, [onClose]);
  closeRef.current = close;

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    sheet.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); closeRef.current(); return; }
      if (e.key !== "Tab" || !sheet.current) return;
      const items = [...sheet.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
      if (!items.length) { e.preventDefault(); return; }
      const first = items[0], last = items[items.length - 1], at = document.activeElement;
      if (e.shiftKey && (at === first || at === sheet.current)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    const pending = timers.current;
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
      pending.forEach(clearTimeout);
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [opener]);

  useEffect(() => { if (!say) return; const i = window.setTimeout(() => setSay(""), 6000); return () => clearTimeout(i); }, [say]);

  // Drag the handle (or the title strip) down to dismiss, on the phone layout only.
  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!window.matchMedia("(max-width: 760px)").matches || (e.pointerType === "mouse" && e.button !== 0)) return;
    drag.current = { id: e.pointerId, y: e.clientY, t: performance.now(), dy: 0 };
    e.currentTarget.setPointerCapture(e.pointerId);
    if (sheet.current) sheet.current.dataset.drag = "1";
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = drag.current;
    if (!g || e.pointerId !== g.id) return;
    g.dy = Math.max(0, e.clientY - g.y);
    sheet.current?.style.setProperty("--dy", `${g.dy}px`);
  };
  const up = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = drag.current;
    if (!g || e.pointerId !== g.id) return;
    drag.current = null;
    if (sheet.current) delete sheet.current.dataset.drag;
    const speed = g.dy / Math.max(1, performance.now() - g.t);
    if (g.dy > 110 || (g.dy > 40 && speed > 0.6)) close();
    else sheet.current?.style.removeProperty("--dy");
  };

  const [a, b] = span(shift);
  const kind = kindOfShift(shift);
  const state = b <= now ? "done" : a <= now ? "live" : "upcoming";
  const status = state === "live" ? `On shift · ${fmtEta(b - now)} left` : state === "done" ? "Finished" : `Starts in ${fmtEta(a - now)}`;
  const tel = telHref(shift.contact);

  const addToCalendar = async () => {
    const text = icsFor(shift);
    const name = icsName(shift);
    try {
      const file = new File([text], name, { type: "text/calendar" });
      if (coarse() && navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], title: shift.facility }); setSay("Shared to your calendar app."); return; }
    } catch (err) { if ((err as Error).name === "AbortError") return; }
    const url = URL.createObjectURL(new Blob([text], { type: "text/calendar;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url; link.download = name;
    document.body.appendChild(link); link.click(); link.remove();
    timers.current.push(window.setTimeout(() => URL.revokeObjectURL(url), 4000));
    setSay("Calendar file downloaded. Open it to add the shift.");
  };
  const offerSwap = async () => {
    const text = swapText(shift);
    try {
      if (coarse() && navigator.share) { await navigator.share({ text }); setSay("Swap request ready to send."); return; }
    } catch (err) { if ((err as Error).name === "AbortError") return; }
    try { await navigator.clipboard.writeText(text); setSay("Swap request copied. Paste it to your group or coworker."); }
    catch { setSay(`Copy this message: ${text}`); }
  };

  return createPortal(
    <div className="wk-sheet-root">
      <div className="wk-scrim" data-leaving={leaving || undefined} onClick={close} aria-hidden="true" />
      <div ref={sheet} className="wk-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} data-leaving={leaving || undefined}>
        <div className="wk-sheet-grab" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
          <span className="wk-handle" aria-hidden="true" />
          <div className="wk-sheet-top">
            <span className="wk-kind"><KindGlyph kind={kind} size={15} />{shiftType(shift)} · {fmtHours(lengthOf(shift))}</span>
            <button type="button" className="wk-x" onClick={close} onPointerDown={(e) => e.stopPropagation()} aria-label="Close shift details"><Close size={18} /></button>
          </div>
        </div>

        <div className="wk-sheet-body">
          <h2 id={titleId} className="wk-sheet-title">{shift.facility}</h2>
          <p className="wk-status" data-state={state}><span className="signal-dot" aria-hidden="true" />{status}</p>

          {issues.map((i) => (
            <div className="wk-alert" data-kind={i.kind} key={i.other.id} role="note">
              <Warning size={18} />
              <p>
                {i.kind === "overlap"
                  ? `Overlaps ${i.other.platform} · ${i.other.facility} by ${fmtHours(i.minutes)}. ${cancelNote(shift, rules, now)}`
                  : `Only ${fmtHours(i.minutes)} before ${i.other.facility}, under your ${rules.travelMin}-minute travel buffer.`}
              </p>
            </div>
          ))}

          <div className="v-rows wk-rows-detail">
            <div><span>Platform</span><span>{shift.platform}</span></div>
            <div><span>Starts</span><span>{fmtStamp(a)}</span></div>
            <div><span>Ends</span><span>{fmtStamp(b)}</span></div>
            <div><span>Length</span><span>{fmtHours(lengthOf(shift))}</span></div>
          </div>

          <div className="wk-fields">
            <label className="wk-field">
              <span>Location</span>
              <input type="text" value={shift.address ?? ""} maxLength={200} autoComplete="off" placeholder="Add an address for directions" onChange={(e) => onUpdate(shift.id, { address: e.target.value })} />
            </label>
            <label className="wk-field">
              <span>Contact</span>
              <input type="text" value={shift.contact ?? ""} maxLength={120} autoComplete="off" placeholder="Name or phone, e.g. Dana 555-0142" onChange={(e) => onUpdate(shift.id, { contact: e.target.value })} />
            </label>
            <label className="wk-field">
              <span>Notes</span>
              <textarea value={shift.notes ?? ""} maxLength={600} rows={3} placeholder="Entry code, unit, who to ask for" onChange={(e) => onUpdate(shift.id, { notes: e.target.value })} />
            </label>
          </div>
        </div>

        <div className="wk-sheet-foot">
          <p className="wk-say" role="status" aria-live="polite">{say}</p>
          <div className="wk-acts">
            <button type="button" onClick={addToCalendar}><Calendar size={17} />Add to calendar</button>
            <a href={mapsUrl(shift, isApple())} target="_blank" rel="noopener noreferrer"><Navigate size={17} />Navigate</a>
            <button type="button" onClick={offerSwap}><Swap size={17} />Offer swap</button>
            {tel && <a href={tel}><Phone size={17} />Call</a>}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

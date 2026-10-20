import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { shiftType, type Issue, type Rules, type Shift } from "@/lib/shifts";
import {
  KINDS, KIND_FILL, clashesFor, clockNow, describeShift, fmtEta, fmtHours, fmtMoment, fmtStamp, kindOfShift, labelParts, laneCount, nowPosition, nowStatus, pageOf, pageTitle,
  piecesFor, placeLabels, rangeLabel, riskOf, summarize, totalsFor, windowDays, type Kind, type Pair, type Piece, type Placed, type Risk,
} from "@/lib/weekBoard";
import { span, lengthOf } from "@/lib/shifts";
import { ArrowDown, CheckCircle, ChevronLeft, ChevronRight, Info, KindGlyph, Plus, Warning } from "./icons";
import { ShiftSheet, type SheetPatch } from "./ShiftSheet";
import { CountUp } from "@/components/CountUp";

const MAX_PAGE = 52; // a year either way
const MIN_BAR = 8;   // px: a very short shift stays visible and tappable
// Label sizes, keep in step with week.css (.wk-name, .wk-meta, .wk-bar padding).
const PAD = 10, GLYPH = 14, GAP = 6, NOTCH = 6, GLYPH_AT = 30, SAFETY = 8;

const pct = (f: number) => `${(f * 100).toFixed(3)}%`;
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const dayWords = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** The width of the plot area (a track) in px, kept current. Labels are placed against it. */
function useWidth(ref: RefObject<HTMLElement | null>) {
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setW(Math.round(el.getBoundingClientRect().width));
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

/** Text widths in the board's own fonts (read from the page's CSS variables), measured on a canvas and re-measured when web fonts finish loading. */
function useMeasure() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const fonts = document.fonts;
    if (!fonts) return;
    let live = true;
    const bump = () => live && setTick((n) => n + 1);
    fonts.ready.then(bump);
    fonts.addEventListener?.("loadingdone", bump);
    return () => { live = false; fonts.removeEventListener?.("loadingdone", bump); };
  }, []);
  return useMemo(() => {
    void tick;
    const ctx = document.createElement("canvas").getContext("2d");
    const cs = getComputedStyle(document.documentElement);
    const body = cs.getPropertyValue("--font-body").trim() || "sans-serif";
    const mono = cs.getPropertyValue("--font-mono").trim() || "monospace";
    const cache = new Map<string, number>();
    const width = (text: string, font: string, spacing: number) => {
      const key = `${font}|${text}`;
      let v = cache.get(key);
      if (v === undefined) {
        if (ctx) { ctx.font = font; v = ctx.measureText(text).width + text.length * spacing; } else v = text.length * 7;
        cache.set(key, v);
      }
      return v;
    };
    return { name: (s: string) => width(s, `700 12px ${body}`, 0), meta: (s: string) => width(s, `500 11px ${mono}`, 0.22) };
  }, [tick]);
}

type Tip = { shift: Shift; state: Piece["state"]; rect: DOMRect; touch: boolean };

/** One bar, with its label inside it or beside it. Hover or keyboard focus shows a tooltip, a long press does too on touch, a tap opens the sheet. */
function PieceView({ p, place, risk, issues, trackW, now, onOpen, onTip }: {
  p: Piece; place: Placed; risk: Risk; issues: Issue[]; trackW: number; now: number;
  onOpen: (id: string, el: HTMLElement) => void; onTip: (t: Tip | null) => void;
}) {
  const s = p.shift;
  const kind = kindOfShift(s);
  const el = useRef<HTMLButtonElement>(null);
  const hover = useRef<number | undefined>(undefined);
  const press = useRef<number | undefined>(undefined);
  const long = useRef(false);
  const start = useRef({ x: 0, y: 0, type: "mouse" });
  const parts = labelParts(s, p);
  const outside = place.mode !== "inside";
  const barPx = p.width * trackW;
  const showGlyph = barPx >= GLYPH_AT;

  const show = (touch: boolean) => { const rect = el.current?.getBoundingClientRect(); if (rect) onTip({ shift: s, state: p.state, rect, touch }); };
  const cancelPress = () => { window.clearTimeout(press.current); press.current = undefined; };
  useEffect(() => () => { window.clearTimeout(hover.current); window.clearTimeout(press.current); }, []);

  const down = (e: ReactPointerEvent<HTMLButtonElement>) => {
    start.current = { x: e.clientX, y: e.clientY, type: e.pointerType };
    if (e.pointerType === "mouse") return;
    long.current = false;
    cancelPress();
    press.current = window.setTimeout(() => { long.current = true; press.current = undefined; navigator.vibrate?.(8); show(true); }, 420);
  };
  const move = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (press.current !== undefined && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 10) cancelPress();
  };

  return (
    <button
      ref={el}
      type="button"
      className="wk-piece"
      data-shift={s.id}
      data-fill={KIND_FILL[kind]}
      data-kind={kind}
      data-state={p.state}
      data-risk={risk ?? undefined}
      data-from={p.startsBefore || undefined}
      data-to={p.endsAfter || undefined}
      data-label={place.mode}
      style={{ left: pct(p.left), width: pct(p.width), "--lane": p.lane, "--el": pct(p.elapsed) } as CSSProperties}
      aria-label={describeShift(s, p, issues, now)}
      aria-haspopup="dialog"
      onClick={(e) => {
        if (long.current) { long.current = false; e.preventDefault(); return; }
        onOpen(s.id, e.currentTarget);
      }}
      onPointerEnter={(e) => { if (e.pointerType === "mouse") { window.clearTimeout(hover.current); hover.current = window.setTimeout(() => show(false), 160); } }}
      onPointerLeave={(e) => { window.clearTimeout(hover.current); if (e.pointerType === "mouse") onTip(null); cancelPress(); }}
      onFocus={(e) => { if (e.currentTarget.matches(":focus-visible")) show(false); }}
      onBlur={() => onTip(null)}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={cancelPress}
      onPointerCancel={cancelPress}
      onContextMenu={(e) => { if (start.current.type !== "mouse") e.preventDefault(); }}
    >
      <span className="wk-bar" aria-hidden="true">
        {showGlyph && <span className="wk-glyph"><KindGlyph kind={kind} size={GLYPH} /></span>}
        {!outside && (
          <>
            <span className="wk-name">{parts.name}</span>
            <span className="wk-meta">{parts.from && <b className="wk-tag">{parts.from}</b>}{parts.time}{parts.to && <b className="wk-tag">{parts.to}</b>}</span>
          </>
        )}
      </span>
      {risk && <span className="wk-badge" aria-hidden="true">{risk === "overlap" ? "!" : "·"}</span>}
      {outside && (
        <span className="wk-out" data-side={place.mode} style={place.max ? { maxWidth: place.max } : undefined} aria-hidden="true">
          <span className="wk-name">{!showGlyph && <span className="wk-glyph"><KindGlyph kind={kind} size={GLYPH} /></span>}<span>{parts.name}</span></span>
          <span className="wk-meta">{parts.from && <b className="wk-tag">{parts.from}</b>}{parts.time}{parts.to && <b className="wk-tag">{parts.to}</b>}</span>
        </span>
      )}
    </button>
  );
}

/** The hover / long-press card for a bar: the same facts as its accessible name, in the open. Placed above the bar, or below when there is no room. */
function TipCard({ tip, issues, now }: { tip: Tip; issues: Issue[]; now: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth, h = el.offsetHeight, vw = document.documentElement.clientWidth, vh = window.innerHeight;
    const x = Math.min(Math.max(8, tip.rect.left + tip.rect.width / 2 - w / 2), Math.max(8, vw - w - 8));
    const above = tip.rect.top - h - 10 >= 8;
    setPos({ x, y: above ? tip.rect.top - h - 10 : Math.min(tip.rect.bottom + 10, vh - h - 8) });
  }, [tip]);
  const s = tip.shift, [a, b] = span(s);
  return createPortal(
    <div ref={ref} className="wk-tip" style={{ left: pos?.x ?? 0, top: pos?.y ?? 0, visibility: pos ? "visible" : "hidden" }} aria-hidden="true">
      <strong>{s.facility}</strong>
      <span>{s.platform} · {shiftType(s)}</span>
      <span>{fmtStamp(a)} → {fmtStamp(b)}</span>
      <span>{fmtHours(lengthOf(s))} · {tip.state === "live" ? `in progress, ${fmtEta(b - now)} left` : tip.state === "done" ? "finished" : `starts in ${fmtEta(a - now)}`}</span>
      {issues.map((i) => <em key={i.other.id}>{i.kind === "overlap" ? `Overlaps ${i.other.facility} by ${fmtHours(i.minutes)}` : `Only ${fmtHours(i.minutes)} before ${i.other.facility}`}</em>)}
    </div>,
    document.body,
  );
}

/**
 * The seven-day board: one row per day on a 24-hour axis, a bar per shift.
 *
 * - An overnight shift is one block across midnight: its bar runs off the edge of the first day and picks up on the next, with a torn edge and a
 *   "← SAT" / "SUN →" tag on the side that continues.
 * - A label that does not fit inside its bar goes beside it (lib/weekBoard.ts `placeLabels`); nothing is ever cut off mid-time.
 * - Shifts that overlap in time get their own lanes, the overlap is hatched, and both bars carry a warning badge. The status chip counts them and jumps to the first.
 * - A "now" line crosses today's row, and the header says what is in progress or what is next and how long until it starts.
 * - Kind of shift reads from fill (solid, outline or textured) and glyph, never from colour alone.
 */
export function ShiftWeek({ shifts, issues, pairs, rules, now, onAddDay, onUpdate }: {
  shifts: Shift[]; issues: Record<string, Issue[]>; pairs: Pair[]; rules: Rules; now: number;
  onAddDay: (date: string) => void; onUpdate: (id: string, patch: SheetPatch) => void;
}) {
  const [page, setPage] = useState(0);
  const dir = useRef<"next" | "prev" | "none">("none");
  const [open, setOpen] = useState<{ id: string; opener: HTMLElement } | null>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const [info, setInfo] = useState(false);
  const [jump, setJump] = useState<{ date: string } | null>(null);
  const [flash, setFlash] = useState("");
  const board = useRef<HTMLDivElement>(null);
  const plot = useRef<HTMLDivElement>(null);
  const trackW = useWidth(plot);
  const measure = useMeasure();
  const popId = useId();

  const model = useMemo(() => {
    const days = windowDays(now, page);
    const ranges = pairs.filter((p) => p.issue.kind === "overlap" && p.issue.overlap).map((p) => p.issue.overlap as [number, number]);
    const rows = days.map((day) => { const pieces = piecesFor(day, shifts, now); return { day, pieces, lanes: laneCount(pieces), clashes: clashesFor(day, ranges) }; });
    return { days, rows, totals: totalsFor(rows), summary: summarize(pairs, days), range: rangeLabel(days) };
  }, [now, page, shifts, pairs]);

  // Where each label goes, row by row and lane by lane, against the measured track width.
  const placed = useMemo(() => model.rows.map((row) => {
    const out: Placed[] = new Array(row.pieces.length);
    for (let lane = 0; lane < row.lanes; lane++) {
      const idx = row.pieces.map((_, i) => i).filter((i) => row.pieces[i].lane === lane);
      const boxes = idx.map((i) => {
        const p = row.pieces[i], parts = labelParts(p.shift, p);
        const nameW = measure.name(parts.name);
        const metaW = measure.meta([parts.from, parts.time, parts.to].filter(Boolean).join(" ")) + (parts.from ? SAFETY : 0) + (parts.to ? SAFETY : 0);
        const width = Math.max(MIN_BAR, p.width * trackW);
        const notch = (p.startsBefore ? NOTCH : 0) + (p.endsAfter ? NOTCH : 0);
        return {
          left: Math.min(p.left * trackW, Math.max(0, trackW - width)), width,
          inside: PAD * 2 + notch + (width >= GLYPH_AT ? GLYPH + GAP : 0) + nameW + 10 + metaW,
          outside: Math.max(nameW + (width < GLYPH_AT ? GLYPH + 5 : 0), metaW) + 4,
        };
      });
      placeLabels(trackW, boxes).forEach((r, k) => { out[idx[k]] = r; });
    }
    return out;
  }), [model, trackW, measure]);

  const status = useMemo(() => nowStatus(shifts, now), [shifts, now]);
  const kinds = useMemo(() => {
    const seen = new Set<Kind>();
    model.rows.forEach((r) => r.pieces.forEach((p) => seen.add(kindOfShift(p.shift))));
    return KINDS.filter((k) => seen.has(k));
  }, [model]);
  const hasRisk = useMemo(() => {
    const seen = { overlap: false, tight: false };
    model.rows.forEach((r) => r.pieces.forEach((p) => { const k = riskOf(issues[p.shift.id]); if (k) seen[k] = true; }));
    return seen;
  }, [model, issues]);

  const goTo = useCallback((next: number) => {
    const n = Math.max(-MAX_PAGE, Math.min(MAX_PAGE, next));
    setPage((cur) => { dir.current = n > cur ? "next" : n < cur ? "prev" : "none"; return n; });
    setTip(null);
  }, []);

  const sum = model.summary;
  const noun = sum.state === "tight" ? "tight gap" : "overlap";
  const chipText = sum.state === "ok" ? "No overlaps"
    : sum.visible > 0 ? `${sum.visible} ${noun}${sum.visible === 1 ? "" : "s"}`
      : `${sum.count} ${noun}${sum.count === 1 ? "" : "s"} · ${dayWords(sum.target?.time ?? now)}`;
  const jumpToConflict = () => {
    if (!sum.target) return;
    const d = new Date(sum.target.time);
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    goTo(pageOf(sum.target.time, now));
    setJump({ date });
  };
  // After the jump has re-rendered the right week, bring the conflicting row into view, flash it, and put focus on its bar.
  useEffect(() => {
    if (!jump) return;
    const row = board.current?.querySelector<HTMLElement>(`[data-date="${jump.date}"]`);
    if (row) {
      row.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
      row.querySelector<HTMLElement>(".wk-piece[data-risk]")?.focus({ preventScroll: true });
      setFlash(jump.date);
    }
    setJump(null);
  }, [jump]);
  useEffect(() => { if (!flash) return; const i = window.setTimeout(() => setFlash(""), 2000); return () => clearTimeout(i); }, [flash]);

  // The tooltip leaves on scroll, on any new touch or click, on Escape, and by itself after a few seconds when it came from a long press.
  useEffect(() => {
    if (!tip) return;
    const hide = () => setTip(null);
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") hide(); };
    window.addEventListener("scroll", hide, { capture: true, passive: true });
    window.addEventListener("pointerdown", hide, { capture: true });
    window.addEventListener("keydown", key);
    const auto = tip.touch ? window.setTimeout(hide, 3200) : undefined;
    return () => { window.removeEventListener("scroll", hide, true); window.removeEventListener("pointerdown", hide, true); window.removeEventListener("keydown", key); window.clearTimeout(auto); };
  }, [tip]);
  useEffect(() => {
    if (!info) return;
    const away = (e: PointerEvent) => { if (!(e.target as HTMLElement).closest?.(".wk-info")) setInfo(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setInfo(false); };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", key); };
  }, [info]);

  const sheetShift = open ? shifts.find((s) => s.id === open.id) : undefined;
  useEffect(() => { if (open && !sheetShift) setOpen(null); }, [open, sheetShift]);

  const hours = Math.floor(model.totals.minutes / 60), mins = model.totals.minutes % 60;
  const tipIssues = tip ? issues[tip.shift.id] ?? [] : [];
  const today = page === 0;

  return (
    <section className="visual wk" aria-labelledby={`${popId}-t`}>
      <header className="wk-head">
        <div className="wk-top">
          <h2 className="wk-title" id={`${popId}-t`}><span className="signal-dot" aria-hidden="true" />{pageTitle(page)}</h2>
          <div className="wk-info">
            <button type="button" className="wk-ib" aria-expanded={info} aria-controls={popId} aria-label="About this board" onClick={() => setInfo((v) => !v)}><Info size={18} /></button>
            {info && (
              <div className="wk-pop" id={popId} role="note">
                <p>Overnight shifts stay one block across midnight. A ← tag shows the day they started.</p>
                <p>Hours count only the time inside these 7 days.</p>
                <p>Overlap: two shifts at the same time. Tight: less than your {rules.travelMin}-minute travel buffer.</p>
              </div>
            )}
          </div>
        </div>

        <div className="wk-sum">
          <p className="wk-total" aria-live="polite">
            <strong><CountUp id="week-hours" value={hours} align="end" /><small>H{mins ? ` ${mins}M` : ""}</small></strong>
            <span>{model.totals.shifts} shift{model.totals.shifts === 1 ? "" : "s"} · {model.range}</span>
          </p>
          {sum.state === "ok" ? (
            <p className="wk-chip" data-state="ok" role="status"><CheckCircle size={16} />No overlaps</p>
          ) : (
            <button type="button" className="wk-chip" data-state={sum.state} onClick={jumpToConflict} aria-label={`${chipText}. Jump to the first one.`}>
              <Warning size={16} />{chipText}<span className="wk-jump">Jump<ArrowDown size={13} /></span>
            </button>
          )}
        </div>

        {today && status.kind !== "idle" && (
          <p className="wk-nowline" data-kind={status.kind}>
            <span className="wk-nowtag"><span className="signal-dot" aria-hidden="true" />Now {clockNow(now)}</span>
            {status.kind === "live"
              ? <span><b>On shift</b> · {status.shift.facility} · ends {fmtMoment(status.end)} · {fmtEta(status.endsIn)} left</span>
              : <span><b>Next</b> · {status.shift.facility} · {fmtMoment(status.start)} · in {fmtEta(status.startsIn)}</span>}
          </p>
        )}

        <div className="wk-nav" role="group" aria-label="Choose the week">
          <button type="button" onClick={() => goTo(page - 1)} disabled={page <= -MAX_PAGE} aria-label="Previous 7 days"><ChevronLeft size={18} /><span>Back</span></button>
          <button type="button" className="wk-today-btn" aria-disabled={page === 0} aria-label={page === 0 ? "Today, showing now" : "Jump to today"} data-on={page === 0 || undefined} onClick={() => page !== 0 && goTo(0)}>Today</button>
          <button type="button" onClick={() => goTo(page + 1)} disabled={page >= MAX_PAGE} aria-label="Next 7 days"><span>Forward</span><ChevronRight size={18} /></button>
        </div>
      </header>

      <div className="wk-board" ref={board}>
        <div className="wk-inner">
          <div className="wk-axis" aria-hidden="true">
            {[["12A", 0], ["6A", 25], ["12P", 50], ["6P", 75], ["12A", 100]].map(([l, at], i) => <span key={i} data-at={at} style={{ left: `${at}%` }}>{l}</span>)}
          </div>
          <div className="wk-grid" aria-hidden="true" ref={plot}>
            {[0, 25, 50, 75, 100].map((at) => <i key={at} data-at={at} data-noon={at === 50 || undefined} style={{ left: `${at}%` }} />)}
          </div>
          <ol className="wk-rows" key={page} data-dir={dir.current}>
            {model.rows.map((row, ri) => {
              const { day } = row;
              const nowAt = nowPosition(day, now);
              const clashMin = row.clashes.reduce((m, c) => Math.max(m, c.minutes), 0);
              const minutes = model.totals.perDay[ri];
              return (
                <li
                  className="wk-row"
                  key={day.date}
                  data-date={day.date}
                  data-today={day.today || undefined}
                  data-weekend={day.weekend || undefined}
                  data-past={day.past || undefined}
                  data-flash={flash === day.date || undefined}
                  aria-current={day.today ? "date" : undefined}
                >
                  <div className="wk-day">
                    <span className="wk-dname">
                      {day.today && <span className="wk-today">Today</span>}
                      <span className="wk-wd">{day.weekday}</span>
                      <span className="wk-dt">{day.label}</span>
                    </span>
                    <span className="wk-dmeta">
                      {clashMin > 0 && <span className="wk-flag"><Warning size={13} />Overlap {fmtHours(clashMin)}</span>}
                      {minutes > 0 && <span className="wk-hrs">{fmtHours(minutes)}</span>}
                    </span>
                  </div>
                  <div className="wk-track" style={{ "--lanes": row.lanes } as CSSProperties}>
                    {row.pieces.length === 0 && (
                      day.past
                        ? <div className="wk-empty" data-static><span>No shifts</span><i className="wk-dash" /></div>
                        : <button type="button" className="wk-empty" onClick={() => onAddDay(day.date)} aria-label={`No shifts on ${day.long}. Add a shift.`}><span>No shifts</span><i className="wk-dash" /><span className="wk-add"><Plus size={13} />Add shift</span></button>
                    )}
                    {row.pieces.map((p, pi) => (
                      <PieceView
                        key={p.shift.id}
                        p={p}
                        place={placed[ri][pi] ?? { mode: "inside", max: null }}
                        risk={riskOf(issues[p.shift.id])}
                        issues={issues[p.shift.id] ?? []}
                        trackW={trackW}
                        now={now}
                        onOpen={(id, opener) => { setTip(null); setOpen({ id, opener }); }}
                        onTip={setTip}
                      />
                    ))}
                    {row.clashes.map((c, k) => <i className="wk-clash" key={k} style={{ left: pct(c.left), width: pct(c.width) }} aria-hidden="true" />)}
                    {nowAt !== null && <i className="wk-now" style={{ left: pct(nowAt) }} aria-hidden="true" />}
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      </div>

      <footer className="wk-foot">
        <ul className="wk-legend" aria-label="Key">
          {kinds.map((k) => <li key={k}><i className="wk-sw" data-fill={KIND_FILL[k]}><KindGlyph kind={k} size={11} /></i>{k}</li>)}
          {hasRisk.overlap && <li><i className="wk-sw" data-risk="overlap"><Warning size={11} /></i>Overlap</li>}
          {hasRisk.tight && <li><i className="wk-sw" data-risk="tight" />Tight gap</li>}
          <li><i className="wk-sw wk-sw-cont" />Continues past midnight</li>
        </ul>
      </footer>

      {tip && <TipCard tip={tip} issues={tipIssues} now={now} />}
      {open && sheetShift && (
        <ShiftSheet key={open.id} shift={sheetShift} issues={issues[open.id] ?? []} rules={rules} now={now} opener={open.opener} onUpdate={onUpdate} onClose={() => setOpen(null)} />
      )}
    </section>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "wouter";
import { Minus, Plus, X } from "lucide-react";
import "../dashboard.css";
import "../picker.css";
import "../week.css";
import "../manage-shifts.css";
import { PhylaxMark } from "@/components/PhylaxMark";
import { SwipeToCancel } from "@/components/SwipeToCancel";
import { ShiftWeek } from "@/components/week/ShiftWeek";
import type { SheetPatch } from "@/components/week/ShiftSheet";
import { AddPlatform } from "@/components/picker/AddPlatform";
import { Autocomplete, type AcOption } from "@/components/picker/Autocomplete";
import { DatePicker } from "@/components/picker/DatePicker";
import { ShiftTimes } from "@/components/picker/ShiftTimes";
import { getCurrentAccount } from "../lib/auth";
import { nameSizeEm, possessiveName } from "../lib/dashboardName";
import { DashStrike } from "@/components/DashStrike";
import { CountUp } from "@/components/CountUp";
import { useInViewOnce } from "@/hooks/useInViewOnce";
import { sameText, suggestAddresses, suggestFacilities } from "../lib/places";
import {
  DEFAULT_PATTERNS, DEFAULT_RULES, PLATFORMS, cancelNote, clockRange, dateLabel, dur, example, hr, inDays,
  issuesFor, kindOf, lengthOf, minuteOfDay, patternState, relDay, samePattern, shiftType, span, t, toMin, uid, useStored, ymd,
  type Issue, type Pattern, type PatternState, type Rules, type Shift,
} from "../lib/shifts";
// The schedule lives on the server now. These three replace useStored for shifts, tiles and rules; the page's own code is
// unchanged, because each returns the same [value, setValue] pair (see lib/shiftStore.ts).
import { useServerPatterns, useServerRules, useServerShifts } from "../lib/shiftStore";

const OVERLAY_EXIT_MS = 480; // a touch longer than the .45s ov-out animation so the overlay is fully off-screen before it unmounts

const Accent = ({ children }: { children: ReactNode }) => <span className="accent-word">{children}</span>;
const Eyebrow = ({ children, light = false }: { children: ReactNode; light?: boolean }) => (
  <div className={`section-eyebrow ${light ? "section-eyebrow-light" : ""}`}><span className="eyebrow-dot" />{children}</div>
);

const hoursText = (min: number) => { const h = min / 60; return `${Number.isInteger(h) ? h : h.toFixed(1)} hours`; };

// One saved pattern, drawn from live data: its kind and length, the hours as a bar over the 24-hour day, and whether a
// logged shift of it is running now (a marker at the current time on the bar) or is next in line.
function PatternTile({ p, state, now }: { p: Pattern; state: PatternState; now: number }) {
  const segments = p.end > p.start ? [[p.start, p.end]] : [[p.start, 1440], [0, p.end]];
  const live = state.kind === "live";
  return (
    <div className="tile">
      <div className="tile-head">
        <span className="tile-label">{shiftType(p)} · {dur(lengthOf(p))}</span>
        {state.shift && (
          <span className={`tile-state ${live ? "is-live" : ""}`}>
            {live && <span className="signal-dot" />}{live ? "On shift" : `Next · ${relDay(state.shift.date, now)}`}
          </span>
        )}
      </div>
      <span className="tile-time">{hr(p.start)}—{hr(p.end)}</span>
      <div className="tile-bar" aria-hidden="true">
        {segments.map(([a, b]) => <span key={a} style={{ left: `${(a / 1440) * 100}%`, width: `${((b - a) / 1440) * 100}%` }} />)}
        {live && <i className="tile-now" style={{ left: `${(minuteOfDay(now) / 1440) * 100}%` }} />}
      </div>
    </div>
  );
}

// One conflict, written the way the landing page's alert card is. With `reveal` (the overview's cards only, not the add-shift
// live check) its two shift rows play the bar-wipe entrance once, the first time they scroll into view (see .v-reveal in dashboard.css).
function IssueCard({ a, issue, rules, now, reveal = false }: { a: Shift; issue: Issue; rules: Rules; now: number; reveal?: boolean }) {
  const b = issue.other;
  const overlap = issue.kind === "overlap";
  const [rowsRef, rowsSeen] = useInViewOnce<HTMLDivElement>();
  return (
    <div className="visual issue">
      <div className="v-head"><span className="v-alert"><span className="signal-dot" /> {overlap ? "Conflict detected" : "Tight window"}</span><span>{overlap ? "Critical" : "High"}</span></div>
      <div className="v-title">{overlap ? "Overlap" : "Tight gap"},<br />{dur(issue.minutes)}</div>
      <div className={reveal ? `v-rows v-reveal${rowsSeen ? " is-in" : ""}` : "v-rows"} ref={reveal ? rowsRef : undefined}>
        {[a, b].map((s) => <div key={s.id}><span>{s.platform} · {s.facility}</span><span>{dateLabel(s.date)} · {clockRange(s)}</span></div>)}
      </div>
      <p className="v-text">
        {overlap
          ? `${cancelNote(a, rules, now)} ${cancelNote(b, rules, now)} Review both before cancelling.`
          : `Different facilities, and less than your ${rules.travelMin}-minute travel buffer between them.`}
      </p>
      <div className="v-foot">Verify the current platform policy.</div>
    </div>
  );
}

// The Active shifts list. It owns the in-view check so the check starts when the list itself mounts (it only exists once shifts are
// logged), and its .v-reveal-list / .is-in classes play the bar-wipe on every row once (see dashboard.css).
function ShiftList({ children }: { children: ReactNode }) {
  const [ref, seen] = useInViewOnce<HTMLDivElement>();
  return <div ref={ref} className={`calendar-list shift-list v-reveal-list${seen ? " is-in" : ""}`}>{children}</div>;
}

function AddShift({ patterns, shifts, history, platforms, rules, now, initialPattern, initialDate, closing, onSave, onAddPlatform, onClose }: {
  patterns: Pattern[]; shifts: Shift[]; history: Shift[]; platforms: string[]; rules: Rules; now: number; initialPattern?: string; initialDate?: string; closing: boolean;
  onSave: (shift: Shift, pattern?: Pattern) => void; onAddPlatform: (name: string) => void; onClose: () => void;
}) {
  const today = inDays(0, now), tomorrow = inDays(1, now);
  const [platform, setPlatform] = useState("");
  const [patternId, setPatternId] = useState(initialPattern ?? "");
  const [date, setDate] = useState(initialDate ?? today);
  const [facility, setFacility] = useState("");
  const [address, setAddress] = useState("");
  const [from, setFrom] = useState("07:00");
  const [to, setTo] = useState("19:00");
  const [keep, setKeep] = useState(true);
  const [asking, setAsking] = useState(false);
  const addRef = useRef<HTMLButtonElement>(null);
  const autofilled = useRef(""); // the address a facility pick filled in, so a later pick may replace it but never a typed one
  const closeAsk = useCallback(() => setAsking(false), []);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = prev; window.removeEventListener("keydown", onKey); };
  }, [onClose]);

  const pattern: Pattern | undefined = patternId === "custom"
    ? (facility.trim() && toMin(from) !== toMin(to) ? { id: uid(), facility: facility.trim(), address: address.trim() || undefined, label: kindOf(toMin(from), toMin(to)), start: toMin(from), end: toMin(to) } : undefined)
    : patterns.find((p) => p.id === patternId);
  const candidate: Shift | null = platform && pattern && date ? { ...pattern, id: "new", platform, date } : null;
  // The live check: runs on every change, before anything is saved.
  const found = useMemo(() => (candidate ? issuesFor(candidate, shifts, rules) : []), [candidate, shifts, rules]);
  // Days that already carry a logged shift (an overnight shift marks both days); the date picker dots them.
  const logged = useMemo(() => new Set(shifts.flatMap((s) => { const [a, b] = span(s); return [ymd(new Date(a)), ymd(new Date(b - 1))]; })), [shifts]);
  // Suggestions come from every shift ever logged (`history`), including ones that have ended, not just the live ones the clash check reads.
  const facilityHits = useMemo(
    () => suggestFacilities(history, facility).filter((h) => !(sameText(h.facility, facility) && (!h.address || sameText(h.address, address)))),
    [history, facility, address],
  );
  const addressHits = useMemo(() => suggestAddresses(history, address, facility).filter((h) => !sameText(h.address, address)), [history, address, facility]);
  const facilityOptions: AcOption[] = facilityHits.map((h) => ({ key: h.facility.toLowerCase(), value: h.facility, primary: h.facility, secondary: h.address || undefined, meta: `${h.uses}×` }));
  const addressOptions: AcOption[] = addressHits.map((h) => ({ key: h.address.toLowerCase(), value: h.address, primary: h.address, secondary: h.facility || undefined, meta: `${h.uses}×` }));
  const pickFacility = (o: AcOption) => {
    const hit = facilityHits.find((h) => h.facility.toLowerCase() === o.key);
    setFacility(o.value);
    if (hit?.address && (!address.trim() || address === autofilled.current)) { setAddress(hit.address); autofilled.current = hit.address; }
  };
  const pickAddress = (o: AcOption) => {
    const hit = addressHits.find((h) => h.address.toLowerCase() === o.key);
    setAddress(o.value);
    autofilled.current = "";
    if (!facility.trim() && hit?.facility) setFacility(hit.facility);
  };
  const hasOverlap = found.some((i) => i.kind === "overlap");
  const status = !candidate ? "Waiting for details" : !found.length ? "All clear" : hasOverlap ? `Overlap · ${dur(found[0].minutes)}` : "Tight window";

  const save = () => {
    if (!candidate || !pattern) return;
    onSave({ ...candidate, id: uid() }, patternId === "custom" && keep ? pattern : undefined);
  };

  return (
    <div className={`ov ${closing ? "is-closing" : ""}`} role="dialog" aria-modal="true" aria-label="Log a shift" aria-hidden={closing || undefined}>
      <div className="ov-bar">
        <Eyebrow>Log a shift</Eyebrow>
        <span className={`ov-status ${found.length ? "is-risk" : ""}`}><span className="signal-dot" /> {status}</span>
        <button className="menu-trigger" onClick={onClose} aria-label="Close"><X size={19} strokeWidth={1.5} /></button>
      </div>
      <div className="ov-body">
        <div>
          <h2 className="display-heading ov-title">LOG A<br /><Accent>SHIFT</Accent></h2>
          <div className="ov-step">
            <span className="v-step-label">1 · Platform</span>
            <div className="chips">
              {platforms.map((p) => <button key={p} className={`chip ${platform === p ? "chip-on" : ""}`} aria-pressed={platform === p} onClick={() => setPlatform(p)}>{p}</button>)}
              <button type="button" ref={addRef} className="chip chip-add" onClick={() => setAsking(true)} aria-haspopup="dialog" aria-expanded={asking} aria-label="Add a platform">
                <Plus size={12} strokeWidth={1.5} aria-hidden="true" />Add platform
              </button>
            </div>
            <AddPlatform
              open={asking}
              existing={platforms}
              returnFocusRef={addRef}
              onClose={closeAsk}
              onAdd={(name) => { onAddPlatform(name); setPlatform(name); setAsking(false); }}
              onPickExisting={(name) => { setPlatform(name); setAsking(false); }}
            />
          </div>
          <div className="ov-step">
            <span className="v-step-label">2 · Saved pattern</span>
            <div className="pat-grid">
              {patterns.map((p) => (
                <button key={p.id} className={`pat ${patternId === p.id ? "is-on" : ""}`} onClick={() => setPatternId(p.id)}>
                  <strong>{p.facility}</strong><span>{shiftType(p)} · {clockRange(p)}</span>
                </button>
              ))}
              <button className={`pat ${patternId === "custom" ? "is-on" : ""}`} onClick={() => setPatternId("custom")}><strong>Custom</strong><span>One-off or new</span></button>
            </div>
            {patternId === "custom" && (
              <div className="custom">
                <Autocomplete label="Facility name" placeholder="Facility name" value={facility} onChange={setFacility} onPick={pickFacility} options={facilityOptions} heading="Logged before" />
                <Autocomplete label="Address, optional" placeholder="Address (optional)" value={address} onChange={setAddress} onPick={pickAddress} options={addressOptions} heading="Logged before" />
                <ShiftTimes from={from} to={to} onFromChange={setFrom} onToChange={setTo} />
                <label className="keep">
                  <span className="keep-box">
                    <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
                    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M4.6 8.5 7 10.9 11.6 5.3" pathLength="1" /></svg>
                  </span>
                  <span>Save as a pattern</span>
                </label>
              </div>
            )}
          </div>
          <div className="ov-step">
            <span className="v-step-label">3 · Date</span>
            <div className="chips">
              <button className={`chip ${date === today ? "chip-on" : ""}`} onClick={() => setDate(today)}>Today</button>
              <button className={`chip ${date === tomorrow ? "chip-on" : ""}`} onClick={() => setDate(tomorrow)}>Tomorrow</button>
              <DatePicker value={date} onChange={(v) => v && setDate(v)} today={today} marked={logged} active={date !== today && date !== tomorrow} label="Shift date" />
            </div>
          </div>
        </div>

        <aside className="ov-risk" aria-live="polite">
          {!candidate ? (
            <div className="visual">
              <div className="v-head"><span className="v-alert"><span className="signal-dot" /> Live check</span><span>{shifts.length} logged</span></div>
              <div className="v-title">Waiting<br />on you</div>
              <div className="v-rows">
                <div><span>Platform</span><span>{platform || "—"}</span></div>
                <div><span>Pattern</span><span>{pattern ? `${pattern.facility} · ${pattern.label}` : "—"}</span></div>
                <div><span>Date</span><span>{dateLabel(date)}</span></div>
              </div>
              <p className="v-text">Phylax checks the moment the details are in, before anything is saved.</p>
            </div>
          ) : found.length ? (
            found.map((i) => <IssueCard key={i.other.id} a={candidate} issue={i} rules={rules} now={now} />)
          ) : (
            <div className="visual">
              <div className="v-head"><span className="v-alert"><span className="signal-dot" /> All clear</span><span>Live check</span></div>
              <div className="v-title">No clash,<br />safe to save</div>
              <p className="v-text">{candidate.facility}, {dateLabel(date)}, {clockRange(candidate)} fits around your {shifts.length} logged shift{shifts.length === 1 ? "" : "s"}.</p>
            </div>
          )}
          <button className="v-save" disabled={!candidate} onClick={save}>{hasOverlap ? "Save anyway" : "Save shift"}</button>
          {found.length > 0 && <div className="v-foot">Phylax warns and explains. The call is yours.</div>}
        </aside>
      </div>
    </div>
  );
}

function Stepper({ label, value, unit, step, min, max, onChange }: { label: string; value: number; unit: string; step: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <div className="stepper">
      <span className="v-step-label">{label}</span>
      <div>
        <button onClick={() => onChange(Math.max(min, value - step))} aria-label={`Decrease ${label}`}><Minus size={13} /></button>
        <strong>{value} {unit}</strong>
        <button onClick={() => onChange(Math.min(max, value + step))} aria-label={`Increase ${label}`}><Plus size={13} /></button>
      </div>
    </div>
  );
}

export default function Dashboard() {
  // The name the person chose when they created their account. Read once on mount; nothing on this page changes it.
  const [owner] = useState(() => possessiveName(getCurrentAccount()?.displayName));
  // Shifts, tiles and rules are the account's, held by the server. The custom platform list stays on this device: the
  // backend stores the name on each shift but keeps no list of its own.
  const [shifts, setShifts] = useServerShifts();
  const [patterns, setPatterns] = useServerPatterns();
  const [rules, setRules] = useServerRules();
  const [customPlatforms, setCustomPlatforms] = useStored<string[]>("phylax.platforms", []);
  const [now, setNow] = useState(Date.now());
  const [adding, setAdding] = useState<{ pattern?: string; date?: string } | null>(null);
  const [closing, setClosing] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [undo, setUndo] = useState<Shift | null>(null);

  useEffect(() => { const i = setInterval(() => setNow(Date.now()), 60000); return () => clearInterval(i); }, []);
  useEffect(() => { if (!undo) return; const i = setTimeout(() => setUndo(null), 7000); return () => clearTimeout(i); }, [undo]);

  const active = useMemo(() => shifts.filter((s) => span(s)[1] > now).sort((a, b) => span(a)[0] - span(b)[0]), [shifts, now]);
  const issues = useMemo(() => Object.fromEntries(active.map((s) => [s.id, issuesFor(s, active, rules)])) as Record<string, Issue[]>, [active, rules]);
  const pairs = active.flatMap((a) => issues[a.id].filter((i) => a.id < i.other.id).map((issue) => ({ a, issue })));

  const hours = Math.round(active.filter((s) => span(s)[0] < now + 7 * 864e5).reduce((n, s) => n + (span(s)[1] - span(s)[0]) / 36e5, 0));
  const used = (p: Pattern) => shifts.filter((s) => samePattern(s, p)).length;
  // The built-in platforms, then the ones added with "+". Read defensively: it is whatever was last saved on this device.
  const platforms = useMemo(() => {
    const own = (Array.isArray(customPlatforms) ? customPlatforms : []).filter((p): p is string => typeof p === "string" && p.trim() !== "");
    return [...PLATFORMS, ...own.filter((p) => !PLATFORMS.some((d) => sameText(d, p)))];
  }, [customPlatforms]);
  const addPlatform = (name: string) => setCustomPlatforms((prev) => (prev.some((p) => sameText(p, name)) ? prev : [...prev, name]));

  const remove = (s: Shift) => { setShifts((prev) => prev.filter((x) => x.id !== s.id)); setUndo(s); };
  // Notes, contact and address typed into a shift's detail sheet are written straight back.
  const updateShift = (id: string, patch: SheetPatch) => setShifts((prev) => prev.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const restore = () => { if (undo) setShifts((prev) => [...prev, undo]); setUndo(null); };
  const openAdd = (pattern?: string, date?: string) => { clearTimeout(closeTimer.current); closeTimer.current = undefined; setClosing(false); setAdding({ pattern, date }); };
  // Slide the overlay down first, then unmount it once the exit animation has finished (OVERLAY_EXIT_MS matches dashboard.css).
  const closeAdd = useCallback(() => {
    if (closeTimer.current) return;
    setClosing(true);
    closeTimer.current = setTimeout(() => { closeTimer.current = undefined; setAdding(null); setClosing(false); }, OVERLAY_EXIT_MS);
  }, []);
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  const save = (shift: Shift, pattern?: Pattern) => {
    setShifts((prev) => [...prev, shift]);
    if (pattern) setPatterns((prev) => [...prev, pattern]);
    closeAdd();
  };

  return (
    <div className="site-shell">
      <div className="grain" aria-hidden="true" />
      <header className="global-nav">
        <Link href="/" className="brand-lockup" aria-label="Phylax home">
          <PhylaxMark />
          <span className="brand-name">Phylax</span>
        </Link>
        <div className="nav-center">Dashboard</div>
        <div className="nav-actions"><Link href="/shifts" className="ms-nav-link">Manage shifts</Link><Link href="/account" className="nav-store">Account</Link><button className="nav-store" onClick={() => openAdd()}>Log a shift <Plus size={14} /></button></div>
      </header>

      <main className="dash-section dark-section">
        <div className="dash-inner">
          <Eyebrow>Dashboard</Eyebrow>
          <div className="dash-top">
            {owner ? (
              // "<name>'s" is written over YOUR in Marker Hand, and YOUR is struck through, so it reads "Sam's STACK". Only the strike is drawn
              // (DashStrike); the name itself is not written out.
              // The note is decorative (aria-hidden), so a screen reader gets the same words from the visually hidden span.
              <h1 className="display-heading mobile-fit-heading has-marker-note dash-owned">
                <span className="sr-only">{owner}</span>
                <span className="dash-your" aria-hidden="true">YOUR<DashStrike /></span><br />
                <Accent>STACK</Accent>
                <span className="marker-note dash-name-box" aria-hidden="true">
                  <span className="dash-name" style={{ fontSize: `${nameSizeEm(owner)}em` }}>{owner}</span>
                </span>
              </h1>
            ) : (
              <h1 className="display-heading mobile-fit-heading">YOUR<br /><Accent>STACK</Accent></h1>
            )}
            <div className="dash-meta">
              <div className="calendar-meta"><span>ACTIVE</span><span>{active.length}</span></div>
              <div className="calendar-meta"><span>CLASHES</span><span>{pairs.length}</span></div>
              <button className="dash-add" onClick={() => openAdd()}><Plus size={14} /> Log a shift</button>
              <Link href="/account" className="text-link dash-account">Account &amp; alerts</Link>
            </div>
          </div>

          {active.length === 0 ? (
            <div className="visual dash-empty">
              <div className="v-head"><span>Nothing logged</span><span>Start here</span></div>
              <div className="v-title">Log the shift,<br />catch the clash</div>
              <p className="v-text">Pick the app, tap a saved pattern, save. Phylax checks it against everything you've logged.</p>
              <div className="chips">
                <button className="chip chip-on" onClick={() => openAdd()}>Log a shift</button>
                <button className="chip" onClick={() => setShifts(example())}>Load example week</button>
              </div>
            </div>
          ) : (
            <>
              <div className="dash-block">
                {pairs.length ? (
                  <div className="conflicts">{pairs.map(({ a, issue }) => <IssueCard key={a.id + issue.other.id} a={a} issue={issue} rules={rules} now={now} reveal />)}</div>
                ) : (
                  <div className="visual dash-clear">
                    <div className="v-head"><span className="v-alert"><span className="signal-dot" /> All clear</span><span>Checked on every save</span></div>
                    <div className="v-title">No conflicts,<br />{active.length} shift{active.length === 1 ? "" : "s"} checked</div>
                  </div>
                )}
              </div>

              <div className="dash-block">
                <ShiftWeek shifts={shifts} issues={issues} pairs={pairs} rules={rules} now={now} onAddDay={(date) => openAdd(undefined, date)} onUpdate={updateShift} />
              </div>

              <div className="dash-block">
                <div className="calendar-title-row"><Eyebrow>Active shifts</Eyebrow><span className="stats-label-dark swipe-hint"><span className="hint-touch">Swipe left to cancel</span><span className="hint-fine">Drag left or tap × to cancel</span></span></div>
                <ShiftList>
                  {active.map((s, i) => (
                    <SwipeToCancel key={s.id} className="shift-item" onCancel={() => remove(s)}>
                      <div className={`shift-row ${issues[s.id].length ? "is-risk" : ""}`}>
                        <span className="race-number">{String(i + 1).padStart(2, "0")}</span>
                        <span className="race-date">{dateLabel(s.date)}</span>
                        <span className="race-place">{s.facility}<small>{s.platform} · {shiftType(s)} · {clockRange(s)}</small></span>
                        <span className="race-time">
                          {issues[s.id].length ? issues[s.id].map((x) => <span key={x.other.id} className={`flag ${x.kind === "overlap" ? "flag-risk" : "flag-warn"}`}>{x.kind === "overlap" ? "Overlap" : "Tight"} · {dur(x.minutes)}</span>) : <span className="flag">Clear</span>}
                        </span>
                        <button className="remove" onClick={() => remove(s)} aria-label={`Cancel ${s.facility} shift on ${dateLabel(s.date)}`}><X size={15} strokeWidth={1.5} /></button>
                      </div>
                      {issues[s.id].map((x) => (
                        <p className="shift-note" key={x.other.id}>
                          {x.kind === "overlap" ? `Overlaps ${x.other.platform} · ${x.other.facility} by ${dur(x.minutes)}. ${cancelNote(s, rules, now)}` : `Only ${dur(x.minutes)} between this and ${x.other.facility}.`}
                        </p>
                      ))}
                    </SwipeToCancel>
                  ))}
                </ShiftList>
                <div className="rules">
                  <Stepper label="Travel buffer" value={rules.travelMin} unit="MIN" step={15} min={0} max={180} onChange={(v) => setRules({ ...rules, travelMin: v })} />
                  <Stepper label="Assumed cancellation window" value={rules.cancelHrs} unit="HRS" step={6} min={0} max={72} onChange={(v) => setRules({ ...rules, cancelHrs: v })} />
                  <p className="v-foot">Policies vary by platform and change. Set the window you trust, and verify it with the platform.</p>
                </div>
              </div>
            </>
          )}
        </div>
      </main>

      <section className="helmet-section cream-section dash-patterns">
        <div className="helmet-heading">
          <Eyebrow light>Your shifts</Eyebrow>
          <h2 className="display-heading dark-heading mobile-fit-heading">YOUR<br /><span>SHIFTS</span></h2>
          <p className="large-copy">Tap a pattern to log it. Every shift is a single tile.</p>
        </div>
        <div className="dash-stats">
          <div className="stat-block"><strong><CountUp id="stat-hours" value={hours} /></strong><span>hours booked, next 7 days</span></div>
          <div className="stat-block"><strong><CountUp id="stat-patterns" value={patterns.length} /></strong><span>saved patterns</span></div>
          <div className="stat-block"><strong><CountUp id="stat-platforms" value={new Set(active.map((s) => s.platform)).size} /></strong><span>platforms in use</span></div>
        </div>
        <div className="helmet-grid">
          {patterns.map((p, i) => {
            const state = patternState(p, active, now);
            const status = state.kind === "live" ? " On shift now." : state.shift ? ` Next ${relDay(state.shift.date, now).toLowerCase()}.` : "";
            return (
              <button className="helmet-card" key={p.id} onClick={() => openAdd(p.id)} aria-label={`Log ${p.facility} ${shiftType(p)}, ${hoursText(lengthOf(p))}.${status}`}>
                <div className="helmet-visual"><PatternTile p={p} state={state} now={now} /><div className="helmet-overlay" /></div>
                <div className="helmet-info"><span>{p.facility}</span><span>{t(p.start)}–{t(p.end)}</span></div>
                <span className="pattern-use">Used {used(p)}× · tap to log</span>
                <span className="helmet-index">0{i + 1}</span>
              </button>
            );
          })}
        </div>
      </section>

      {undo && <div className="undo" role="status"><span>Cancelled {undo.facility}</span><button onClick={restore}>Undo</button></div>}
      {adding && <AddShift patterns={patterns} shifts={active} history={shifts} platforms={platforms} rules={rules} now={now} initialPattern={adding.pattern} initialDate={adding.date} closing={closing} onSave={save} onAddPlatform={addPlatform} onClose={closeAdd} />}
    </div>
  );
}

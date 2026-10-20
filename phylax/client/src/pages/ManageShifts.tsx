import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { Download } from "lucide-react";
import "../dashboard.css";
import "../picker.css";
import "../manage-shifts.css";
import { PhylaxMark } from "@/components/PhylaxMark";
import { DatePicker } from "@/components/picker/DatePicker";
import { EditShiftPanel } from "@/components/manage/EditShiftPanel";
import { ImportPanel } from "@/components/manage/ImportPanel";
import { PLATFORMS, inDays } from "../lib/shifts";
import {
  csvFileName, dayText, exportLimit, hasBound, plural, rangeError, rangeLabel, sameRange, timesParts, toCsv, zoneInfo,
  CSV_UNBOUNDED_LIMIT, type Range, type StoredShift,
} from "../lib/manageShifts";
import {
  ApiError, NotFoundError, countShifts, deleteRange, deleteShift, exportShifts, getAccountTimezone, listCustomPlatforms, listShifts, subscribeToTimezone,
  type ImportResult,
} from "../lib/shiftsApi";

type Load = { status: "loading" | "ready" | "error"; shifts: StoredShift[]; message: string };
type Note = { tone: "warn" | "error" | "ok"; text: string } | null;

const failText = (err: unknown) => (err instanceof ApiError ? err.message : "Couldn't reach Phylax. Check your connection and try again.");
const aborted = (err: unknown) => err instanceof DOMException && err.name === "AbortError";

export default function ManageShifts() {
  const [zone, setZone] = useState(getAccountTimezone);
  const [now, setNow] = useState(Date.now());
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [applied, setApplied] = useState<Range>({ from: "", to: "" });
  const [load, setLoad] = useState<Load>({ status: "loading", shifts: [], message: "" });
  const [busy, setBusy] = useState<"" | "export" | "delete">("");
  const [rangeNote, setRangeNote] = useState<Note>(null);
  const [rowBusy, setRowBusy] = useState("");
  const [editing, setEditing] = useState<{ shift: StoredShift; opener: HTMLElement | null } | null>(null);
  const [toast, setToast] = useState("");
  const loadCtl = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  const today = inDays(0, now);
  const draft: Range = useMemo(() => ({ from, to }), [from, to]);
  const problem = rangeError(draft);
  const bounded = hasBound(draft);
  const pending = !sameRange(draft, applied);
  const info = useMemo(() => zoneInfo(zone, now), [zone, now]);

  useEffect(() => { document.title = "Manage shifts · Phylax"; }, []);
  useEffect(() => { const i = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(i); }, []);
  useEffect(() => subscribeToTimezone(() => setZone(getAccountTimezone())), []);
  useEffect(() => { if (!toast) return; const i = setTimeout(() => setToast(""), 6000); return () => clearTimeout(i); }, [toast]);

  const fetchRange = useCallback(async (range: Range, reveal = false) => {
    loadCtl.current?.abort();
    const ctl = new AbortController();
    loadCtl.current = ctl;
    setLoad((l) => ({ ...l, status: "loading", message: "" }));
    try {
      const shifts = await listShifts(range, ctl.signal);
      setLoad({ status: "ready", shifts, message: "" });
      if (reveal) requestAnimationFrame(() => heading.current?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" }));
    } catch (err) {
      if (!aborted(err)) setLoad((l) => ({ ...l, status: "error", message: failText(err) }));
    }
  }, []);

  useEffect(() => { void fetchRange({ from: "", to: "" }); return () => loadCtl.current?.abort(); }, [fetchRange]);

  const loadRange = () => {
    if (problem) { setRangeNote({ tone: "error", text: problem }); return; }
    setRangeNote(null);
    setApplied(draft);
    void fetchRange(draft, true);
  };

  const downloadCsv = async () => {
    if (problem) { setRangeNote({ tone: "error", text: problem }); return; }
    setBusy("export"); setRangeNote(null);
    try {
      const limit = exportLimit(draft);
      const { shifts, total } = await exportShifts(draft, limit);
      const blob = new Blob([toCsv(shifts)], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = csvFileName(draft);
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      if (limit !== null && total > shifts.length) {
        setRangeNote({ tone: "warn", text: `The export stopped at ${shifts.length.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} shifts, the earliest ones. Without both a From and a To date, a CSV holds at most ${CSV_UNBOUNDED_LIMIT.toLocaleString("en-US")} rows. Set both dates to export the rest.` });
      } else {
        setToast(`Exported ${plural(shifts.length, "shift")}`);
      }
    } catch (err) {
      setRangeNote({ tone: "error", text: failText(err) });
    } finally {
      setBusy("");
    }
  };

  const deleteInRange = async () => {
    if (!bounded) { setRangeNote({ tone: "error", text: "Set a From or To date before deleting a range." }); return; }
    if (problem) { setRangeNote({ tone: "error", text: problem }); return; }
    setBusy("delete"); setRangeNote(null);
    try {
      const n = await countShifts(draft);
      if (n === 0) { setRangeNote({ tone: "warn", text: `No shifts fall in ${rangeLabel(draft).toLowerCase()}. Nothing to delete.` }); return; }
      if (!window.confirm(`Delete ${plural(n, "shift")} in ${rangeLabel(draft).toLowerCase()}? This can't be undone.`)) return;
      const deleted = await deleteRange(draft);
      setToast(`Deleted ${plural(deleted, "shift")}`);
      void fetchRange(applied);
    } catch (err) {
      setRangeNote({ tone: "error", text: failText(err) });
    } finally {
      setBusy("");
    }
  };

  const removeRow = async (s: StoredShift) => {
    if (!window.confirm(`Delete ${s.facility} on ${dayText(s.date)}, ${timesParts(s).start}–${timesParts(s).end}? This can't be undone.`)) return;
    setRowBusy(s.id);
    try {
      await deleteShift(s.id);
      setToast(`Deleted ${s.facility}`);
    } catch (err) {
      if (!(err instanceof NotFoundError)) { setLoad((l) => ({ ...l, message: failText(err) })); setRowBusy(""); return; }
    }
    setLoad((l) => ({ ...l, message: "", shifts: l.shifts.filter((x) => x.id !== s.id) }));
    setRowBusy("");
  };

  const platforms = useMemo(() => {
    const seen = new Set<string>(), out: string[] = [];
    for (const p of [...PLATFORMS, ...listCustomPlatforms(), ...load.shifts.map((s) => s.platform)]) if (!seen.has(p.toLowerCase())) { seen.add(p.toLowerCase()); out.push(p); }
    return out;
  }, [load.shifts]);

  const onImported = (r: ImportResult) => { setToast(`Imported ${plural(r.imported, "shift")}${r.skipped ? `, skipped ${plural(r.skipped, "row")}` : ""}`); void fetchRange(applied); };
  const count = load.status === "loading" && !load.shifts.length ? "…" : load.shifts.length.toLocaleString("en-US");

  return (
    <div className="site-shell">
      <div className="grain" aria-hidden="true" />
      <header className="global-nav">
        <Link href="/" className="brand-lockup" aria-label="Phylax home"><PhylaxMark /><span className="brand-name">Phylax</span></Link>
        <div className="nav-center">Manage shifts</div>
        <nav className="nav-actions" aria-label="Manage shifts">
          <Link href="/dashboard" className="ms-nav-link"><span aria-hidden="true" className="ms-arrow">←</span> Dashboard</Link>
          <Link href="/account" className="ms-nav-link">Account &amp; alerts</Link>
        </nav>
      </header>

      <main className="dash-section dark-section ms-main">
        <div className="dash-inner">
          <div className="section-eyebrow"><span className="eyebrow-dot" />Shift archive</div>
          <div className="dash-top ms-top">
            <h1 className="display-heading mobile-fit-heading ms-title">
              <span className="ms-line"><span>MANAGE</span></span><br />
              <span className="ms-line"><span className="accent-word">SHIFTS</span></span>
            </h1>
            <div className="ms-meta">
              <div className="calendar-meta"><span>ACCOUNT TIMEZONE</span><span>{info ? info.zone : zone}</span></div>
              {info && <div className="calendar-meta"><span>TIME THERE NOW</span><span>{info.time}<small> {info.abbr}</small></span></div>}
            </div>
          </div>
          <p className="ms-lead">No list is silently truncated.</p>
          <p className="ms-fine">Every count on this page is the full count. Dates and times are wall-clock in the account timezone.</p>

          <section className="ms-section" aria-labelledby="ms-range">
            <div className="ms-side"><h2 className="ms-h2" id="ms-range">Range &amp; archive</h2><p>Pick a window, load it, take a copy, or clear it out. Leave a date empty to leave that side open.</p></div>
            <div className="ms-body">
              <div className="ms-dates">
                <div className="ms-date">
                  <div className="ms-date-head"><span className="v-step-label">From</span>{from && <button type="button" className="ms-clear" onClick={() => setFrom("")}>Clear</button>}</div>
                  <DatePicker value={from} onChange={(v) => v && setFrom(v)} today={today} max={to || undefined} active={Boolean(from)} label="From date" placeholder="Any date" invalid={Boolean(problem)} />
                </div>
                <div className="ms-date">
                  <div className="ms-date-head"><span className="v-step-label">To</span>{to && <button type="button" className="ms-clear" onClick={() => setTo("")}>Clear</button>}</div>
                  <DatePicker value={to} onChange={(v) => v && setTo(v)} today={today} min={from || undefined} active={Boolean(to)} label="To date" placeholder="Any date" invalid={Boolean(problem)} />
                </div>
                <button type="button" className={`ms-btn ms-btn-primary ${pending ? "is-pending" : ""}`} onClick={loadRange}>Load range</button>
              </div>
              {problem && <p className="pk-note is-error" role="alert"><span>{problem}</span></p>}

              <div className="ms-archive">
                <div className="ms-actions">
                  <button type="button" className="ms-btn ms-btn-quiet" onClick={downloadCsv} disabled={busy !== "" || Boolean(problem)}><Download size={14} strokeWidth={1.5} aria-hidden="true" />{busy === "export" ? "Preparing…" : "Download CSV export"}</button>
                </div>
                <p className="ms-fine">RFC 4180 CSV. {hasBound(draft) && draft.from && draft.to ? "Both dates are set, so every matching shift is included." : `Without both dates it stops at ${CSV_UNBOUNDED_LIMIT.toLocaleString("en-US")} rows and tells you if it did.`}</p>
              </div>
              <div className="ms-archive ms-danger">
                <div className="ms-actions">
                  <button type="button" className="ms-btn ms-btn-danger" onClick={deleteInRange} disabled={busy !== "" || !bounded || Boolean(problem)} aria-describedby="ms-del-hint">{busy === "delete" ? "Deleting…" : "Delete shifts in selected range"}</button>
                </div>
                <p className="ms-fine" id="ms-del-hint">{bounded ? "You'll be asked to confirm, with the number of shifts, before anything is removed." : "Set a From or To date to enable this. A range with no dates would clear everything."}</p>
              </div>
              {rangeNote && <div className={`ms-notice is-${rangeNote.tone}`} role={rangeNote.tone === "ok" ? "status" : "alert"}><p>{rangeNote.text}</p></div>}
            </div>
          </section>

          <section className="ms-section" aria-labelledby="ms-import">
            <div className="ms-side"><h2 className="ms-h2" id="ms-import">Import</h2><p>Bring shifts in from a file. They are added to what you have, never swapped for it.</p></div>
            <div className="ms-body"><ImportPanel onImported={onImported} /></div>
          </section>

          <section className="ms-list" aria-labelledby="ms-list-h" aria-busy={load.status === "loading"}>
            <div className="ms-list-head">
              <h2 className="ms-h2" id="ms-list-h" ref={heading} tabIndex={-1}>Shifts in range ({count})</h2>
              <span className="ms-range-label">{rangeLabel(applied)}{pending && <em> · dates changed, load the range to update</em>}</span>
            </div>

            {load.message && <div className="ms-notice is-error" role="alert"><p>{load.message}</p>{load.status === "error" && <div className="ms-notice-actions"><button type="button" className="ms-btn ms-btn-quiet" onClick={() => void fetchRange(applied)}>Try again</button></div>}</div>}

            {load.status === "loading" && !load.shifts.length ? (
              <div className="ms-skel" aria-hidden="true"><i /><i /><i /></div>
            ) : load.shifts.length === 0 && load.status !== "error" ? (
              <div className="visual ms-empty">
                <div className="v-head"><span>Nothing here</span><span>{rangeLabel(applied)}</span></div>
                <div className="v-title">No shifts<br />in this range</div>
                <p className="v-text">Widen the dates and load the range again, or import a file above.</p>
              </div>
            ) : (
              <ul className={`ms-rows ${load.status === "loading" ? "is-stale" : ""}`}>
                {load.shifts.map((s) => {
                  const t = timesParts(s);
                  return (
                    <li key={s.id} className="ms-row" aria-busy={rowBusy === s.id}>
                      <span className="ms-c-date">{dayText(s.date)}</span>
                      <span className="ms-c-place">{s.facility}<small>{s.platform}</small></span>
                      <span className="ms-c-time">{t.start}–{t.end}{t.nextDay && <small> (next day)</small>}</span>
                      <span className="ms-c-note">{s.notes}</span>
                      <span className="ms-c-act">
                        <button type="button" className="ms-text-btn" onClick={(e) => setEditing({ shift: s, opener: e.currentTarget })} disabled={rowBusy === s.id} aria-label={`Edit ${s.facility}, ${dayText(s.date)}`}>Edit</button>
                        <button type="button" className="ms-text-btn is-danger" onClick={() => void removeRow(s)} disabled={rowBusy === s.id} aria-label={`Delete ${s.facility}, ${dayText(s.date)}`}>{rowBusy === s.id ? "Deleting…" : "Delete"}</button>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      </main>

      {toast && <div className="undo" role="status"><span>{toast}</span></div>}
      {editing && (
        <EditShiftPanel
          key={editing.shift.id}
          shift={editing.shift}
          history={load.shifts}
          platforms={platforms}
          today={today}
          opener={editing.opener}
          onSaved={(saved) => { setToast(`Saved ${saved.facility}`); void fetchRange(applied); }}
          onGone={() => void fetchRange(applied)}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

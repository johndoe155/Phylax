import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { ymd } from "../../lib/shifts";
import {
  MONTHS_LONG, MONTHS_SHORT, WEEKDAYS_LONG, WEEKDAYS_SHORT, addDays, addMonths, dayName, daysInMonth, monthGrid, parseDay, yearPage,
} from "../../lib/pickerMath";
import { Popover } from "./Popover";
import { moveFocus } from "./grid";

type View = "days" | "months" | "years";

type Props = {
  /** YYYY-MM-DD, the same string the form stores. */
  value: string;
  onChange: (value: string) => void;
  /** YYYY-MM-DD for "today". Passed in so the picker agrees with the page's own clock. */
  today: string;
  /** Days that already carry a logged shift get a small mark. */
  marked?: ReadonlySet<string>;
  /** Earliest and latest selectable day (YYYY-MM-DD). Days outside are disabled. */
  min?: string;
  max?: string;
  /** Fills the trigger when the date is the active choice (chip-on), e.g. when it is neither Today nor Tomorrow. */
  active?: boolean;
  invalid?: boolean;
  disabled?: boolean;
  /** Accessible name of the trigger; the current date is appended. */
  label?: string;
  describedBy?: string;
  /** Shown on the trigger when `value` is empty (an optional date). An empty value opens on today. */
  placeholder?: string;
};

/**
 * Date picker: a trigger in the same register as the chips beside it, and a calendar that opens beneath it.
 * Days, months and years are three views of one panel; the month and the year in its heading are the doors between them.
 * The previous/next arrows sit in the footer, on the opposite side to "Today", so the heading has the whole width to itself.
 * Keyboard: arrows move by day/week, PageUp/PageDown by month (Shift: year), Home/End to the week's ends, Enter picks, Esc closes.
 */
export function DatePicker({ value, onChange, today, marked, min, max, active = false, invalid = false, disabled = false, label = "Date", describedBy, placeholder = "Choose a date" }: Props) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>("days");
  const [cursor, setCursor] = useState(() => parseDay(value || today));
  const [dir, setDir] = useState<"next" | "prev" | undefined>(undefined);
  const trigger = useRef<HTMLButtonElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const wantFocus = useRef(false);
  const id = useId();

  const close = useCallback(() => setOpen(false), []);
  const show = () => { setCursor(parseDay(value || today)); setView("days"); setDir(undefined); setOpen(true); };
  const off = (s: string) => Boolean((min && s < min) || (max && s > max));

  const year = cursor.getFullYear(), month = cursor.getMonth();
  const selected = parseDay(value || today);
  const here = parseDay(today);
  const page = yearPage(year);

  const pick = (s: string) => { if (off(s)) return; onChange(s); close(); };
  const go = (to: View) => { setDir(undefined); setView(to); };
  const jump = (next: Date, to?: View) => { wantFocus.current = true; setCursor(next); if (to) go(to); };
  const shift = (n: number) => { setDir(n > 0 ? "next" : "prev"); setCursor((c) => addMonths(c, view === "days" ? n : view === "months" ? 12 * n : 144 * n)); };

  // After a keyboard move, put focus on the day the cursor landed on (the grid may have flipped months).
  useEffect(() => {
    if (!open || !wantFocus.current) return;
    wantFocus.current = false;
    body.current?.querySelector<HTMLElement>(`[data-day="${ymd(cursor)}"]`)?.focus({ preventScroll: true });
  }, [cursor, view, open]);

  const onDayKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const next =
      e.key === "ArrowLeft" ? addDays(cursor, -1) : e.key === "ArrowRight" ? addDays(cursor, 1)
      : e.key === "ArrowUp" ? addDays(cursor, -7) : e.key === "ArrowDown" ? addDays(cursor, 7)
      : e.key === "Home" ? addDays(cursor, -cursor.getDay()) : e.key === "End" ? addDays(cursor, 6 - cursor.getDay())
      : e.key === "PageUp" ? addMonths(cursor, e.shiftKey ? -12 : -1) : e.key === "PageDown" ? addMonths(cursor, e.shiftKey ? 12 : 1) : null;
    if (!next) return;
    e.preventDefault();
    if (next.getMonth() !== month || next.getFullYear() !== year) setDir(next > cursor ? "next" : "prev");
    jump(next);
  };

  const title =
    view === "days" ? (
      <>
        <button type="button" onClick={() => go("months")} aria-label={`${MONTHS_LONG[month]}, choose a month`}>{MONTHS_LONG[month]}</button>
        <button type="button" className="pk-year" onClick={() => go("years")} aria-label={`${year}, choose a year`}>{year}</button>
      </>
    ) : view === "months" ? (
      <button type="button" className="pk-year" onClick={() => go("years")} aria-label={`${year}, choose a year`}>{year}</button>
    ) : (
      <span>{page}–{page + 11}</span>
    );
  const nav = view === "days" ? "month" : view === "months" ? "year" : "years";

  const summary = value ? dayName(selected) : placeholder;
  const isOn = active && !invalid;

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`pk-trigger pk-date ${isOn ? "is-on" : ""} ${value ? "" : "is-empty"}`}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${label}, ${summary}`}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        data-invalid={invalid || undefined}
        onClick={() => (open ? close() : show())}
      >
        <CalendarDays size={14} strokeWidth={1.5} aria-hidden="true" />
        <span>{value ? selected.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) : placeholder}</span>
        <svg className="pk-dash" aria-hidden="true" focusable="false"><rect width="100%" height="100%" rx="0" ry="0" /></svg>
      </button>

      <Popover open={open} anchorRef={trigger} label={`Choose ${label.toLowerCase()}`} onClose={close} className="pk-cal">
        <div className="pk-head">
          <h3 className="pk-title" id={`${id}-t`}>{title}</h3>
        </div>

        <div className="pk-body" ref={body}>
          {view === "days" && (
            <div role="grid" aria-labelledby={`${id}-t`} onKeyDown={onDayKey}>
              <div className="pk-row" role="row">
                {WEEKDAYS_SHORT.map((w, i) => <span key={w} className="pk-dow" role="columnheader" aria-label={WEEKDAYS_LONG[i]}>{w}</span>)}
              </div>
              <div className="pk-weeks" role="presentation" key={`${year}-${month}`} data-dir={dir}>
                {Array.from({ length: 6 }, (_, r) => (
                  <div className="pk-row" role="row" key={r}>
                    {monthGrid(year, month).slice(r * 7, r * 7 + 7).map((d) => {
                      const s = ymd(d), sel = s === value, now = s === today, out = d.getMonth() !== month, dis = off(s), at = d.getDate() === cursor.getDate() && !out;
                      return (
                        <button
                          key={s}
                          type="button"
                          role="gridcell"
                          data-day={s}
                          data-autofocus={at ? "" : undefined}
                          tabIndex={at ? 0 : -1}
                          aria-selected={sel}
                          aria-current={now ? "date" : undefined}
                          aria-disabled={dis || undefined}
                          aria-label={`${dayName(d)}${now ? ", today" : ""}${marked?.has(s) ? ", shift logged" : ""}`}
                          className={`pk-day ${sel ? "is-sel" : ""} ${now ? "is-now" : ""} ${out ? "is-out" : ""} ${dis ? "is-off" : ""} ${marked?.has(s) ? "is-marked" : ""}`}
                          onClick={() => pick(s)}
                        >
                          {d.getDate()}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          )}

          {view === "months" && (
            <div className="pk-tiles pk-fill" data-cols="3" role="group" aria-label={`Months of ${year}`} onKeyDown={(e) => moveFocus(e, 3)} key={`m${year}`} data-dir={dir}>
              {MONTHS_SHORT.map((m, i) => {
                const sel = selected.getFullYear() === year && selected.getMonth() === i, now = here.getFullYear() === year && here.getMonth() === i;
                return (
                  <button
                    key={m} type="button" data-autofocus={i === month ? "" : undefined} tabIndex={i === month ? 0 : -1}
                    className={`pk-tile ${sel ? "is-sel" : ""} ${now ? "is-now" : ""}`} aria-pressed={sel} aria-label={`${MONTHS_LONG[i]} ${year}`}
                    onClick={() => jump(new Date(year, i, Math.min(cursor.getDate(), daysInMonth(year, i))), "days")}
                  >{m}</button>
                );
              })}
            </div>
          )}

          {view === "years" && (
            <div className="pk-tiles pk-fill" data-cols="3" role="group" aria-label={`Years ${page} to ${page + 11}`} onKeyDown={(e) => moveFocus(e, 3)} key={`y${page}`} data-dir={dir}>
              {Array.from({ length: 12 }, (_, i) => page + i).map((y) => {
                const sel = selected.getFullYear() === y, now = here.getFullYear() === y;
                return (
                  <button
                    key={y} type="button" data-autofocus={y === year ? "" : undefined} tabIndex={y === year ? 0 : -1}
                    className={`pk-tile ${sel ? "is-sel" : ""} ${now ? "is-now" : ""}`} aria-pressed={sel}
                    onClick={() => jump(new Date(y, month, Math.min(cursor.getDate(), daysInMonth(y, month))), "days")}
                  >{y}</button>
                );
              })}
            </div>
          )}
        </div>

        <div className="pk-foot">
          <button type="button" className="pk-link" disabled={off(today)} onClick={() => pick(today)}>Today</button>
          {marked && marked.size > 0 && <span className="pk-legend">Shift logged</span>}
          <div className="pk-nav">
            <button type="button" onClick={() => shift(-1)} aria-label={`Previous ${nav}`}><ChevronLeft size={14} strokeWidth={1.5} /></button>
            <button type="button" onClick={() => shift(1)} aria-label={`Next ${nav}`}><ChevronRight size={14} strokeWidth={1.5} /></button>
          </div>
        </div>
      </Popover>
    </>
  );
}

import { useCallback, useId, useRef, useState } from "react";
import { Clock } from "lucide-react";
import { HOURS_12, MINUTES, clockLong, clockText, clockValue, from12, minutesOf, pad2, to12 } from "../../lib/pickerMath";
import { Popover } from "./Popover";
import { moveFocus } from "./grid";

type Props = {
  /** "HH:MM", 24-hour: the same string the form stores. */
  value: string;
  onChange: (value: string) => void;
  /** Accessible name and panel title, e.g. "Start time". */
  label: string;
  /** Short word shown on the trigger, e.g. "Start". */
  caption: string;
  /** Small note on the right of the caption, e.g. "Next day". */
  note?: string;
  invalid?: boolean;
  disabled?: boolean;
  describedBy?: string;
};

/**
 * One time of day. The trigger reads like a ticket stub: caption above, the time set large in the display face.
 * The panel is three small controls (hour, minute in five-minute steps, AM/PM) under a live readout, so a time takes
 * two or three taps and nothing scrolls. Arrow keys inside a group choose as they move.
 */
export function TimeField({ value, onChange, label, caption, note, invalid = false, disabled = false, describedBy }: Props) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const id = useId();

  const mins = minutesOf(value);
  const c = to12(mins);
  const set = (next: Partial<typeof c>) => onChange(clockValue(from12({ ...c, ...next })));
  const onGrid = Math.round(c.minute / 5) * 5 === c.minute; // times typed elsewhere can sit between steps; keep a way in
  const stops = onGrid ? c.minute : MINUTES[0];

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="pk-trigger pk-time"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${label}, ${clockLong(mins)}`}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        data-invalid={invalid || undefined}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span className="pk-micro"><span><Clock size={11} strokeWidth={1.5} aria-hidden="true" />{caption}</span>{note && <em>{note}</em>}</span>
        <span className="pk-value">{clockText(c)}<small>{c.pm ? "PM" : "AM"}</small></span>
        <svg className="pk-dash" aria-hidden="true" focusable="false"><rect width="100%" height="100%" rx="0" ry="0" /></svg>
      </button>

      <Popover open={open} anchorRef={trigger} label={`Choose ${label.toLowerCase()}`} onClose={close} className="pk-clock">
        <div className="pk-ph"><span>{label}</span>{note && <span className="pk-ph-note">{note}</span>}</div>

        <div className="pk-readout-row">
          <div className="pk-readout" aria-live="polite"><span key={mins}>{clockText(c)}</span></div>
          <div className="pk-seg" role="radiogroup" aria-label="AM or PM" data-v={c.pm ? "PM" : "AM"} onKeyDown={(e) => moveFocus(e, 2, true)}>
            {[false, true].map((pm) => (
              <button key={String(pm)} type="button" role="radio" aria-checked={c.pm === pm} tabIndex={c.pm === pm ? 0 : -1} onClick={() => set({ pm })}>{pm ? "PM" : "AM"}</button>
            ))}
          </div>
        </div>

        <span className="v-step-label pk-label" id={`${id}-h`}>Hour</span>
        <div className="pk-tiles pk-six" role="radiogroup" aria-labelledby={`${id}-h`} onKeyDown={(e) => moveFocus(e, 6, true)}>
          {HOURS_12.map((h) => (
            <button key={h} type="button" role="radio" data-autofocus={h === c.hour ? "" : undefined} aria-checked={h === c.hour} tabIndex={h === c.hour ? 0 : -1} className={`pk-tile ${h === c.hour ? "is-sel" : ""}`} onClick={() => set({ hour: h })}>{h}</button>
          ))}
        </div>

        <span className="v-step-label pk-label" id={`${id}-m`}>Minute</span>
        <div className="pk-tiles pk-six" role="radiogroup" aria-labelledby={`${id}-m`} onKeyDown={(e) => moveFocus(e, 6, true)}>
          {MINUTES.map((m) => (
            <button key={m} type="button" role="radio" aria-checked={m === c.minute} tabIndex={m === stops ? 0 : -1} className={`pk-tile ${m === c.minute ? "is-sel" : ""}`} onClick={() => set({ minute: m })}>{pad2(m)}</button>
          ))}
        </div>

        <button type="button" className="v-save pk-done" onClick={close}>Done</button>
      </Popover>
    </>
  );
}

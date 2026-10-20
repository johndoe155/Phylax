import { useId } from "react";
import { dur } from "../../lib/shifts";
import { clockValue, lengthBetween, minutesOf } from "../../lib/pickerMath";
import { TimeField } from "./TimeField";

const LENGTHS = [4, 6, 8, 10, 12]; // hours

/**
 * Start and end for a custom shift, plus shift length as a one-tap shortcut: pick a start, tap 12 HR, and the end follows.
 * It only reads and writes the two "HH:MM" strings the form already owns. The rule is unchanged: an end at or before the
 * start runs overnight, and identical times are not a shift (the form stays on "Waiting for details"); this block now
 * says so in place instead of leaving the Save button quietly off.
 */
export function ShiftTimes({ from, to, onFromChange, onToChange }: { from: string; to: string; onFromChange: (v: string) => void; onToChange: (v: string) => void }) {
  const noteId = useId();
  const a = minutesOf(from), b = minutesOf(to);
  const length = lengthBetween(a, b);
  const same = length === 0;
  const overnight = !same && b < a;

  return (
    <>
      <div className="custom-times">
        <TimeField value={from} onChange={onFromChange} label="Start time" caption="Start" invalid={same} describedBy={same ? noteId : undefined} />
        <TimeField value={to} onChange={onToChange} label="End time" caption="End" note={overnight ? "Next day" : undefined} invalid={same} describedBy={same ? noteId : undefined} />
      </div>
      <div className="pk-length">
        <span className="v-step-label">Length</span>
        <div className="chips" role="group" aria-label="Shift length">
          {LENGTHS.map((h) => (
            <button key={h} type="button" className={`chip ${length === h * 60 ? "chip-on" : ""}`} aria-pressed={length === h * 60} onClick={() => onToChange(clockValue(a + h * 60))}>{h} HR</button>
          ))}
        </div>
        <p id={noteId} className={`pk-note ${same ? "is-error" : ""}`} role={same ? "alert" : undefined}>
          {same ? <span>Start and end match. Change one to set a length.</span> : <span>{dur(length)} · ends {overnight ? "the next day" : "the same day"}</span>}
        </p>
      </div>
    </>
  );
}

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { splitMatch } from "@/lib/places";

export type AcOption = { key: string; value: string; primary: string; secondary?: string; meta?: string };

/**
 * A text field that suggests from a short list, in the form's own register (the .field input, the picker's surface and
 * hairlines). It is a standard combobox: the input keeps focus while arrow keys move through the list, Enter picks the
 * highlighted row, Escape closes the list (and only the list), Tab moves on. A tap or click on a row picks it.
 *
 * It does no searching of its own. The parent passes the options for what has been typed (an empty field gets the
 * parent's "most used" list, which is what makes it a quick-select on focus) and learns of a pick through `onPick`.
 */
export function Autocomplete({ value, onChange, onPick, options, label, placeholder, heading, maxLength }: {
  value: string; onChange: (v: string) => void; onPick: (o: AcOption) => void; options: AcOption[];
  label: string; placeholder: string; heading?: string; maxLength?: number;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();
  const show = open && options.length > 0;
  const signature = options.map((o) => o.key).join("|");

  useEffect(() => setActive(-1), [signature]);
  useEffect(() => {
    if (active >= 0) list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const pick = (o: AcOption) => { setOpen(false); setActive(-1); onPick(o); };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const n = options.length;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!n) return;
      e.preventDefault();
      if (!show) { setOpen(true); return; }
      setActive((a) => (e.key === "ArrowDown" ? (a + 1) % n : (a - 1 + n) % n));
    } else if (e.key === "Enter" && show && active >= 0) {
      e.preventDefault();
      pick(options[active]);
    } else if (e.key === "Escape" && show) {
      e.preventDefault();
      e.stopPropagation(); // closes the list only, not the whole overlay
      setOpen(false);
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };

  const mark = (text: string) => {
    const [a, hit, b] = splitMatch(text, value);
    return <>{a}{hit && <mark>{hit}</mark>}{b}</>;
  };

  return (
    <div className="ac">
      <input
        className="field"
        role="combobox"
        aria-expanded={show}
        aria-controls={`${id}-l`}
        aria-autocomplete="list"
        aria-activedescendant={show && active >= 0 ? `${id}-o${active}` : undefined}
        aria-label={label}
        placeholder={placeholder}
        maxLength={maxLength}
        value={value}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        onChange={(e) => { onChange(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {show && (
        <ul className="ac-list" id={`${id}-l`} role="listbox" aria-label={`${label} suggestions`} ref={list}>
          {heading && <li className="ac-head" role="presentation">{heading}</li>}
          {options.map((o, i) => (
            <li
              key={o.key}
              id={`${id}-o${i}`}
              role="option"
              aria-selected={i === active}
              className="ac-opt"
              onMouseDown={(e) => e.preventDefault()} // keep focus in the input so a pick is not preceded by a blur
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(o)}
            >
              <span className="ac-main">
                <span className="ac-primary">{mark(o.primary)}</span>
                {o.secondary && <span className="ac-secondary">{mark(o.secondary)}</span>}
              </span>
              {o.meta && <span className="ac-meta">{o.meta}</span>}
            </li>
          ))}
        </ul>
      )}
      <span className="sr-only" role="status">{show ? `${options.length} suggestion${options.length === 1 ? "" : "s"} from your logged shifts` : ""}</span>
    </div>
  );
}

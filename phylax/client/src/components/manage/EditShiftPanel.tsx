import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Plus, X } from "lucide-react";
import { AddPlatform } from "@/components/picker/AddPlatform";
import { Autocomplete, type AcOption } from "@/components/picker/Autocomplete";
import { DatePicker } from "@/components/picker/DatePicker";
import { ShiftTimes } from "@/components/picker/ShiftTimes";
import { suggestFacilities } from "@/lib/places";
import { addCustomPlatform, updateShift, ConflictError, NotFoundError, ApiError } from "@/lib/shiftsApi";
import {
  FIELD_MAX, changedFields, formFrom, sameForm, toPatch, validateEdit, versionOf,
  type EditForm, type StoredShift,
} from "@/lib/manageShifts";
import { kindOf, toMin } from "@/lib/shifts";

const EXIT_MS = 320; // matches .ms-panel's exit animation in manage-shifts.css

type Props = {
  shift: StoredShift;
  /** Every shift on the page, for facility suggestions. */
  history: StoredShift[];
  platforms: string[];
  today: string;
  opener: HTMLElement | null;
  onSaved: (shift: StoredShift) => void;
  /** The shift was deleted elsewhere. The page reloads its list. */
  onGone: () => void;
  onClose: () => void;
};

/**
 * Edit one shift. The panel remembers the version it was opened on and sends it as `expectedVersion` with every save. If the
 * stored shift has moved on, nothing is written: the panel names the fields that changed and offers to load the latest or
 * to keep the person's edits and save over it.
 */
export function EditShiftPanel({ shift, history, platforms, today, opener, onSaved, onGone, onClose }: Props) {
  const [base, setBase] = useState<StoredShift>(shift);
  const [form, setForm] = useState<EditForm>(() => formFrom(shift));
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState("");
  const [conflict, setConflict] = useState<StoredShift | null>(null);
  const [gone, setGone] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [adding, setAdding] = useState(false);
  const [extra, setExtra] = useState<string[]>([]);
  const panel = useRef<HTMLElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const titleId = useId();
  const warnId = useId();

  const set = <K extends keyof EditForm>(key: K, value: EditForm[K]) => { setForm((f) => ({ ...f, [key]: value })); setFailure(""); };
  const errors = useMemo(() => validateEdit(form), [form]);
  const invalid = Object.keys(errors).length > 0;
  const dirty = !sameForm(form, formFrom(base));
  const choices = useMemo(() => [...platforms, ...extra, ...(form.platform && ![...platforms, ...extra].some((p) => p.toLowerCase() === form.platform.toLowerCase()) ? [form.platform] : [])], [platforms, extra, form.platform]);
  const closeAdd = useCallback(() => setAdding(false), []);

  const close = useCallback(() => {
    if (timer.current) return;
    setLeaving(true);
    timer.current = window.setTimeout(() => { opener?.focus({ preventScroll: true }); onClose(); }, EXIT_MS);
  }, [onClose, opener]);

  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.current?.querySelector<HTMLElement>("input.field")?.focus({ preventScroll: true });
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => { document.body.style.overflow = prev; window.removeEventListener("keydown", onKey); };
  }, [close]);

  // Tab stays inside the panel. Keys from a picker's own popover are that popover's business.
  const trap = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "Tab" || !panel.current || (e.target as HTMLElement).closest(".pk-pop, .pk-modal")) return;
    const stops = Array.from(panel.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'))
      .filter((n) => !n.closest(".pk-pop, .pk-scrim") && n.tabIndex !== -1);
    if (!stops.length) return;
    const first = stops[0], last = stops[stops.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  const facilityHits = useMemo(() => suggestFacilities(history, form.facility).filter((h) => h.facility.toLowerCase() !== form.facility.trim().toLowerCase()), [history, form.facility]);
  const facilityOptions: AcOption[] = facilityHits.map((h) => ({ key: h.facility.toLowerCase(), value: h.facility, primary: h.facility, secondary: h.address || undefined, meta: `${h.uses}×` }));

  const save = async () => {
    setTouched(true);
    if (invalid || saving || !dirty) return;
    setSaving(true); setFailure("");
    try {
      const saved = await updateShift(base.id, toPatch(form), versionOf(base));
      onSaved(saved);
      close();
    } catch (err) {
      if (err instanceof ConflictError) setConflict(err.current);
      else if (err instanceof NotFoundError) setGone(true);
      else setFailure(err instanceof ApiError ? err.message : "Couldn't reach Phylax. Check your connection and save again.");
    } finally {
      setSaving(false);
    }
  };

  const loadLatest = () => { if (!conflict) return; setBase(conflict); setForm(formFrom(conflict)); setConflict(null); setTouched(false); };
  const keepMine = () => { if (!conflict) return; setBase(conflict); setConflict(null); };

  const kindHint = invalid && errors.times ? "" : kindOf(toMin(form.start), toMin(form.end));
  const show = (k: keyof typeof errors) => (touched ? errors[k] : undefined);
  const changed = conflict ? changedFields(base, conflict) : [];

  return (
    <>
      <div className={`ms-scrim ${leaving ? "is-leaving" : ""}`} onPointerDown={close} aria-hidden="true" />
      <aside ref={panel} className={`ms-panel ${leaving ? "is-leaving" : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={trap}>
        <header className="ms-panel-bar">
          <h2 className="ms-panel-title" id={titleId}>Edit shift</h2>
          <button type="button" className="menu-trigger" onClick={close} aria-label="Close"><X size={19} strokeWidth={1.5} /></button>
        </header>

        <div className="ms-panel-body">
          {conflict && (
            <div className="ms-notice is-warn" role="alert">
              <strong>Changed somewhere else</strong>
              <p>{changed.length ? `${changed.join(", ")} ${changed.length === 1 ? "was" : "were"} updated after you opened this shift.` : "This shift was updated after you opened it."} Nothing of yours was saved.</p>
              <div className="ms-notice-actions">
                <button type="button" className="ms-btn ms-btn-quiet" onClick={loadLatest}>Load latest</button>
                <button type="button" className="ms-btn ms-btn-quiet" onClick={keepMine}>Keep my edits</button>
              </div>
            </div>
          )}
          {gone && (
            <div className="ms-notice is-error" role="alert">
              <strong>Shift deleted</strong>
              <p>This shift was deleted somewhere else, so there is nothing to save to.</p>
              <div className="ms-notice-actions"><button type="button" className="ms-btn ms-btn-quiet" onClick={() => { onGone(); close(); }}>Back to the list</button></div>
            </div>
          )}

          <div className="ms-field" data-invalid={show("platform") ? "" : undefined}>
            <span className="v-step-label" id={`${titleId}-p`}>Platform</span>
            <div className="chips" role="group" aria-labelledby={`${titleId}-p`}>
              {choices.map((p) => <button key={p} type="button" className={`chip ${form.platform === p ? "chip-on" : ""}`} aria-pressed={form.platform === p} onClick={() => set("platform", p)}>{p}</button>)}
              <button type="button" ref={addRef} className="chip chip-add" onClick={() => setAdding(true)} aria-haspopup="dialog" aria-expanded={adding}><Plus size={12} strokeWidth={1.5} aria-hidden="true" />Add platform</button>
            </div>
            <AddPlatform
              open={adding}
              existing={choices}
              returnFocusRef={addRef}
              onClose={closeAdd}
              onAdd={(name) => { addCustomPlatform(name); setExtra((x) => [...x, name]); set("platform", name); setAdding(false); }}
              onPickExisting={(name) => { set("platform", name); setAdding(false); }}
            />
            {show("platform") && <p className="pk-note is-error" role="alert"><span>{errors.platform}</span></p>}
          </div>

          <div className="ms-field">
            <span className="v-step-label">Facility</span>
            <Autocomplete label="Facility" placeholder="Facility name" value={form.facility} onChange={(v) => set("facility", v)} onPick={(o) => set("facility", o.value)} options={facilityOptions} heading="Logged before" maxLength={FIELD_MAX.facility} />
            {show("facility") && <p className="pk-note is-error" role="alert"><span>{errors.facility}</span></p>}
          </div>

          <div className="ms-field">
            <label className="v-step-label" htmlFor={`${titleId}-l`}>Label</label>
            <input id={`${titleId}-l`} className="field" value={form.label} maxLength={FIELD_MAX.label} placeholder={kindHint || "Label"} onChange={(e) => set("label", e.target.value)} autoComplete="off" spellCheck={false} />
            <p className="pk-note"><span>{show("label") ?? (kindHint ? `Left blank, this reads ${kindHint}.` : "")}</span></p>
          </div>

          <div className="ms-field">
            <span className="v-step-label">Date</span>
            <div className="chips"><DatePicker value={form.date} onChange={(v) => v && set("date", v)} today={today} active label="Shift date" invalid={Boolean(show("date"))} /></div>
          </div>

          <div className="ms-field">
            <span className="v-step-label">Start time and end time</span>
            <ShiftTimes from={form.start} to={form.end} onFromChange={(v) => set("start", v)} onToChange={(v) => set("end", v)} />
          </div>

          <div className="ms-field">
            <label className="v-step-label" htmlFor={`${titleId}-n`}>Note</label>
            <textarea id={`${titleId}-n`} className="ms-textarea" rows={4} value={form.notes} maxLength={FIELD_MAX.notes} placeholder="Door code, contact, anything to remember" onChange={(e) => set("notes", e.target.value)} />
            <p className="pk-note"><span>{show("notes") ?? `${form.notes.length} / ${FIELD_MAX.notes}`}</span></p>
          </div>
        </div>

        <footer className="ms-panel-foot">
          <p className="ms-warn" id={warnId}><span className="signal-dot" />Pending alerts will be recalculated.</p>
          {failure && <p className="pk-note is-error" role="alert"><span>{failure}</span></p>}
          <div className="ms-panel-actions">
            <button type="button" className="ms-btn ms-btn-quiet" onClick={close}>Cancel</button>
            <button type="button" className="ms-btn ms-btn-primary" onClick={save} disabled={saving || !dirty || gone} aria-describedby={warnId}>{saving ? "Saving…" : "Save changes"}</button>
          </div>
        </footer>
      </aside>
    </>
  );
}

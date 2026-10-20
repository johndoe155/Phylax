import { useEffect, useId, useState, type FormEvent, type RefObject } from "react";
import { Modal } from "./Modal";

export const PLATFORM_MAX = 32;

/** Trims and collapses inner spaces, so "  Nurse   Now " and "Nurse Now" are one platform. */
export const cleanPlatform = (v: string) => v.trim().replace(/\s+/g, " ");

/**
 * The "+" chip's dialog: one field for the name of a platform that is not in the list. Adding it saves it to the list
 * (it is kept on this device, like the saved patterns) and selects it for the shift being logged. A name that is already
 * there is not added twice: the dialog says so and offers to pick the one that exists.
 */
export function AddPlatform({ open, existing, onAdd, onPickExisting, onClose, returnFocusRef }: {
  open: boolean; existing: string[]; onAdd: (name: string) => void; onPickExisting: (name: string) => void; onClose: () => void; returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const [name, setName] = useState("");
  const id = useId();

  useEffect(() => { if (open) setName(""); }, [open]);

  const value = cleanPlatform(name);
  const match = existing.find((p) => p.toLowerCase() === value.toLowerCase());
  const submit = (e: FormEvent) => { e.preventDefault(); if (value && !match) onAdd(value); };

  return (
    <Modal open={open} label="Add an app" onClose={onClose} returnFocusRef={returnFocusRef}>
      <form onSubmit={submit} noValidate>
        <div className="pk-ph"><span>New app</span></div>
        <h3 className="pk-mtitle" id={`${id}-t`}>Add an<br />app</h3>
        <p className="pk-mcopy">The app you pick shifts up on. It joins the list and is selected for this shift.</p>
        <input
          className="field pk-input"
          data-autofocus=""
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={PLATFORM_MAX}
          placeholder="App name"
          aria-label="App name"
          aria-describedby={`${id}-n`}
          aria-invalid={Boolean(match) || undefined}
          autoComplete="off"
          autoCapitalize="words"
          spellCheck={false}
          enterKeyHint="done"
        />
        <p id={`${id}-n`} className={`pk-note ${match ? "is-error" : ""}`} role={match ? "alert" : undefined}>
          {match
            ? <span>{match} is already in the list. <button type="button" className="pk-link" onClick={() => onPickExisting(match)}>Select it</button></span>
            : value.length >= PLATFORM_MAX - 6 ? <span>{PLATFORM_MAX - value.length} characters left</span> : null}
        </p>
        <div className="pk-mfoot">
          <button type="button" className="pk-link" onClick={onClose}>Cancel</button>
          <button type="submit" className="v-save pk-madd" disabled={!value || Boolean(match)}>Add app</button>
        </div>
      </form>
    </Modal>
  );
}

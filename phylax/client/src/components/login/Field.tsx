import { useId, type InputHTMLAttributes, type ReactNode, type Ref } from "react";
import { motion } from "framer-motion";

type FieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "value" | "onChange" | "placeholder"> & {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  /** Draws the dashed "clash" outline (the same one the hero draws around an overlap). The message itself lives outside. */
  invalid?: boolean;
  /** id of the element that carries the error text, so assistive tech reads it with the field. */
  describedBy?: string;
  /** Sits inside the field's right edge (the password eye). */
  trailing?: ReactNode;
  inputRef?: Ref<HTMLInputElement>;
};

/**
 * Floating-label field. The box is a fixed 60px and the label only ever moves with `transform`, so focusing,
 * filling or erroring never shifts layout. The label floats on :focus, when there is a value (placeholder=" " makes
 * :placeholder-shown a "is it empty?" test) and when the browser autofills. See .lg-field in login.css.
 */
export function Field({ label, value, onValueChange, invalid = false, describedBy, trailing, inputRef, ...rest }: FieldProps) {
  const id = useId();
  return (
    <div className="lg-field" data-invalid={invalid || undefined} data-trailing={trailing ? "" : undefined}>
      <input
        {...rest}
        ref={inputRef}
        id={id}
        className="lg-input"
        value={value}
        placeholder=" "
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onChange={(event) => onValueChange(event.target.value)}
      />
      <label className="lg-label" htmlFor={id}>{label}</label>
      {trailing}
      <svg className="lg-dash" aria-hidden="true" focusable="false"><rect width="100%" height="100%" rx="0" ry="0" /></svg>
    </div>
  );
}

// Both lids share one command structure (M, C, S), so Framer can interpolate between them.
const LID_TOP_OPEN = "M2 12C4.6 7.6 8 5.5 12 5.5S19.4 7.6 22 12";
const LID_BOTTOM_OPEN = "M2 12C4.6 16.4 8 18.5 12 18.5S19.4 16.4 22 12";
const LID_CLOSED = "M2 12C4.6 14.6 8 16 12 16S19.4 14.6 22 12";

/**
 * Show / hide password. The eye is closed while the password is hidden: both lids meet in a downward curve, the pupil
 * shrinks away and lashes appear; pressing it opens the lids and the pupil grows back in. The press itself squashes
 * the button on a stiff spring, which is the "haptic" part (the page adds a short vibration where the device has one).
 * Pointer-down is cancelled so the input keeps focus (and the keyboard stays up) while the button is used.
 */
export function EyeToggle({ shown, onToggle }: { shown: boolean; onToggle: () => void }) {
  const lid = { type: "spring" as const, stiffness: 420, damping: 30 };
  return (
    <motion.button
      type="button"
      className="lg-eye"
      aria-label={shown ? "Hide password" : "Show password"}
      aria-pressed={shown}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onToggle}
      whileTap={{ scale: 0.8 }}
      transition={{ type: "spring", stiffness: 640, damping: 24 }}
    >
      <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        <motion.path initial={false} animate={{ d: shown ? LID_TOP_OPEN : LID_CLOSED }} transition={lid} />
        <motion.path initial={false} animate={{ d: shown ? LID_BOTTOM_OPEN : LID_CLOSED }} transition={lid} />
        <motion.circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none" initial={false} animate={{ scale: shown ? 1 : 0, opacity: shown ? 1 : 0 }} transition={lid} />
        <motion.g initial={false} animate={{ opacity: shown ? 0 : 1 }} transition={{ duration: 0.18 }}>
          <path d="M6.6 15.2L5.3 17.4" />
          <path d="M12 16v2.7" />
          <path d="M17.4 15.2l1.3 2.2" />
        </motion.g>
      </svg>
    </motion.button>
  );
}

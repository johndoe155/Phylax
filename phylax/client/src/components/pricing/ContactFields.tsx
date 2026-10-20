import { useId, type ReactNode, type Ref, type TextareaHTMLAttributes } from "react";

/** Message line under a field. Always rendered (a fixed 24px row, see login.css), so an error never moves anything. */
export function Hint({ id, children }: { id?: string; children?: ReactNode }) {
  return <p className="lg-hint" id={id} aria-live="polite">{children ? <span key={String(children)}>{children}</span> : null}</p>;
}

type TextAreaFieldProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "id" | "value" | "onChange" | "placeholder"> & {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  /** Draws the dashed "clash" outline. The message itself lives outside, in a <Hint>. */
  invalid?: boolean;
  /** ids of the elements that describe the field (its error, its character count). */
  describedBy?: string;
  inputRef?: Ref<HTMLTextAreaElement>;
};

/**
 * The multi-line sibling of login/Field.tsx: the same floating label, edge, focus ring and dashed invalid outline
 * (all the `.lg-field` rules in login.css), on a taller box. The text area starts below the label's lane
 * (.cd-area in contact-dialog.css), so scrolled text never runs under the floated label.
 */
export function TextAreaField({ label, value, onValueChange, invalid = false, describedBy, inputRef, ...rest }: TextAreaFieldProps) {
  const id = useId();
  return (
    <div className="lg-field cd-area" data-invalid={invalid || undefined}>
      <textarea
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
      <svg className="lg-dash" aria-hidden="true" focusable="false"><rect width="100%" height="100%" rx="0" ry="0" /></svg>
    </div>
  );
}

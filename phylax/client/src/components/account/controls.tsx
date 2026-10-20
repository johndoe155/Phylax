import { forwardRef, useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type MouseEvent, type ReactNode, type Ref, type SelectHTMLAttributes } from "react";
import { motion } from "framer-motion";
import { Link } from "wouter";
import { AnimatedCheck } from "@/components/login/icons";
import { useInViewOnce } from "@/hooks/useInViewOnce";
import type { ActState } from "./context";

/* The account page's control set. Same language as the sign-in sheet (components/login, login.css): sharp corners, a
   fixed-height floating-label field whose label only moves with transform, a dashed marching "clash" outline for an
   invalid field, uppercase 800-weight actions that give way to a spinner and then a self-drawing check. It is drawn for
   the dark page instead of the cream sheet. Every rule is in account.css under .ac-. */

// ---- Hint row ---------------------------------------------------------------------------------------------------------

/** The line under a field. It is always rendered at one fixed height, so an error fading in never moves anything. */
export function Hint({ id, error, children }: { id?: string; error?: string | null; children?: ReactNode }) {
  return (
    <p className="ac-hint" id={id} data-tone={error ? "error" : "muted"}>
      {error ? <span key={error} role="alert">{error}</span> : children ? <span className="ac-hint-quiet">{children}</span> : null}
    </p>
  );
}

// ---- Text field -------------------------------------------------------------------------------------------------------

type FieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "value" | "onChange"> & {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  invalid?: boolean;
  /** id of the Hint under the field, so assistive tech reads it with the input. */
  hintId?: string;
  trailing?: ReactNode;
  mono?: boolean;
};

/**
 * Floating-label field on the dark surface. The box is a fixed 60px; the label floats on :focus, when there is a value
 * and when the browser autofills (an empty placeholder-shown test). A real `placeholder` stays invisible until focus,
 * so the label and the example never overlap.
 */
export const AcField = forwardRef<HTMLInputElement, FieldProps>(function AcField(
  { label, value, onValueChange, invalid = false, hintId, trailing, mono = false, placeholder, ...rest },
  ref,
) {
  const id = useId();
  return (
    <div className="ac-field" data-invalid={invalid || undefined} data-trailing={trailing ? "" : undefined} data-mono={mono || undefined}>
      <input
        {...rest}
        ref={ref}
        id={id}
        className="ac-input"
        value={value}
        placeholder={placeholder ?? " "}
        aria-invalid={invalid || undefined}
        aria-describedby={hintId}
        onChange={(event) => onValueChange(event.target.value)}
      />
      <label className="ac-label" htmlFor={id}>{label}</label>
      {trailing}
      <svg className="ac-dash" aria-hidden="true" focusable="false"><rect width="100%" height="100%" rx="0" ry="0" /></svg>
    </div>
  );
});

// Both lids share one command structure (M, C, S), so Framer can interpolate between them. Same drawing as the sign-in page's eye.
const LID_TOP_OPEN = "M2 12C4.6 7.6 8 5.5 12 5.5S19.4 7.6 22 12";
const LID_BOTTOM_OPEN = "M2 12C4.6 16.4 8 18.5 12 18.5S19.4 16.4 22 12";
const LID_CLOSED = "M2 12C4.6 14.6 8 16 12 16S19.4 14.6 22 12";

/** Show / hide password. Pointer-down is cancelled so the input keeps focus while the eye is used. */
export function AcEye({ shown, onToggle }: { shown: boolean; onToggle: () => void }) {
  const lid = { type: "spring" as const, stiffness: 420, damping: 30 };
  return (
    <motion.button
      type="button"
      className="ac-eye"
      aria-label={shown ? "Hide password" : "Show password"}
      aria-pressed={shown}
      onMouseDown={(event: { preventDefault: () => void }) => event.preventDefault()}
      onClick={onToggle}
      whileTap={{ scale: 0.8 }}
      transition={{ type: "spring", stiffness: 640, damping: 24 }}
    >
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
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

// ---- Select ------------------------------------------------------------------------------------------------------------

type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "id" | "value" | "onChange"> & {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  hintId?: string;
  children: ReactNode;
};

/** A real <select> in the field's box: native menus and keyboard on every device, the label always resting above the value. */
export function AcSelect({ label, value, onValueChange, hintId, children, ...rest }: SelectProps) {
  const id = useId();
  return (
    <div className="ac-field ac-select" data-float="">
      <select {...rest} id={id} className="ac-input" value={value} aria-describedby={hintId} onChange={(event) => onValueChange(event.target.value)}>
        {children}
      </select>
      <label className="ac-label" htmlFor={id}>{label}</label>
      <svg className="ac-select-chevron" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M6.5 9.5L12 15l5.5-5.5" /></svg>
    </div>
  );
}

// ---- Checkbox ---------------------------------------------------------------------------------------------------------

/** One big tap target on the field surface. The real checkbox sits invisibly over all of it, so label, box and note are one control. */
export function AcCheck({ checked, onChange, disabled = false, label, note, describedBy }: { checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean; label: string; note?: ReactNode; describedBy?: string }) {
  const noteId = useId();
  return (
    <label className="ac-check" data-on={checked || undefined} data-disabled={disabled || undefined}>
      <input
        type="checkbox"
        className="ac-check-input"
        checked={checked}
        disabled={disabled}
        aria-describedby={note ? noteId : describedBy}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="ac-box" aria-hidden="true"><AnimatedCheck show={checked} className="ac-box-check" strokeWidth={2.6} /></span>
      <span className="ac-check-text">
        <span className="ac-check-label">{label}</span>
        {note ? <span className="ac-check-note" id={noteId}>{note}</span> : null}
      </span>
    </label>
  );
}

// ---- Buttons ----------------------------------------------------------------------------------------------------------

type Variant = "solid" | "ghost" | "danger" | "quiet";

interface BaseButtonProps {
  variant?: Variant;
  size?: "md" | "sm";
  /** busy: spinner in place of the label; done: the check draws itself, then it settles. */
  state?: ActState;
  block?: boolean;
  icon?: ReactNode;
  children: ReactNode;
}

type ButtonProps = BaseButtonProps & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & { ref?: Ref<HTMLButtonElement> };
type LinkProps = BaseButtonProps & { href: string; target?: string; rel?: string; className?: string; onClick?: (event: MouseEvent<HTMLAnchorElement>) => void };

/** A scheme, a protocol-relative URL or an /api/ path leaves the app (a full-page request); anything else is a route. */
const leavesTheApp = (href: string) => /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/api\/)/i.test(href);

function Face({ icon, state, children }: Pick<BaseButtonProps, "icon" | "state" | "children">) {
  return (
    <>
      {icon ? <span className="ac-btn-icon" aria-hidden="true">{icon}</span> : null}
      <span className="ac-btn-label">{children}</span>
      <span className="ac-btn-spin" aria-hidden="true" />
      <AnimatedCheck show={state === "done"} className="ac-btn-check" />
    </>
  );
}

const faceProps = ({ variant = "ghost", size = "md", state = "idle", block = false }: BaseButtonProps) => ({
  "data-variant": variant,
  "data-size": size,
  "data-state": state === "idle" ? undefined : state,
  "data-block": block || undefined,
});

/** Primary and secondary actions. While `state` is busy the button stays focusable (so keyboard focus isn't lost) and aria-busy; the runner ignores a second press. */
export function AcButton({ variant, size, state, block, icon, children, className, ...rest }: ButtonProps) {
  return (
    <button type="button" {...rest} className={`ac-btn${className ? ` ${className}` : ""}`} {...faceProps({ variant, size, state, block, children })} aria-busy={state === "busy" || undefined}>
      <Face icon={icon} state={state}>{children}</Face>
    </button>
  );
}

/**
 * The same face on a link: "Link Google", "Go to sign in", "Sign in again with another method". In-app routes go through
 * wouter's <Link>, so they navigate without a reload; the root PageLoader (App.tsx) still plays on the way to a different
 * page, because it keys off the route change, not a reload. Only a target that
 * leaves the app (the OAuth start, an /api/ path or a full URL) is a plain <a>.
 */
export function AcLinkButton({ variant, size, state, block, icon, children, className, href, target, rel, onClick }: LinkProps) {
  const props = { className: `ac-btn${className ? ` ${className}` : ""}`, ...faceProps({ variant, size, state, block, children }), onClick };
  const face = <Face icon={icon} state={state}>{children}</Face>;
  return leavesTheApp(href)
    ? <a {...props} href={href} target={target} rel={rel}>{face}</a>
    : <Link {...props} href={href} target={target} rel={rel}>{face}</Link>;
}

// ---- Chips and layout ----------------------------------------------------------------------------------------------------

/** Small mono status: "Verified" fills blue, "Not verified" stays an outline. */
export function Chip({ tone = "off", children }: { tone?: "on" | "off"; children: ReactNode }) {
  return <span className="ac-chip" data-tone={tone}>{children}</span>;
}

export function Group({ label, aside, children, className }: { label?: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={`ac-group${className ? ` ${className}` : ""}`}>
      {label || aside ? (
        <div className="ac-group-head">
          {label ? <div className="section-eyebrow"><span className="eyebrow-dot" />{label}</div> : <span />}
          {aside}
        </div>
      ) : null}
      {children}
    </div>
  );
}

/** A section of the page: number, title, lead, then its groups. It rises into view once, the way the rest of the site does. */
export function Section({ id, no, title, lead, children }: { id: string; no: string; title: ReactNode; lead?: ReactNode; children: ReactNode }) {
  const [ref, seen] = useInViewOnce<HTMLElement>();
  const headingId = `${id}-title`;
  return (
    <section id={id} ref={ref} className={`ac-sec${seen ? " is-in" : ""}`} aria-labelledby={headingId} data-section>
      <header className="ac-sec-head">
        <span className="ac-sec-no" aria-hidden="true">{no}</span>
        <h2 className="ac-sec-title" id={headingId} tabIndex={-1}>{title}</h2>
        {lead ? <p className="ac-sec-lead">{lead}</p> : null}
      </header>
      <div className="ac-sec-body">{children}</div>
    </section>
  );
}

/** The loud note: dashed, marching outline (the hero's "clash" box) around the thing a person must not miss. */
export function Warning({ title, children }: { title: string; children: ReactNode }) {
  return (
    <aside className="ac-warning" role="note">
      <svg className="ac-dash ac-dash-on" aria-hidden="true" focusable="false"><rect width="100%" height="100%" rx="0" ry="0" /></svg>
      <div className="ac-warning-title"><span className="ac-warning-mark" aria-hidden="true">!</span>{title}</div>
      <p className="ac-warning-text">{children}</p>
    </aside>
  );
}

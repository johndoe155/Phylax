import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";

/** How long the clicked/active pose (rotated icon + lifted/dipped wrapper) is held before resetting. */
export const ARROW_ACTIVE_MS = 450;

type ArrowButtonVariant = "hero" | "footer";

interface InteractiveArrowButtonProps
  extends Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    "children" | "className" | "onClick" | "type"
  > {
  /** `hero`: icon straightens to point down, wrapper dips. `footer`: icon straightens to point up, wrapper lifts. */
  variant: ArrowButtonVariant;
  onClick?: () => void;
  /** Non-interactive copy (e.g. the inverted hero twin inside the blob): same DOM/CSS, rendered as a span. */
  decorative?: boolean;
  /** How long the active pose is held after a click before it resets. */
  activeMs?: number;
  children: ReactNode;
}

/**
 * Interactive round arrow button (Hero scroll-down, Footer back-to-top).
 *
 * DOM separation rule — the two halves of the motion live on different nodes so their
 * transforms can never overwrite each other:
 *
 *   outer <button> (.arrow-button)   translation ONLY (lift / dip), plus all click handling
 *   inner <span>   (.arrow-icon)     rotation ONLY, transform-origin: center center
 *
 * The icon (and the SVG inside it) has pointer-events: none, so every pointer event
 * lands on the button itself. See the `.arrow-button--hero` / `.arrow-button--footer`
 * rules in index.css for the actual transforms.
 *
 * Active-state lifecycle: a click raises `is-active`, then a timer lowers it again
 * after `activeMs`. Every click clears the previous timer first, so rapid clicking
 * can neither stack timers nor leave the button stuck in the active pose — it always
 * settles `activeMs` after the LAST click. The timer is also cleared on unmount and
 * on blur, and the CSS `:active` pseudo-class covers press-and-hold (including
 * keyboard activation) independently of this state, so releasing early can never
 * strand the pose either.
 */
export function InteractiveArrowButton({
  variant,
  onClick,
  decorative = false,
  activeMs = ARROW_ACTIVE_MS,
  children,
  ...buttonProps
}: InteractiveArrowButtonProps) {
  const [active, setActive] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const actionTimer = useRef<number | undefined>(undefined);

  const clearPendingReset = () => {
    if (timer.current !== undefined) {
      window.clearTimeout(timer.current);
      timer.current = undefined;
    }
  };

  const clearPendingAction = () => {
    if (actionTimer.current !== undefined) {
      window.clearTimeout(actionTimer.current);
      actionTimer.current = undefined;
    }
  };

  // Never leave a timer (or a stuck active pose) behind after unmount.
  useEffect(() => () => {
    clearPendingReset();
    clearPendingAction();
  }, []);

  const handleClick = () => {
    clearPendingReset();
    clearPendingAction();
    setActive(true);
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      setActive(false);
    }, activeMs);
    actionTimer.current = window.setTimeout(() => {
      actionTimer.current = undefined;
      onClick?.();
    }, activeMs);
  };

  const handleBlur = () => {
    clearPendingReset();
    setActive(false);
  };

  const className = `round-arrow arrow-button arrow-button--${variant}${
    active ? " is-active" : ""
  }`;
  const icon = (
    <span className="arrow-icon" aria-hidden="true">
      {children}
    </span>
  );

  if (decorative) {
    return (
      <span className={className} aria-hidden="true">
        {icon}
      </span>
    );
  }

  return (
    <button
      type="button"
      className={className}
      onClick={handleClick}
      onBlur={handleBlur}
      {...buttonProps}
    >
      {icon}
    </button>
  );
}

export default InteractiveArrowButton;

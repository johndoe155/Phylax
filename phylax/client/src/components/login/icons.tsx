import type { SVGProps } from "react";
import { motion } from "framer-motion";

/* Small inline icon set for the login page. Stroke icons share one grid (24, 1.6 stroke, round caps) so they sit
   together; brand glyphs (Apple, Google) are filled. Everything is decorative: the button text carries the meaning. */
type IconProps = SVGProps<SVGSVGElement>;

const stroke = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
  focusable: false,
} as const;

export const EASE_OUT: [number, number, number, number] = [0.16, 1, 0.3, 1];
export const EASE_IN: [number, number, number, number] = [0.7, 0, 0.84, 0];

export function IconClose(props: IconProps) {
  return <svg width="20" height="20" {...stroke} {...props}><path d="M6 6l12 12M18 6L6 18" /></svg>;
}

export function IconChevronLeft(props: IconProps) {
  return <svg width="22" height="22" {...stroke} {...props}><path d="M14.5 5.5L8 12l6.5 6.5" /></svg>;
}

export function IconMail(props: IconProps) {
  return <svg width="22" height="22" {...stroke} {...props}><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="M3.5 7.5l8.5 6 8.5-6" /></svg>;
}

export function IconLock(props: IconProps) {
  return <svg width="15" height="15" {...stroke} strokeWidth={1.8} {...props}><rect x="5" y="11" width="14" height="9" rx="2.5" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>;
}

export function IconFingerprint(props: IconProps) {
  return (
    <svg width="22" height="22" {...stroke} {...props}>
      <path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4" />
      <path d="M14 13.12c0 2.38 0 6.38-1 8.88" />
      <path d="M17.29 21.02c.12-.6.43-2.3.5-3.02" />
      <path d="M2 12a10 10 0 0 1 18-6" />
      <path d="M2 16h.01" />
      <path d="M21.8 16c.2-2 .131-5.354 0-6" />
      <path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2" />
      <path d="M8.65 22c.21-.66.45-1.32.57-2" />
      <path d="M9 6.8a6 6 0 0 1 9 5.2v2" />
    </svg>
  );
}

export function IconApple(props: IconProps) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false" {...props}>
      <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701" />
    </svg>
  );
}

export function IconGoogle(props: IconProps) {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" aria-hidden="true" focusable="false" {...props}>
      <path fill="#4285F4" d="M23.52 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.46a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.58-5.17 3.58-8.81z" />
      <path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.94-2.91l-3.88-3c-1.08.72-2.45 1.15-4.06 1.15-3.12 0-5.77-2.11-6.71-4.94H1.28v3.09A12 12 0 0 0 12 24z" />
      <path fill="#FBBC05" d="M5.29 14.3A7.2 7.2 0 0 1 4.91 12c0-.8.14-1.57.38-2.3V6.61H1.28A12 12 0 0 0 0 12c0 1.94.46 3.77 1.28 5.39l4.01-3.09z" />
      <path fill="#EA4335" d="M12 4.75c1.76 0 3.34.61 4.59 1.8l3.44-3.44C17.95 1.19 15.24 0 12 0A12 12 0 0 0 1.28 6.61l4.01 3.09C6.23 6.86 8.88 4.75 12 4.75z" />
    </svg>
  );
}

/** A checkmark that draws itself when `show` turns true (and vanishes instantly when it turns false). */
export function AnimatedCheck({ show, className, strokeWidth = 2.4 }: { show: boolean; className?: string; strokeWidth?: number }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <motion.path
        d="M5.5 12.6l4.1 4.1 8.9-9.4"
        initial={false}
        animate={{ pathLength: show ? 1 : 0, opacity: show ? 1 : 0 }}
        transition={{ duration: show ? 0.42 : 0, ease: EASE_OUT, delay: show ? 0.12 : 0 }}
      />
    </svg>
  );
}

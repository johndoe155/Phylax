import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

const stroke = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, focusable: false } as const;

/** A circle with an exclamation mark: for notices and problems. Same grid and stroke as components/login/icons.tsx. */
export function IconAlert(props: IconProps) {
  return <svg width="30" height="30" {...stroke} {...props}><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.2" /><path d="M12 16.4h.01" strokeWidth={2.2} /></svg>;
}

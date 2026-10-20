import type { SVGProps } from "react";

/* Two more glyphs for the account flow, on the same grid as the login page's set (components/login/icons.tsx): 24 box,
   1.6 stroke, round caps, decorative (the text beside them carries the meaning). */
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

export function IconUserPlus(props: IconProps) {
  return (
    <svg width="26" height="26" {...stroke} {...props}>
      <circle cx="10" cy="8.5" r="3.6" />
      <path d="M3.5 20c.4-3.6 3-5.8 6.5-5.8 1.4 0 2.6.3 3.6.9" />
      <path d="M18.5 14.5v6M15.5 17.5h6" />
    </svg>
  );
}

export function IconArrowUpRight(props: IconProps) {
  return <svg width="18" height="18" {...stroke} {...props}><path d="M7 17L17 7M8.5 7H17v8.5" /></svg>;
}

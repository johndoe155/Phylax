import type { SVGProps } from "react";

/* Small stroke icons for the account page: the same 24 grid, 1.6 stroke and round caps as components/login/icons.tsx.
   Decorative only: the button or link text carries the meaning. */
type IconProps = SVGProps<SVGSVGElement>;

const stroke = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, focusable: false } as const;

export const IconArrowUpRight = (props: IconProps) => <svg width="16" height="16" {...stroke} {...props}><path d="M7 17L17 7M9 7h8v8" /></svg>;
export const IconDownload = (props: IconProps) => <svg width="18" height="18" {...stroke} {...props}><path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14" /></svg>;
export const IconRefresh = (props: IconProps) => <svg width="18" height="18" {...stroke} {...props}><path d="M19.5 12a7.5 7.5 0 1 1-2.3-5.4M19.5 4.5v4h-4" /></svg>;
export const IconKey = (props: IconProps) => <svg width="18" height="18" {...stroke} {...props}><circle cx="8" cy="15" r="3.6" /><path d="M10.7 12.6L19 4.5M15.5 8l2.5 2.5" /></svg>;
export const IconPhone = (props: IconProps) => <svg width="18" height="18" {...stroke} {...props}><rect x="7" y="3" width="10" height="18" rx="2.4" /><path d="M11 17.5h2" /></svg>;
export const IconMonitor = (props: IconProps) => <svg width="20" height="20" {...stroke} {...props}><rect x="3" y="4.5" width="18" height="12" rx="2" /><path d="M8.5 20h7M12 16.5V20" /></svg>;
export const IconShield = (props: IconProps) => <svg width="18" height="18" {...stroke} {...props}><path d="M12 3.5l7 2.6v5.6c0 4.2-2.9 7.4-7 8.8-4.1-1.4-7-4.6-7-8.8V6.1l7-2.6z" /><path d="M9 12l2.2 2.2L15.2 10" /></svg>;
export const IconTrash = (props: IconProps) => <svg width="18" height="18" {...stroke} {...props}><path d="M4.5 7h15M9.5 7V4.8h5V7M6.5 7l.8 12h9.4l.8-12M10 11v5M14 11v5" /></svg>;

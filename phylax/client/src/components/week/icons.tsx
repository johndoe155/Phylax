import type { ReactElement, ReactNode } from "react";
import type { Kind } from "@/lib/weekBoard";

/** One hairline icon set for the week board and its sheet. 24px grid, 1.5 stroke, drawn in currentColor, decorative only. */
function Icon({ size = 16, children }: { size?: number; children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}
type P = { size?: number };

export const ChevronLeft = (p: P) => <Icon {...p}><path d="m14.5 6-6 6 6 6" /></Icon>;
export const ChevronRight = (p: P) => <Icon {...p}><path d="m9.5 6 6 6-6 6" /></Icon>;
export const ArrowDown = (p: P) => <Icon {...p}><path d="M12 5v14m-6-6 6 6 6-6" /></Icon>;
export const CheckCircle = (p: P) => <Icon {...p}><circle cx="12" cy="12" r="9" /><path d="m8 12.4 2.7 2.7L16.2 9.5" /></Icon>;
export const Warning = (p: P) => <Icon {...p}><path d="M12 4 2.8 19.5h18.4L12 4Z" /><path d="M12 10v4.2M12 16.9v.1" /></Icon>;
export const Info = (p: P) => <Icon {...p}><circle cx="12" cy="12" r="9" /><path d="M12 11v5.2M12 7.9v.1" /></Icon>;
export const Close = (p: P) => <Icon {...p}><path d="m6 6 12 12M18 6 6 18" /></Icon>;
export const Plus = (p: P) => <Icon {...p}><path d="M12 5v14M5 12h14" /></Icon>;
export const Calendar = (p: P) => <Icon {...p}><rect x="3.5" y="5" width="17" height="15.5" rx="1" /><path d="M3.5 10h17M8 3v4M16 3v4" /></Icon>;
export const Navigate = (p: P) => <Icon {...p}><path d="m20 4-7.2 16-2.3-7.5L3 10.2 20 4Z" /></Icon>;
export const Swap = (p: P) => <Icon {...p}><path d="M4 8h14.5m-3-3.5 3.5 3.5-3.5 3.5M20 16H5.5m3 3.5L5 16l3.5-3.5" /></Icon>;
export const Phone = (p: P) => <Icon {...p}><path d="M5 4h3.6l1.7 4.6-2.2 1.4a11 11 0 0 0 5.9 5.9l1.4-2.2 4.6 1.7V19a1.6 1.6 0 0 1-1.7 1.6A15.4 15.4 0 0 1 3.4 5.7 1.6 1.6 0 0 1 5 4Z" /></Icon>;
export const Pin = (p: P) => <Icon {...p}><path d="M12 21s6.5-5.7 6.5-11A6.5 6.5 0 0 0 5.5 10C5.5 15.3 12 21 12 21Z" /><circle cx="12" cy="10" r="2.3" /></Icon>;

// Shift kinds. Each has its own glyph, so the type of a shift reads without colour.
export const Sun = (p: P) => <Icon {...p}><circle cx="12" cy="12" r="3.6" /><path d="M12 3.5v2.3M12 18.2v2.3M3.5 12h2.3M18.2 12h2.3M6 6l1.6 1.6M16.4 16.4 18 18M18 6l-1.6 1.6M7.6 16.4 6 18" /></Icon>;
export const Sunrise = (p: P) => <Icon {...p}><path d="M6.5 16a5.5 5.5 0 0 1 11 0M3 16h18M12 4.5v3.3m0-3.3L10 6.5m2-2 2 2M5.6 9.6l1.4 1.4M18.4 9.6 17 11M4 20h16" /></Icon>;
export const Sunset = (p: P) => <Icon {...p}><path d="M6.5 16a5.5 5.5 0 0 1 11 0M3 16h18M12 7.8V4.5m0 3.3-2-2m2 2 2-2M5.6 9.6 7 11M18.4 9.6 17 11M4 20h16" /></Icon>;
export const Moon = (p: P) => <Icon {...p}><path d="M19.5 14.6A8 8 0 0 1 9.4 4.5a8 8 0 1 0 10.1 10.1Z" /></Icon>;
export const Clock = (p: P) => <Icon {...p}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></Icon>;

export const KIND_ICON: Record<Kind, (p: P) => ReactElement> = { Day: Sun, Early: Sunrise, Evening: Sunset, Night: Moon, Short: Clock };
export function KindGlyph({ kind, size }: { kind: Kind; size?: number }) {
  const G = KIND_ICON[kind];
  return <G size={size} />;
}

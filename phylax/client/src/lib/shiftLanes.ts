// Shared data for the landing page's shift-lane diagrams: the window runs 6 PM (18) to 2 PM next day (38).
export type Bar = { from: number; to: number; name: string; time: string; blue?: boolean };

export const WINDOW: [number, number] = [18, 38];
export const pct = (hour: number) => ((hour - WINDOW[0]) / (WINDOW[1] - WINDOW[0])) * 100;

export const axis = [
  { at: 18, label: "6P" },
  { at: 24, label: "12A" },
  { at: 30, label: "6A" },
  { at: 36, label: "12P" },
];

export const nightShift: Bar = { from: 19, to: 31, name: "Riverside Manor", time: "7P–7A" };
export const dayShift: Bar = { from: 30, to: 38, name: "St. Anne's", time: "6A–2P", blue: true };

// The hour both shifts cover (6A–7A).
export const CLASH: [number, number] = [30, 31];

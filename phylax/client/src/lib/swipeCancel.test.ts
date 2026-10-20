import { describe, expect, it } from "vitest";
import { SWIPE, isComplete, offsetFor, progressOf, readIntent, trackFor } from "./swipeCancel";

describe("swipeCancel", () => {
  it("treats a small touch as undecided", () => {
    expect(readIntent(0, 0)).toBe("pending");
    expect(readIntent(-(SWIPE.slop - 1), SWIPE.slop - 1)).toBe("pending");
  });

  it("locks onto a clearly horizontal leftward drag", () => {
    expect(readIntent(-20, 3)).toBe("swipe");
    expect(readIntent(-SWIPE.slop, 0)).toBe("swipe");
  });

  it("leaves vertical scrolling and diagonal drags to the page", () => {
    expect(readIntent(-4, 30)).toBe("ignore");
    expect(readIntent(-30, 30)).toBe("ignore"); // 45°: too diagonal
    expect(readIntent(-30, 22)).toBe("ignore"); // still steeper than the limit
  });

  it("ignores rightward drags", () => {
    expect(readIntent(40, 2)).toBe("ignore");
  });

  it("keeps the track between its limits", () => {
    expect(trackFor(200)).toBe(SWIPE.minTrack);
    expect(trackFor(330)).toBe(165);
    expect(trackFor(1150)).toBe(SWIPE.maxTrack);
  });

  it("follows the finger and stops at both ends", () => {
    const track = 180;
    expect(offsetFor(0, -60, track)).toBe(-60);
    expect(offsetFor(0, 80, track)).toBe(0); // dragging back past the start never pushes the row right
    expect(offsetFor(0, -500, track)).toBe(-track);
  });

  it("is reversible: dragging back to the lock point returns the row to the start", () => {
    const track = 180;
    const out = offsetFor(0, -120, track);
    expect(progressOf(out, track)).toBeCloseTo(120 / 180);
    expect(offsetFor(0, 0, track)).toBe(0);
    expect(progressOf(offsetFor(0, 0, track), track)).toBe(0);
  });

  it("continues from where a caught row was", () => {
    expect(offsetFor(-50, -20, 180)).toBe(-70);
    expect(offsetFor(-50, 30, 180)).toBe(-20); // dragging back eases it toward the start
    expect(offsetFor(-50, 80, 180)).toBe(0); // and never past it
  });

  it("completes only at the full track", () => {
    const track = 180;
    expect(isComplete(progressOf(offsetFor(0, -179.9, track), track))).toBe(false);
    expect(isComplete(progressOf(offsetFor(0, -180, track), track))).toBe(true);
    expect(isComplete(progressOf(offsetFor(0, -900, track), track))).toBe(true);
  });
});

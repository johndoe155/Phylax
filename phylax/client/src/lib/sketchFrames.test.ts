import { describe, expect, it } from "vitest";
import orderFile from "../assets/phylax-sketch/frame-order-48.txt?raw";
import orderTable from "../assets/phylax-sketch/frame-order-48.csv?raw";
import { HOLD_MS, LOUD, MIN_LOUD_GAP, auditOrder, cleanSketchSvg, parseOrder, quietStarts } from "./sketchFrames";

describe("sketchFrames clock", () => {
  it("holds each drawing for two frames at 24 fps, i.e. 12 drawings a second", () => {
    expect(HOLD_MS).toBeCloseTo(1000 / 12, 6);
  });
});

describe("parseOrder", () => {
  it("reads whitespace-separated drawing numbers", () => {
    expect(parseOrder("01 03 06\n04 02")).toEqual([1, 3, 6, 4, 2]);
  });

  it("tolerates asterisks, commas and # comments", () => {
    expect(parseOrder("01 03* 06,\n# a comment with 99 in it\n04*")).toEqual([1, 3, 6, 4]);
  });

  it("returns nothing for an empty file", () => {
    expect(parseOrder("")).toEqual([]);
  });
});

describe("auditOrder", () => {
  it("rejects playing 1 to 7 in order (loud drawings 3, 4 and 5 touch)", () => {
    const problems = auditOrder([1, 2, 3, 4, 5, 6, 7]);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join("\n")).toContain("back to back");
  });

  it("rejects the same drawing held twice in a row", () => {
    expect(auditOrder([1, 1, 2, 3]).join("\n")).toContain("twice in a row");
  });

  it("rejects a loud drawing that returns too soon", () => {
    // 3 is loud and comes back 2 drawings later; loud and quiet alternate, so only the gap rule fires.
    const problems = auditOrder([3, 1, 3, 2, 4, 6]);
    expect(problems.join("\n")).toContain("loud drawing 3");
    expect(problems.join("\n")).not.toContain("back to back");
  });

  it("treats the order as a loop, so the seam counts", () => {
    // Fine as a list, but the last drawing (loud 7) is followed by the first (loud 3) when it loops.
    expect(auditOrder([3, 1, 5, 2, 7]).join("\n")).toContain("back to back");
  });

  it("needs at least two drawings", () => {
    expect(auditOrder([])).not.toEqual([]);
    expect(auditOrder([1])).not.toEqual([]);
  });
});

describe("quietStarts", () => {
  it("lists only the positions that hold a quiet drawing", () => {
    expect(quietStarts([1, 3, 6, 4, 2, 7])).toEqual([0, 2, 4]);
  });

  it("falls back to every position when nothing is quiet", () => {
    expect(quietStarts([3, 4])).toEqual([0, 1]);
  });
});

describe("the shipped 48-drawing order (assets/phylax-sketch/frame-order-48.txt)", () => {
  const order = parseOrder(orderFile);

  it("has 48 drawings and uses all seven", () => {
    expect(order).toHaveLength(48);
    expect(new Set(order)).toEqual(new Set([1, 2, 3, 4, 5, 6, 7]));
  });

  it("passes every rule, including across the loop seam", () => {
    expect(auditOrder(order)).toEqual([]);
  });

  it("alternates loud and quiet, loud on every second drawing", () => {
    order.forEach((drawing, i) => expect(LOUD.has(drawing)).toBe(i % 2 === 1));
  });

  it("keeps every repeat of a loud drawing at least the minimum apart", () => {
    expect(MIN_LOUD_GAP).toBe(4);
    expect(auditOrder(order, LOUD, MIN_LOUD_GAP)).toEqual([]);
  });

  it("stays valid when a pass starts at any quiet position (every rotation of the loop passes)", () => {
    for (const start of quietStarts(order)) {
      expect(auditOrder(order.slice(start).concat(order.slice(0, start)))).toEqual([]);
    }
  });

  it("matches frame-order-48.csv: same drawings, and the loud/quiet column agrees with LOUD", () => {
    const rows = orderTable.trim().split(/\r?\n/).slice(1).map((line) => line.split(","));
    expect(rows.map((row) => Number(row[1]))).toEqual(order);
    for (const [, variant, , type] of rows) expect(type).toBe(LOUD.has(Number(variant)) ? "loud" : "quiet");
  });
});

describe("cleanSketchSvg", () => {
  const file =
    '<svg xmlns="http://www.w3.org/2000/svg" class="logo-mark" viewBox="0 0 100 100" width="100" height="100" fill="none" ' +
    'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" role="img" aria-label="Phylax logo, sketch variant 4" ' +
    'xmlns:c2pa="http://c2pa.org/manifest"><metadata><c2pa:manifest>AAAWgmp1bWI</c2pa:manifest></metadata>\n' +
    '  <title>Phylax logo, sketch variant 4</title>\n  <defs><filter id="phylax-pencil-4"/></defs>\n  <g filter="url(#phylax-pencil-4)"/>\n</svg>\n';
  const out = cleanSketchSvg(file);

  it("drops the content-credentials metadata and the title", () => {
    expect(out).not.toContain("c2pa");
    expect(out).not.toContain("<metadata");
    expect(out).not.toContain("<title");
  });

  it("drops the class, role, label and size from the root, and marks it decorative", () => {
    const root = out.match(/<svg\b[^>]*>/)![0];
    for (const gone of ["class=", "role=", "aria-label=", ' width="', ' height="']) expect(root).not.toContain(gone);
    expect(root).toContain('aria-hidden="true"');
    expect(root).toContain('focusable="false"');
  });

  it("leaves the drawing itself exactly as drawn", () => {
    const root = out.match(/<svg\b[^>]*>/)![0];
    expect(root).toContain('viewBox="0 0 100 100"');
    expect(root).toContain('stroke="currentColor"');
    expect(root).toContain('stroke-width="1.8"'); // not caught by the width rule
    expect(root).toContain('stroke-linecap="round"');
    expect(out).toContain('<filter id="phylax-pencil-4"/>');
    expect(out.trimEnd().endsWith("</svg>")).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import {
  CSV_UNBOUNDED_LIMIT, IMPORT_MAX_BYTES, csvField, dupKey, exportLimit, fileProblem, makeRequestId, parseImport, rangeError, timesText, toCsv, validateEdit, type StoredShift,
} from "./manageShifts";

const row = { platform: "CareRev", facility: "St. Anne's", date: "2026-11-03", start: "19:00", end: "07:00" };
const shift = (o: Partial<StoredShift> = {}): StoredShift => ({ id: "a", platform: "CareRev", facility: "St. Anne's", label: "Night", date: "2026-11-03", start: 1140, end: 420, ...o });

describe("times", () => {
  it("marks overnight shifts", () => {
    expect(timesText({ start: 1140, end: 420 })).toBe("19:00–07:00 (next day)");
    expect(timesText({ start: 420, end: 1140 })).toBe("07:00–19:00");
  });
});

describe("range", () => {
  it("caps a CSV unless both bounds are set", () => {
    expect(exportLimit({ from: "", to: "" })).toBe(CSV_UNBOUNDED_LIMIT);
    expect(exportLimit({ from: "2026-01-01", to: "" })).toBe(CSV_UNBOUNDED_LIMIT);
    expect(exportLimit({ from: "2026-01-01", to: "2026-02-01" })).toBeNull();
  });
  it("rejects a reversed range", () => expect(rangeError({ from: "2026-02-01", to: "2026-01-01" })).toMatch(/on or before/));
});

describe("csv", () => {
  it("quotes per RFC 4180", () => {
    expect(csvField('a "b", c')).toBe('"a ""b"", c"');
    expect(csvField("two\nlines")).toBe('"two\nlines"');
    expect(csvField("plain")).toBe("plain");
  });
  it("uses CRLF and ends with one", () => {
    const out = toCsv([shift({ notes: "=SUM(1)" })]);
    expect(out.split("\r\n")).toHaveLength(3);
    expect(out).toContain("'=SUM(1)");
    expect(out.endsWith("\r\n")).toBe(true);
  });
});

describe("import", () => {
  it("reads an array and an export", () => {
    expect(parseImport(JSON.stringify([row]))).toMatchObject({ ok: true, format: "array" });
    expect(parseImport(JSON.stringify({ format: "phylax.shifts", version: 1, shifts: [row] }))).toMatchObject({ ok: true, format: "export" });
  });
  it("enforces 1 to 200 rows", () => {
    expect(parseImport("[]")).toMatchObject({ ok: false });
    expect(parseImport(JSON.stringify(Array(201).fill(row)))).toMatchObject({ ok: false });
    expect(parseImport(JSON.stringify(Array(200).fill(row)))).toMatchObject({ ok: true });
  });
  it("reports every bad row", () => {
    const r = parseImport(JSON.stringify([{ ...row, date: "2026-02-30" }, { ...row, start: "7am" }, { ...row, end: "19:00", start: "19:00" }]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toHaveLength(3);
  });
  it("turns away non-JSON and large files before reading", () => {
    expect(fileProblem({ name: "a.csv", type: "text/csv", size: 10 })).toMatch(/JSON/);
    expect(fileProblem({ name: "a.json", type: "application/json", size: IMPORT_MAX_BYTES + 1 })).toMatch(/limit/);
    expect(fileProblem({ name: "a.json", type: "application/json", size: IMPORT_MAX_BYTES })).toBeNull();
  });
  it("matches duplicates ignoring case and spacing", () => expect(dupKey({ ...row, start: 1, end: 2, facility: "  ST.  anne's" })).toBe(dupKey({ ...row, start: 1, end: 2 })));
  it("makes unique request ids", () => expect(makeRequestId()).not.toBe(makeRequestId()));
});

describe("edit form", () => {
  it("requires fields and a real length", () => {
    const e = validateEdit({ platform: "", facility: "", label: "", date: "", start: "07:00", end: "07:00", notes: "" });
    expect(Object.keys(e).sort()).toEqual(["date", "facility", "platform", "times"]);
  });
});

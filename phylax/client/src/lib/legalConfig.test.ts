import { describe, expect, it, vi } from "vitest";
import { UNCONFIGURED, contactHref, fetchLegalConfig, parseLegalConfig } from "./legalConfig";
import { LEGAL_DOCS, RETENTION, docForPath } from "./legalDocs";

describe("parseLegalConfig", () => {
  it("reads a fully configured, approved response", () => {
    expect(parseLegalConfig({ isApproved: true, operatorName: " Acme Health ", contactInformation: "legal@acme.test", jurisdiction: "Delaware, USA" }))
      .toEqual({ approved: true, operator: "Acme Health", contact: "legal@acme.test", jurisdiction: "Delaware, USA" });
  });
  it("accepts alternative spellings", () => {
    expect(parseLegalConfig({ approved: true, operator: "A", contact: "b", legalJurisdiction: "C" })).toEqual({ approved: true, operator: "A", contact: "b", jurisdiction: "C" });
  });
  it("fails closed: only a boolean true approves", () => {
    for (const v of ["true", 1, "yes", null, undefined]) expect(parseLegalConfig({ isApproved: v }).approved).toBe(false);
  });
  it("turns blank or non-string fields into null", () => {
    expect(parseLegalConfig({ isApproved: true, operatorName: "  ", contact: 5, jurisdiction: {} })).toEqual({ approved: true, operator: null, contact: null, jurisdiction: null });
  });
  it("treats non-objects as unconfigured", () => {
    for (const v of [null, undefined, "x", 3, []]) expect(parseLegalConfig(v)).toEqual(UNCONFIGURED);
  });
});

describe("contactHref", () => {
  it("links emails and web addresses only", () => {
    expect(contactHref("a@b.co")).toBe("mailto:a@b.co");
    expect(contactHref("https://acme.test/legal")).toBe("https://acme.test/legal");
    expect(contactHref("javascript:alert(1)")).toBeNull();
    expect(contactHref("1 Main St, Springfield")).toBeNull();
    expect(contactHref(null)).toBeNull();
  });
});

describe("fetchLegalConfig", () => {
  const stub = (impl: () => Promise<unknown>) => vi.stubGlobal("fetch", vi.fn(impl));
  it("returns the parsed config", async () => {
    stub(async () => ({ ok: true, json: async () => ({ isApproved: true, operatorName: "A" }) }));
    expect((await fetchLegalConfig()).approved).toBe(true);
  });
  it("falls back on HTTP errors, network errors and non-JSON bodies", async () => {
    stub(async () => ({ ok: false }));
    expect(await fetchLegalConfig()).toEqual(UNCONFIGURED);
    stub(async () => { throw new TypeError("offline"); });
    expect(await fetchLegalConfig()).toEqual(UNCONFIGURED);
    stub(async () => ({ ok: true, json: async () => { throw new SyntaxError("<!doctype"); } }));
    expect(await fetchLegalConfig()).toEqual(UNCONFIGURED);
  });
  it("rejects when aborted", async () => {
    const ctl = new AbortController();
    stub(async () => { ctl.abort(); throw new DOMException("Aborted", "AbortError"); });
    await expect(fetchLegalConfig(ctl.signal)).rejects.toBeTruthy();
  });
});

describe("legal documents", () => {
  it("picks the document from the path, ignoring case and a trailing slash", () => {
    expect(docForPath("/privacy").kind).toBe("privacy");
    expect(docForPath("/Privacy/").kind).toBe("privacy");
    expect(docForPath("/terms").kind).toBe("terms");
  });
  it("has the required headings and sections", () => {
    expect(LEGAL_DOCS.terms.lines.join(" ")).toBe("Terms of service");
    expect(LEGAL_DOCS.privacy.lines.join(" ")).toBe("Privacy notice");
    expect(LEGAL_DOCS.terms.sections.map((s) => s.title)).toEqual(["Service and responsibility", "Warnings and assumed cutoffs", "Acceptable use and account security", "Availability, termination and disputes"]);
    expect(LEGAL_DOCS.privacy.sections.map((s) => s.title)).toEqual(["Purpose and information processed", "Delivery and infrastructure providers", "Retention and deletion", "Your choices and rights", "Security and incidents"]);
  });
  it("states specific retention periods that contain a number or a time span", () => {
    const retention = LEGAL_DOCS.privacy.sections.find((s) => s.id === "retention-and-deletion")?.retention;
    expect(retention).toBe(RETENTION);
    for (const row of RETENTION) expect(row.period).toMatch(/\d/);
  });
  it("uses unique section ids", () => {
    for (const doc of Object.values(LEGAL_DOCS)) expect(new Set(doc.sections.map((s) => s.id)).size).toBe(doc.sections.length);
  });
});

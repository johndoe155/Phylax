import { describe, expect, it } from "vitest";
import { hashToken, randomToken, safeEqualHex, sign, unsign } from "./tokens.js";

const SECRET = "a-test-secret-that-is-long-enough-to-be-realistic";

describe("signed values", () => {
  it("round-trips a payload", () => {
    const token = sign({ pid: "abc", exp: Date.now() + 1000 }, SECRET);
    expect(unsign(token, SECRET)).toMatchObject({ pid: "abc" });
  });

  it("refuses a payload signed with a different secret", () => {
    const token = sign({ pid: "abc" }, SECRET);
    expect(unsign(token, "a-different-secret-entirely-0123456789")).toBeNull();
  });

  it("refuses a tampered payload", () => {
    const token = sign({ pid: "abc" }, SECRET);
    const [body, mac] = token.split(".");
    const forged = `${Buffer.from(JSON.stringify({ pid: "xyz" })).toString("base64url")}.${mac}`;
    expect(unsign(forged, SECRET)).toBeNull();
    expect(unsign(`${body}.${mac}x`, SECRET)).toBeNull();
    expect(unsign(`${body}x.${mac}`, SECRET)).toBeNull();
    expect(body).not.toBe("");
  });

  it("refuses an expired payload", () => {
    const token = sign({ pid: "abc", exp: Date.now() - 1 }, SECRET);
    expect(unsign(token, SECRET)).toBeNull();
  });

  it("refuses rubbish", () => {
    expect(unsign(undefined, SECRET)).toBeNull();
    expect(unsign("", SECRET)).toBeNull();
    expect(unsign("no-dot-here", SECRET)).toBeNull();
    expect(unsign("a.b", SECRET)).toBeNull();
  });
});

describe("one-time tokens", () => {
  it("hashes the same token to the same value every time", () => {
    expect(hashToken("abc")).toBe(hashToken("abc"));
    expect(hashToken("abc")).not.toBe(hashToken("abd"));
  });

  it("does not contain the token", () => {
    expect(hashToken("a-secret-token")).not.toContain("a-secret-token");
  });

  it("compares hashes without leaking their length through a crash", () => {
    expect(safeEqualHex("aa", "aa")).toBe(true);
    expect(safeEqualHex("aa", "ab")).toBe(false);
    expect(safeEqualHex("aa", "aaaa")).toBe(false);
  });

  it("generates tokens that are long enough to be unguessable", () => {
    const a = randomToken(32);
    const b = randomToken(32);
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(40);
  });
});

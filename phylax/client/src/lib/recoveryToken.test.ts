import { describe, expect, it } from "vitest";
import { isPlausibleToken, parseToken, tokenFromLocation } from "./recoveryToken";

describe("parseToken", () => {
  it("leaves a bare token alone", () => {
    expect(parseToken("  abc123_DEF-456  ")).toEqual({ token: "abc123_DEF-456", fromLink: false });
  });
  it("pulls the token out of a full link", () => {
    expect(parseToken("https://phylax.app/redeem-link?token=abc123XYZ&utm=x")).toEqual({ token: "abc123XYZ", fromLink: true });
  });
  it("handles links wrapped across lines, in brackets or with trailing punctuation", () => {
    expect(parseToken("<https://phylax.app/redeem-link?token=abc\n123XYZ>.").token).toBe("abc123XYZ");
  });
  it("reads the fragment, a scheme-less link and a path token", () => {
    expect(parseToken("https://phylax.app/x#token=frag12345").token).toBe("frag12345");
    expect(parseToken("phylax.app/redeem-link?token=plain1234").token).toBe("plain1234");
    expect(parseToken("https://phylax.app/redeem-link/path12345").token).toBe("path12345");
  });
  it("looks inside a tracking wrapper", () => {
    const inner = encodeURIComponent("https://phylax.app/redeem-link?token=inner12345");
    expect(parseToken(`https://click.mail.example/r?u=${inner}`)).toEqual({ token: "inner12345", fromLink: true });
  });
  it("accepts token=value and decodes percent-encoding", () => {
    expect(parseToken("token=a%2Bb123456").token).toBe("a+b123456");
  });
  it("returns an empty token for nothing", () => {
    expect(parseToken("   ").token).toBe("");
  });
});

describe("isPlausibleToken", () => {
  it("accepts url-safe, hex and JWT-shaped tokens and rejects prose", () => {
    expect(isPlausibleToken("abc123_DEF-456")).toBe(true);
    expect(isPlausibleToken("aaa.bbb.ccc")).toBe(true);
    expect(isPlausibleToken("short")).toBe(false);
    expect(isPlausibleToken("hello world!!")).toBe(false);
  });
});

describe("tokenFromLocation", () => {
  it("reads the query, then the fragment", () => {
    expect(tokenFromLocation("?token=q1234567")).toBe("q1234567");
    expect(tokenFromLocation("", "#token=h1234567")).toBe("h1234567");
    expect(tokenFromLocation("?x=1")).toBe("");
  });
});

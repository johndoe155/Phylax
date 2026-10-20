import { describe, expect, it } from "vitest";
import {
  LEAD_MAX, REAUTH_MINUTES, describeLead, describeUserAgent, formatAgo, formatCountdown, isE164, normalizePhone, parseLeadMinutes,
  reauthRemaining, signInMethodCount, type AccountProfile,
} from "./account";
import { orderTimezones } from "./timezones";

describe("normalizePhone", () => {
  it("strips the spaces, dashes, dots and brackets people type", () => {
    expect(normalizePhone(" +1 (415) 555-0123 ")).toBe("+14155550123");
    expect(normalizePhone("+44.20.7946.0958")).toBe("+442079460958");
  });

  it("keeps the leading plus and leaves digits alone", () => {
    expect(normalizePhone("+14155550123")).toBe("+14155550123");
    expect(normalizePhone("")).toBe("");
  });
});

describe("isE164", () => {
  it("accepts a plus, a non-zero country digit and 7 to 15 digits in all", () => {
    expect(isE164("+14155550123")).toBe(true);
    expect(isE164("+1234567")).toBe(true);
    expect(isE164("+123456789012345")).toBe(true);
  });

  it("rejects a missing plus, a leading zero and the wrong length", () => {
    expect(isE164("14155550123")).toBe(false);
    expect(isE164("+0415555012")).toBe(false);
    expect(isE164("+123456")).toBe(false);
    expect(isE164("+1234567890123456")).toBe(false);
  });

  it("rejects anything that is not digits after the plus", () => {
    expect(isE164("+1415555012x")).toBe(false);
    expect(isE164("+1 415 555 0123")).toBe(false);
    expect(isE164("")).toBe(false);
  });
});

describe("parseLeadMinutes", () => {
  it("reads a whole number in range, ignoring surrounding space", () => {
    expect(parseLeadMinutes("60")).toBe(60);
    expect(parseLeadMinutes("  0 ")).toBe(0);
    expect(parseLeadMinutes(String(LEAD_MAX))).toBe(LEAD_MAX);
  });

  it("returns null above the range", () => {
    expect(parseLeadMinutes(String(LEAD_MAX + 1))).toBeNull();
  });

  it("returns null for anything that is not a plain whole number", () => {
    for (const bad of ["", "  ", "-5", "1.5", "1e3", "abc", "12 min", "+30"]) expect(parseLeadMinutes(bad)).toBeNull();
  });
});

describe("describeLead", () => {
  it("names zero as the start of the shift", () => {
    expect(describeLead(0)).toBe("At the start of the shift");
  });

  it("breaks minutes into days, hours and minutes, leaving out empty parts", () => {
    expect(describeLead(45)).toBe("45 min before");
    expect(describeLead(90)).toBe("1 h 30 min before");
    expect(describeLead(1500)).toBe("1 d 1 h before");
    expect(describeLead(LEAD_MAX)).toBe("7 d before");
  });
});

describe("formatCountdown", () => {
  it("formats milliseconds as m:ss, rounding a part-second up", () => {
    expect(formatCountdown(600_000)).toBe("10:00");
    expect(formatCountdown(61_000)).toBe("1:01");
    expect(formatCountdown(1)).toBe("0:01");
  });

  it("never goes negative", () => {
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(-5000)).toBe("0:00");
  });
});

describe("reauthRemaining", () => {
  const now = Date.parse("2026-10-20T12:00:00.000Z");

  it("is the time left until the window ends", () => {
    expect(reauthRemaining(new Date(now + REAUTH_MINUTES * 60_000).toISOString(), now)).toBe(REAUTH_MINUTES * 60_000);
    expect(reauthRemaining("2026-10-20T12:00:30.000Z", now)).toBe(30_000);
  });

  it("is zero when there is no window, it has passed, or the value is not a date", () => {
    expect(reauthRemaining(null, now)).toBe(0);
    expect(reauthRemaining("2026-10-20T11:59:59.000Z", now)).toBe(0);
    expect(reauthRemaining("soon", now)).toBe(0);
  });
});

describe("signInMethodCount", () => {
  const base: Pick<AccountProfile, "email" | "hasPassword" | "providers" | "passkeys"> = {
    email: { address: null, verified: false },
    hasPassword: false,
    providers: [],
    passkeys: [],
  };
  const passkey = { id: "pk_1", name: "This device", deviceType: "synced" as const, createdAt: "2026-10-19T12:00:00.000Z" };

  it("is zero for an account with nothing to sign in with", () => {
    expect(signInMethodCount(base)).toBe(0);
  });

  it("counts a password only when there is an email to go with it", () => {
    expect(signInMethodCount({ ...base, hasPassword: true })).toBe(0);
    expect(signInMethodCount({ ...base, hasPassword: true, email: { address: "a@b.co", verified: false } })).toBe(1);
  });

  it("counts a verified email as its own method (a sign-in link), an unverified one as none", () => {
    expect(signInMethodCount({ ...base, email: { address: "a@b.co", verified: false } })).toBe(0);
    expect(signInMethodCount({ ...base, email: { address: "a@b.co", verified: true } })).toBe(1);
  });

  it("counts every linked provider and every passkey", () => {
    expect(signInMethodCount({ ...base, providers: ["google", "apple"], passkeys: [passkey, { ...passkey, id: "pk_2" }] })).toBe(4);
  });

  it("adds them all together", () => {
    expect(signInMethodCount({ email: { address: "a@b.co", verified: true }, hasPassword: true, providers: ["google"], passkeys: [passkey] })).toBe(4);
  });
});

describe("describeUserAgent", () => {
  it("names the browser and the system", () => {
    expect(describeUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36")).toBe("Chrome on Windows");
    expect(describeUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1")).toBe("Safari on iOS");
  });

  it("tells Edge from Chrome", () => {
    expect(describeUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0")).toBe("Edge on Windows");
  });

  it("falls back for an empty or unrecognised string", () => {
    expect(describeUserAgent("   ")).toBe("Unknown device");
    expect(describeUserAgent("curl/8.0")).toBe("curl/8.0");
    expect(describeUserAgent("x".repeat(100))).toBe(`${"x".repeat(61)}...`);
  });
});

describe("formatAgo", () => {
  const now = Date.parse("2026-10-20T12:00:00.000Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it("steps from just now through minutes, hours and days", () => {
    expect(formatAgo(ago(10_000), now)).toBe("just now");
    expect(formatAgo(ago(12 * 60_000), now)).toBe("12 min ago");
    expect(formatAgo(ago(3 * 3_600_000), now)).toBe("3 h ago");
    expect(formatAgo(ago(2 * 86_400_000), now)).toBe("2 d ago");
  });

  it("reads an invalid date as an em dash, never as Invalid Date", () => {
    expect(formatAgo("never", now)).toBe("—");
  });
});

describe("orderTimezones", () => {
  const list = ["UTC", "Europe/London", "Africa/Lagos", "America/New_York"];

  it("puts the device zone first, then the saved one, then the rest in the order given", () => {
    expect(orderTimezones(list, "Africa/Lagos", "America/New_York")).toEqual(["Africa/Lagos", "America/New_York", "UTC", "Europe/London"]);
  });

  it("lists each zone once, even when the device and saved zones repeat", () => {
    expect(orderTimezones(list, "UTC", "UTC")).toEqual(["UTC", "Europe/London", "Africa/Lagos", "America/New_York"]);
  });

  it("keeps a zone that is not in the list, so a saved value is never lost from the select", () => {
    expect(orderTimezones(list, null, "Asia/Tokyo")).toEqual(["Asia/Tokyo", ...list]);
  });

  it("skips a missing device or saved zone", () => {
    expect(orderTimezones(list, null, null)).toEqual(list);
    expect(orderTimezones([], null, null)).toEqual([]);
  });
});

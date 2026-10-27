import { describe, expect, it } from "vitest";
import { isLikelySpam, MIN_FILL_MS, rateLimitKey, WaitlistInput } from "../src/waitlist.js";

describe("rateLimitKey", () => {
  it("keys IPv4 by address and normalizes IPv4-mapped IPv6", () => {
    expect(rateLimitKey("203.0.113.7")).toBe("4:203.0.113.7");
    expect(rateLimitKey("::ffff:203.0.113.7")).toBe("4:203.0.113.7");
    expect(rateLimitKey("::FFFF:203.0.113.7")).toBe("4:203.0.113.7");
    expect(rateLimitKey("0:0:0:0:0:ffff:203.0.113.7")).toBe("4:203.0.113.7");
  });

  it("keys IPv6 by its /64 so one client cannot rotate addresses inside its prefix", () => {
    const a = rateLimitKey("2001:db8:1234:5678:aaaa:bbbb:cccc:dddd");
    expect(a).toBe("6:2001:db8:1234:5678::/64");
    expect(rateLimitKey("2001:db8:1234:5678::1")).toBe(a);
    expect(rateLimitKey("2001:0DB8:1234:5678:ffff::")).toBe(a);
    expect(rateLimitKey("[2001:db8:1234:5678::9]")).toBe(a);
    expect(rateLimitKey("2001:db8:1234:5678::9%eth0")).toBe(a);
    expect(rateLimitKey("2001:db8:1234:5679::1")).not.toBe(a); // a different /64
    expect(rateLimitKey("::1")).toBe("6:0:0:0:0::/64");
    expect(rateLimitKey("2001:db8::")).toBe("6:2001:db8:0:0::/64");
  });

  it("rejects garbage", () => {
    for (const bad of [
      undefined,
      null,
      "",
      "not an ip",
      "999.1.1.1",
      "1:2:3",
      "1::2::3",
      "g::1",
      "1:2:3:4:5:6:7:8:9",
    ])
      expect(rateLimitKey(bad as string)).toBeNull();
  });
});

describe("shared waitlist rules", () => {
  it("normalizes email and flags spam signals", () => {
    const v = WaitlistInput.parse({ email: "  Ada@Example.COM ", elapsedMs: 5000 });
    expect(v.email).toBe("ada@example.com");
    expect(isLikelySpam(v)).toBe(false);
    expect(isLikelySpam({ ...v, website: "x" })).toBe(true);
    expect(isLikelySpam({ ...v, elapsedMs: MIN_FILL_MS - 1 })).toBe(true);
  });
});

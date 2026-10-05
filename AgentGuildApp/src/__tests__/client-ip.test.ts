import { describe, it, expect } from "vitest";
import { getClientIp } from "@/lib/client-ip";

const req = (h: Record<string, string>) => ({ headers: new Headers(h) });

describe("getClientIp", () => {
  it("prefers Netlify's platform-set client IP over a client-forged X-Forwarded-For", () => {
    expect(getClientIp(req({ "x-nf-client-connection-ip": "203.0.113.7", "x-forwarded-for": "1.2.3.4, 203.0.113.7" }))).toBe("203.0.113.7");
  });
  it("falls back to X-Forwarded-For, then X-Real-IP, then unknown", () => {
    expect(getClientIp(req({ "x-forwarded-for": "198.51.100.1, 10.0.0.1" }))).toBe("198.51.100.1");
    expect(getClientIp(req({ "x-real-ip": "198.51.100.2" }))).toBe("198.51.100.2");
    expect(getClientIp(req({}))).toBe("unknown");
  });
});

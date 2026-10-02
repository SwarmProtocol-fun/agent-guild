// @vitest-environment node
import { describe, it, expect } from "vitest";
import { endpointError, pickEndpoints } from "../agent-endpoints";

describe("agent endpoints", () => {
  it("accepts https URLs", () => {
    expect(endpointError("mcp", "https://agent.example.com/mcp")).toBeNull();
  });

  it.each([
    ["http://agent.example.com", /https/],
    ["javascript:alert(1)", /https/],
    ["https://user:pw@agent.example.com", /credentials/],
    ["not a url", /absolute URL/],
    [`https://x.com/${"a".repeat(300)}`, /too long/],
  ])("rejects %s", (url, msg) => {
    expect(endpointError("mcp", url)).toMatch(msg);
  });

  it("drops unknown kinds and invalid stored values", () => {
    expect(pickEndpoints({ mcp: "https://a.com/mcp", a2a: "http://b.com", evil: "https://c.com" })).toEqual({ mcp: "https://a.com/mcp" });
    expect(pickEndpoints(null)).toEqual({});
  });
});

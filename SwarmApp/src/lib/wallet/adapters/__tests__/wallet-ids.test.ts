import { describe, it, expect } from "vitest";
import { parseWalletIds } from "../wallet-ids";

const A = "a".repeat(64);
const B = "0123456789abcdef".repeat(4);

describe("parseWalletIds", () => {
  it("returns nothing for unset or empty input", () => {
    expect(parseWalletIds(undefined)).toEqual({ ids: [], invalid: [] });
    expect(parseWalletIds("")).toEqual({ ids: [], invalid: [] });
    expect(parseWalletIds(" , ,")).toEqual({ ids: [], invalid: [] });
  });

  it("parses, trims and lowercases valid ids", () => {
    expect(parseWalletIds(` ${A.toUpperCase()} , ${B} `)).toEqual({ ids: [A, B], invalid: [] });
  });

  it("drops malformed ids and reports them", () => {
    const r = parseWalletIds(`${A},tangem,${"g".repeat(64)},${"a".repeat(63)}`);
    expect(r.ids).toEqual([A]);
    expect(r.invalid).toEqual(["tangem", "g".repeat(64), "a".repeat(63)]);
  });
});

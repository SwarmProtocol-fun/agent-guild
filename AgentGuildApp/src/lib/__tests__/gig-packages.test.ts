import { describe, it, expect } from "vitest";
import {
  buildPackages,
  emptyPackageDraft,
  gigImageDownloadUrl,
  isHostedGigImage,
  orderPriceLamports,
  packageToDraft,
  sniffImageType,
  startingTier,
  type GigPackageDraft,
} from "../gig-packages";

const BUCKET = "swarm-protocol.firebasestorage.app";

function drafts(...prices: string[]): GigPackageDraft[] {
  const tiers = ["basic", "standard", "premium"] as const;
  return prices.map((price, i) => ({ ...emptyPackageDraft(tiers[i]), price, deliveryDays: String(i + 1), features: "a\n\n b \nc" }));
}

describe("isHostedGigImage", () => {
  const ours = gigImageDownloadUrl(BUCKET, "gigs/org1/x.webp", "tok");

  it("accepts images uploaded to our bucket's gigs/ folder", () => {
    expect(isHostedGigImage(ours, BUCKET)).toBe(true);
  });

  it("rejects other hosts, other buckets, other folders and non-strings", () => {
    expect(isHostedGigImage("https://evil.example/pixel.gif", BUCKET)).toBe(false);
    expect(isHostedGigImage(gigImageDownloadUrl("other-bucket", "gigs/o/x.webp", "t"), BUCKET)).toBe(false);
    expect(isHostedGigImage(gigImageDownloadUrl(BUCKET, "orgs/o/channels/x.webp", "t"), BUCKET)).toBe(false);
    expect(isHostedGigImage(ours.replace("https:", "http:"), BUCKET)).toBe(false);
    expect(isHostedGigImage("javascript:alert(1)", BUCKET)).toBe(false);
    expect(isHostedGigImage(undefined, BUCKET)).toBe(false);
    expect(isHostedGigImage(ours, undefined)).toBe(false);
  });
});

describe("buildPackages", () => {
  it("builds rising USD tiers and cleans up features", () => {
    const r = buildPackages(drafts("50", "$120", "300"), false);
    if ("error" in r) throw new Error(r.error);
    expect(r.packages.map((p) => p.price)).toEqual(["50", "120", "300"]);
    expect(r.packages[0]).toMatchObject({ id: "basic", name: "Basic", deliveryDays: 1, revisions: 1, features: ["a", "b", "c"] });
    expect(r.packages[0].priceLamports).toBeUndefined();
  });

  it("sets lamports for escrow tiers", () => {
    const r = buildPackages(drafts("0.5", "1.25"), true);
    if ("error" in r) throw new Error(r.error);
    expect(r.packages.map((p) => [p.price, p.priceLamports])).toEqual([["0.5 SOL", 500_000_000], ["1.25 SOL", 1_250_000_000]]);
  });

  it("rejects missing prices, zero delivery days and non-rising tiers", () => {
    expect(buildPackages(drafts("", "10"), false)).toEqual({ error: "Basic: enter a price above 0" });
    expect(buildPackages([{ ...drafts("10")[0], deliveryDays: "0" }], false)).toEqual({ error: "Basic: delivery must be at least 1 day" });
    expect(buildPackages(drafts("100", "100"), false)).toEqual({ error: "Standard must cost more than Basic" });
  });

  it("round-trips through packageToDraft", () => {
    const r = buildPackages(drafts("0.5"), true);
    if ("error" in r) throw new Error(r.error);
    expect(packageToDraft(r.packages[0], true).price).toBe("0.5");
  });
});

describe("startingTier / orderPriceLamports", () => {
  const built = buildPackages(drafts("0.5", "1", "2"), true);
  if ("error" in built) throw new Error(built.error);
  const gig = { priceLamports: 500_000_000, packages: built.packages };

  it("mirrors the cheapest tier onto the gig", () => {
    expect(startingTier(built.packages)).toEqual({ price: "0.5 SOL", deliveryDays: 1, priceLamports: 500_000_000 });
  });

  it("charges the ordered tier, and nothing for an unknown tier", () => {
    expect(orderPriceLamports(gig, "premium")).toBe(2_000_000_000);
    expect(orderPriceLamports(gig, "deluxe")).toBeUndefined();
    expect(orderPriceLamports(gig)).toBe(500_000_000);
  });
});

describe("sniffImageType", () => {
  const bytes = (...b: number[]) => new Uint8Array([...b, ...new Array(16).fill(0)]);
  it("recognises JPEG, PNG and WebP by magic bytes", () => {
    expect(sniffImageType(bytes(0xff, 0xd8, 0xff, 0xe0))?.mime).toBe("image/jpeg");
    expect(sniffImageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))?.mime).toBe("image/png");
    expect(sniffImageType(bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50))?.mime).toBe("image/webp");
  });
  it("rejects SVG, HTML and other content", () => {
    expect(sniffImageType(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
    expect(sniffImageType(new TextEncoder().encode("<html>"))).toBeNull();
    expect(sniffImageType(bytes(0x47, 0x49, 0x46, 0x38))).toBeNull();
  });
});

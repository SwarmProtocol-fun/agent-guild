import { describe, it, expect } from "vitest";
import {
  estimateProviderHourlyCost,
  estimateHourlyCost,
  estimateMonthlyCost,
} from "../pricing";
import {
  PROVIDER_SIZE_MAP,
  PROVIDER_REGION_MAP,
  PROVIDER_BASE_IMAGES,
  PROVIDER_HOURLY_COSTS,
  PROVIDER_LABELS,
} from "../types";
import type { ProviderKey, SizeKey, Region } from "../types";
import { getComputeProvider, StubComputeProvider } from "../provider";

// ═══════════════════════════════════════════════════════════════
// Provider Mapping Constants
// ═══════════════════════════════════════════════════════════════

const ALL_PROVIDERS: ProviderKey[] = ["e2b", "aws", "gcp", "azure", "stub"];
const ALL_SIZES: SizeKey[] = ["small", "medium", "large", "xl"];
const ALL_REGIONS: Region[] = ["us-east", "us-west", "eu-west", "ap-southeast"];

describe("PROVIDER_SIZE_MAP", () => {
  it("has entries for all cloud providers", () => {
    expect(PROVIDER_SIZE_MAP.aws).toBeDefined();
    expect(PROVIDER_SIZE_MAP.gcp).toBeDefined();
    expect(PROVIDER_SIZE_MAP.azure).toBeDefined();
  });

  it("maps all sizes for each provider", () => {
    for (const provider of ["aws", "gcp", "azure"] as const) {
      for (const size of ALL_SIZES) {
        expect(PROVIDER_SIZE_MAP[provider][size]).toBeTruthy();
      }
    }
  });

  it("uses valid AWS instance types", () => {
    expect(PROVIDER_SIZE_MAP.aws.small).toMatch(/^t3\./);
    expect(PROVIDER_SIZE_MAP.aws.xl).toMatch(/^m5\./);
  });

  it("uses valid GCP machine types", () => {
    expect(PROVIDER_SIZE_MAP.gcp.small).toMatch(/^e2-/);
  });

  it("uses valid Azure VM sizes", () => {
    expect(PROVIDER_SIZE_MAP.azure.small).toMatch(/^Standard_/);
  });
});

describe("PROVIDER_REGION_MAP", () => {
  it("maps all regions for each provider", () => {
    for (const provider of ["aws", "gcp", "azure"] as const) {
      for (const region of ALL_REGIONS) {
        expect(PROVIDER_REGION_MAP[provider][region]).toBeTruthy();
      }
    }
  });

  it("maps us-east to correct native regions", () => {
    expect(PROVIDER_REGION_MAP.aws["us-east"]).toBe("us-east-1");
    expect(PROVIDER_REGION_MAP.gcp["us-east"]).toBe("us-east1");
    expect(PROVIDER_REGION_MAP.azure["us-east"]).toBe("eastus");
  });
});

describe("PROVIDER_BASE_IMAGES", () => {
  it("has a base image for each cloud provider", () => {
    expect(PROVIDER_BASE_IMAGES.aws).toBeTruthy();
    expect(PROVIDER_BASE_IMAGES.gcp).toBeTruthy();
    expect(PROVIDER_BASE_IMAGES.azure).toBeTruthy();
  });

  it("AWS uses an AMI ID format", () => {
    expect(PROVIDER_BASE_IMAGES.aws).toMatch(/^ami-/);
  });
});

describe("PROVIDER_LABELS", () => {
  it("has labels for all providers", () => {
    for (const key of ALL_PROVIDERS) {
      expect(PROVIDER_LABELS[key]).toBeDefined();
      expect(PROVIDER_LABELS[key].label).toBeTruthy();
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// Provider-Specific Billing
// ═══════════════════════════════════════════════════════════════

describe("Provider-specific billing", () => {
  it("PROVIDER_HOURLY_COSTS has entries for all providers", () => {
    for (const provider of ALL_PROVIDERS) {
      expect(PROVIDER_HOURLY_COSTS[provider]).toBeDefined();
    }
  });

  it("each provider has costs for all sizes", () => {
    for (const provider of ALL_PROVIDERS) {
      for (const size of ALL_SIZES) {
        expect(PROVIDER_HOURLY_COSTS[provider][size]).toBeGreaterThan(0);
      }
    }
  });

  it("estimateProviderHourlyCost returns provider-specific costs", () => {
    const e2bSmall = estimateProviderHourlyCost("small", "e2b");
    const awsSmall = estimateProviderHourlyCost("small", "aws");
    const gcpSmall = estimateProviderHourlyCost("small", "gcp");
    const azureSmall = estimateProviderHourlyCost("small", "azure");

    // All should be positive
    expect(e2bSmall).toBeGreaterThan(0);
    expect(awsSmall).toBeGreaterThan(0);
    expect(gcpSmall).toBeGreaterThan(0);
    expect(azureSmall).toBeGreaterThan(0);
  });

  it("estimateHourlyCost applies markup per provider", () => {
    const e2bHourly = estimateHourlyCost("medium", undefined, "e2b");
    const awsHourly = estimateHourlyCost("medium", undefined, "aws");

    // Both should apply 30% default markup
    const e2bRaw = estimateProviderHourlyCost("medium", "e2b");
    const awsRaw = estimateProviderHourlyCost("medium", "aws");
    expect(e2bHourly).toBe(Math.ceil(e2bRaw * 1.3));
    expect(awsHourly).toBe(Math.ceil(awsRaw * 1.3));
  });

  it("estimateMonthlyCost reflects provider pricing", () => {
    const awsMonthly = estimateMonthlyCost("large", 8, undefined, "aws");
    const awsHourly = estimateHourlyCost("large", undefined, "aws");
    expect(awsMonthly).toBe(awsHourly * 8 * 30);
  });

  it("larger sizes cost more across all providers", () => {
    for (const provider of ALL_PROVIDERS) {
      const costs = ALL_SIZES.map((s) => estimateProviderHourlyCost(s, provider));
      for (let i = 1; i < costs.length; i++) {
        expect(costs[i]).toBeGreaterThanOrEqual(costs[i - 1]);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// Provider Factory
// ═══════════════════════════════════════════════════════════════

describe("getComputeProvider", () => {
  it("returns stub provider by default", () => {
    const provider = getComputeProvider("stub");
    expect(provider).toBeInstanceOf(StubComputeProvider);
    expect(provider.name).toBe("stub");
  });

  it("returns the same instance for repeated calls with same key", () => {
    const a = getComputeProvider("stub");
    const b = getComputeProvider("stub");
    expect(a).toBe(b);
  });
});

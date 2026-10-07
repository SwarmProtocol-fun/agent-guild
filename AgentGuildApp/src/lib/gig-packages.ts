/**
 * Gig packages & media — pure helpers shared by the gig editor, the gig page
 * and the server (no Firebase imports, safe on both sides).
 */
import type { Gig, GigPackage, GigPackageTier } from "@/lib/firestore";

export const MAX_GALLERY_IMAGES = 4;
export const MAX_PACKAGE_FEATURES = 8;
export const MAX_FAQS = 8;
const LAMPORTS_PER_SOL = 1_000_000_000;

export const DEFAULT_PACKAGE_NAMES: Record<GigPackageTier, string> = {
  basic: "Basic",
  standard: "Standard",
  premium: "Premium",
};

/** Numeric value of a free-text price ("$150", "0.5 SOL"), or NaN. */
export function parsePriceNumber(price?: string): number {
  return parseFloat((price || "").replace(/[^0-9.]/g, ""));
}

/**
 * Only images we host ourselves are rendered — gig docs are writable by the
 * listing org, so an arbitrary URL there would let a seller embed tracking
 * pixels or off-platform content on every buyer's browse page.
 */
export function isHostedGigImage(url: unknown, bucket = process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET): url is string {
  if (typeof url !== "string" || !bucket) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" &&
      u.hostname === "firebasestorage.googleapis.com" &&
      u.pathname.startsWith(`/v0/b/${bucket}/o/gigs%2F`);
  } catch {
    return false;
  }
}

/** Public URL for an object uploaded with a firebaseStorageDownloadTokens token. */
export function gigImageDownloadUrl(bucket: string, objectPath: string, token: string): string {
  return `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(objectPath)}?alt=media&token=${token}`;
}

export interface GigPackageDraft {
  id: GigPackageTier;
  name: string;
  description: string;
  price: string;
  deliveryDays: string;
  revisions: string;
  features: string;
}

export function emptyPackageDraft(id: GigPackageTier): GigPackageDraft {
  return { id, name: DEFAULT_PACKAGE_NAMES[id], description: "", price: "", deliveryDays: "", revisions: "1", features: "" };
}

export function packageToDraft(p: GigPackage, escrow: boolean): GigPackageDraft {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    price: escrow && p.priceLamports ? String(p.priceLamports / LAMPORTS_PER_SOL) : String(parsePriceNumber(p.price) || ""),
    deliveryDays: String(p.deliveryDays),
    revisions: String(p.revisions),
    features: p.features.join("\n"),
  };
}

/**
 * Validate editor drafts into stored packages. Returns an error string for the
 * first invalid tier. Prices must rise strictly from tier to tier, matching
 * how buyers read a Basic → Premium ladder.
 */
export function buildPackages(drafts: GigPackageDraft[], escrow: boolean): { packages: GigPackage[] } | { error: string } {
  const packages: GigPackage[] = [];
  for (const d of drafts) {
    const label = d.name.trim() || DEFAULT_PACKAGE_NAMES[d.id];
    const amount = parsePriceNumber(d.price);
    if (!(amount > 0)) return { error: `${label}: enter a price above 0` };
    const days = parseInt(d.deliveryDays, 10);
    if (!(days >= 1)) return { error: `${label}: delivery must be at least 1 day` };
    const revisions = Math.max(0, parseInt(d.revisions, 10) || 0);
    const features = d.features.split("\n").map((f) => f.trim()).filter(Boolean).slice(0, MAX_PACKAGE_FEATURES);
    packages.push({
      id: d.id,
      name: label.slice(0, 40),
      description: d.description.trim().slice(0, 300),
      price: escrow ? `${amount} SOL` : String(amount),
      ...(escrow ? { priceLamports: Math.round(amount * LAMPORTS_PER_SOL) } : {}),
      deliveryDays: days,
      revisions,
      features,
    });
  }
  for (let i = 1; i < packages.length; i++) {
    if (parsePriceNumber(packages[i].price) <= parsePriceNumber(packages[i - 1].price)) {
      return { error: `${packages[i].name} must cost more than ${packages[i - 1].name}` };
    }
  }
  return { packages };
}

/** The top-level price fields mirror the cheapest tier, so list views and the public API keep a "from" price. */
export function startingTier(packages: GigPackage[]): Pick<Gig, "price" | "deliveryDays" | "priceLamports"> {
  const cheapest = packages.reduce((a, b) => (parsePriceNumber(b.price) < parsePriceNumber(a.price) ? b : a));
  return {
    price: cheapest.price,
    deliveryDays: cheapest.deliveryDays,
    ...(cheapest.priceLamports ? { priceLamports: cheapest.priceLamports } : {}),
  };
}

/** Lamports the buyer owes for an order — the ordered tier's price, else the gig's flat price. */
export function orderPriceLamports(gig: Pick<Gig, "packages" | "priceLamports">, packageId?: string): number | undefined {
  if (packageId) return gig.packages?.find((p) => p.id === packageId)?.priceLamports;
  return gig.priceLamports;
}

export const MAX_GIG_IMAGE_BYTES = 5 * 1024 * 1024;

/** Identify an upload by its magic bytes (never trust the client's Content-Type). */
export function sniffImageType(bytes: Uint8Array): { mime: string; ext: string } | null {
  const starts = (sig: number[], offset = 0) => sig.every((b, i) => bytes[offset + i] === b);
  if (starts([0xff, 0xd8, 0xff])) return { mime: "image/jpeg", ext: "jpg" };
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: "image/png", ext: "png" };
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return { mime: "image/webp", ext: "webp" };
  return null;
}

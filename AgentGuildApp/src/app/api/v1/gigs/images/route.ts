/**
 * POST /api/v1/gigs/images — upload a gig cover or gallery image.
 *
 * Goes through the Admin SDK rather than a browser upload so the server
 * decides what's stored: the file type is sniffed from its bytes (JPEG, PNG
 * or WebP only), size is capped, and the object path is fixed under
 * gigs/{orgId}/ — which is also the only place lib/gig-packages.ts's
 * isHostedGigImage() will render an image from.
 *
 * Auth: session (x-wallet-address), member of `orgId`
 * Body: multipart/form-data { file: File, orgId: string }
 * Returns: { url }
 */
import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { requireOrgMember } from "@/lib/auth-guard";
import { adminBucket, adminBucketName } from "@/lib/firebase-admin";
import { rateLimit } from "@/app/api/v1/rate-limit";
import { MAX_GIG_IMAGE_BYTES, gigImageDownloadUrl, sniffImageType } from "@/lib/gig-packages";

export async function POST(req: NextRequest) {
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  const orgId = form?.get("orgId");
  if (typeof orgId !== "string" || !orgId) return Response.json({ error: "orgId is required" }, { status: 400 });
  if (!(file instanceof File)) return Response.json({ error: "file is required" }, { status: 400 });

  const auth = await requireOrgMember(req, orgId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status ?? 403 });

  const limited = await rateLimit(`gig-image:${auth.walletAddress}`);
  if (limited) return limited;

  if (file.size > MAX_GIG_IMAGE_BYTES) {
    return Response.json({ error: "Image must be 5 MB or smaller" }, { status: 413 });
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = sniffImageType(bytes);
  if (!type) return Response.json({ error: "Only JPEG, PNG or WebP images are allowed" }, { status: 415 });

  const bucketName = adminBucketName();
  if (!bucketName) return Response.json({ error: "Image storage is not configured" }, { status: 503 });

  const objectPath = `gigs/${orgId}/${randomUUID()}.${type.ext}`;
  const token = randomUUID();
  try {
    await adminBucket().file(objectPath).save(Buffer.from(bytes), {
      resumable: false,
      contentType: type.mime,
      metadata: {
        cacheControl: "public, max-age=31536000, immutable",
        metadata: { firebaseStorageDownloadTokens: token, uploadedBy: auth.walletAddress ?? "" },
      },
    });
  } catch (err) {
    console.error("Gig image upload failed:", err);
    return Response.json({ error: "Upload failed" }, { status: 500 });
  }

  return Response.json({ url: gigImageDownloadUrl(bucketName, objectPath, token) });
}

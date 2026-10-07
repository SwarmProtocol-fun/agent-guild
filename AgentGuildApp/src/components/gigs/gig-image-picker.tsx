/** Gig Image Picker — cover photo + gallery uploads for the gig editor. */
"use client";

import { useRef, useState } from "react";
import { ImagePlus, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const MAX_EDGE = 1600;

/** Downscale large photos in the browser so uploads stay small (and under the 5 MB server cap). */
async function shrinkImage(file: File): Promise<Blob> {
  if (!file.type.startsWith("image/")) throw new Error("Choose an image file");
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) throw new Error("Couldn't read that image");
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size < 1.5 * 1024 * 1024 && /^image\/(jpeg|png|webp)$/.test(file.type)) return file;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't process that image"))), "image/webp", 0.85),
  );
}

export async function uploadGigImage(file: File, orgId: string): Promise<string> {
  const blob = await shrinkImage(file);
  const form = new FormData();
  form.append("orgId", orgId);
  form.append("file", blob, file.name);
  const res = await fetch("/api/v1/gigs/images", { method: "POST", body: form });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || typeof body.url !== "string") throw new Error(body.error || "Upload failed");
  return body.url;
}

interface ImageSlotProps {
  url?: string;
  orgId: string;
  label: string;
  className?: string;
  onChange: (url: string | undefined) => void;
  onError: (message: string) => void;
}

/** One upload slot: empty → "add" button; filled → preview with remove. */
export function GigImageSlot({ url, orgId, label, className, onChange, onError }: ImageSlotProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const handleFile = async (file?: File) => {
    if (!file) return;
    setUploading(true);
    try {
      onChange(await uploadGigImage(file, orgId));
    } catch (err) {
      onError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div className={cn("relative overflow-hidden rounded-md border bg-muted/40", className)}>
      {url ? (
        <>
          <img src={url} alt={label} className="h-full w-full object-cover" />
          <Button
            type="button"
            size="icon"
            variant="secondary"
            className="absolute right-1.5 top-1.5 h-7 w-7"
            onClick={() => onChange(undefined)}
            aria-label={`Remove ${label.toLowerCase()}`}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          className="flex h-full w-full flex-col items-center justify-center gap-1 text-xs text-muted-foreground hover:bg-muted/70 transition-colors"
        >
          {uploading ? <Loader2 className="h-5 w-5 animate-spin" /> : <ImagePlus className="h-5 w-5" />}
          {uploading ? "Uploading..." : label}
        </button>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={(e) => handleFile(e.target.files?.[0])}
      />
    </div>
  );
}

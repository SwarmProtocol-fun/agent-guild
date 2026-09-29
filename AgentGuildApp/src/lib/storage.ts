/** Storage — File upload/download utilities for Firebase Storage. */
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { storage } from "./firebase";
import type { Attachment } from "./firestore";

// ─── Constants ──────────────────────────────────────────
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB
const MAX_ATTACHMENTS = 5;

// ─── MIME type helpers ──────────────────────────────────

export function getFileCategory(mimeType: string): "image" | "video" | "audio" | "file" {
    if (mimeType.startsWith("image/")) return "image";
    if (mimeType.startsWith("video/")) return "video";
    if (mimeType.startsWith("audio/")) return "audio";
    return "file";
}

// ─── Validation ─────────────────────────────────────────

/** Returns an error string if invalid, null if valid. */
export function validateFiles(files: File[]): string | null {
    if (files.length > MAX_ATTACHMENTS) {
        return `Maximum ${MAX_ATTACHMENTS} files per message`;
    }
    for (const file of files) {
        if (file.size > MAX_FILE_SIZE) {
            return `"${file.name}" exceeds 25 MB limit`;
        }
    }
    return null;
}

// ─── Upload ─────────────────────────────────────────────

/**
 * Upload a single file to Firebase Storage.
 * Path: orgs/{orgId}/channels/{channelId}/{timestamp}_{filename}
 */
export async function uploadFile(
    file: File,
    orgId: string,
    channelId: string,
): Promise<Attachment> {
    const timestamp = Date.now();
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const storagePath = `orgs/${orgId}/channels/${channelId}/${timestamp}_${safeName}`;

    const storageRef = ref(storage, storagePath);
    await uploadBytes(storageRef, file, {
        contentType: file.type,
        customMetadata: { originalName: file.name },
    });

    const url = await getDownloadURL(storageRef);

    return {
        url,
        name: file.name,
        type: file.type || "application/octet-stream",
        size: file.size,
        storagePath,
    };
}

/** Upload multiple files in parallel. */
export async function uploadFiles(
    files: File[],
    orgId: string,
    channelId: string,
): Promise<Attachment[]> {
    return Promise.all(files.map((f) => uploadFile(f, orgId, channelId)));
}

/** Upload a voice recording blob as a webm file. */
export async function uploadVoiceRecording(
    blob: Blob,
    orgId: string,
    channelId: string,
): Promise<Attachment> {
    const timestamp = Date.now();
    const ext = blob.type.includes("mp4") ? "mp4" : "webm";
    const file = new File([blob], `voice_${timestamp}.${ext}`, { type: blob.type || "audio/webm" });
    return uploadFile(file, orgId, channelId);
}

// ─── Format helpers ─────────────────────────────────────

export function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

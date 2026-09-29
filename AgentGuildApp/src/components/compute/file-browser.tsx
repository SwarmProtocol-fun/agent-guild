"use client";

import { useState, useEffect } from "react";
import { FileText, Trash2, Upload, Download } from "lucide-react";
import type { ComputeFile } from "@/lib/compute/types";

interface FileBrowserProps {
  workspaceId: string;
  computerId?: string;
}

export function FileBrowser({ workspaceId, computerId }: FileBrowserProps) {
  const [files, setFiles] = useState<ComputeFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    setError("");
    const url = `/api/compute/files?workspaceId=${workspaceId}${computerId ? `&computerId=${computerId}` : ""}`;
    fetch(url)
      .then((r) => r.json())
      .then((data) => { if (data.ok) setFiles(data.files || []); })
      .catch((err) => setError(err.message || "Failed to load files"))
      .finally(() => setLoading(false));
  }, [workspaceId, computerId]);

  const handleDelete = async (id: string) => {
    const res = await fetch(`/api/compute/files/${id}`, { method: "DELETE" });
    if (res.ok) setFiles((prev) => prev.filter((f) => f.id !== id));
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  if (loading) {
    return <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">Loading files...</div>;
  }

  if (error) {
    return <div className="flex h-40 items-center justify-center text-sm text-red-400">{error}</div>;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{files.length} file{files.length !== 1 ? "s" : ""}</h3>
        <button className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted transition-colors">
          <Upload className="h-3.5 w-3.5" />
          Upload
        </button>
      </div>

      {files.length === 0 ? (
        <div className="flex h-32 items-center justify-center rounded-lg border border-dashed border-border">
          <p className="text-sm text-muted-foreground">No files yet</p>
        </div>
      ) : (
        <div className="divide-y divide-border rounded-lg border border-border">
          {files.map((file) => (
            <div key={file.id} className="flex items-center justify-between px-3 py-2">
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">{file.filename}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatSize(file.sizeBytes)} · {file.visibility}
                  </p>
                </div>
              </div>
              <div className="flex gap-1">
                <button
                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                  title="Download"
                >
                  <Download className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => handleDelete(file.id)}
                  className="rounded p-1 text-muted-foreground hover:bg-red-500/10 hover:text-red-400 transition-colors"
                  title="Delete"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

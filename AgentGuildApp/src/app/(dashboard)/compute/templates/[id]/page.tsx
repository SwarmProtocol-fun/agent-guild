"use client";

import { useState, useEffect, use } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, Rocket } from "lucide-react";
import type { ComputeTemplate } from "@/lib/compute/types";
import { TEMPLATE_CATEGORY_LABELS, MODEL_LABELS } from "@/lib/compute/types";

export default function TemplateDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [template, setTemplate] = useState<ComputeTemplate | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    setError("");
    fetch(`/api/compute/templates/${id}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.ok) setTemplate(data.template);
        else setError(data.error || "Template not found");
      })
      .catch((err) => setError(err.message || "Failed to load template"))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  if (error || !template) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2 p-6">
        <p className="text-sm text-red-400">{error || "Template not found"}</p>
        <Link href="/compute/templates" className="mt-2 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted">Back to Templates</Link>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <Link href="/compute/templates" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mb-2">
          <ChevronLeft className="h-3 w-3" />
          Templates
        </Link>
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold">{template.name}</h1>
            <p className="text-sm text-muted-foreground mt-1">{template.description}</p>
          </div>
          <button
            onClick={() => router.push(`/compute/computers/new?templateId=${id}`)}
            className="flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Rocket className="h-4 w-4" />
            Launch
          </button>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-lg border border-border p-4">
          <h3 className="text-sm font-medium mb-2">Details</h3>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Category</dt>
              <dd>{TEMPLATE_CATEGORY_LABELS[template.category]}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Base Image</dt>
              <dd className="font-mono text-xs">{template.baseImage}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Public</dt>
              <dd>{template.isPublic ? "Yes" : "No"}</dd>
            </div>
          </dl>
        </div>

        <div className="rounded-lg border border-border p-4">
          <h3 className="text-sm font-medium mb-2">Recommended Models</h3>
          {template.recommendedModels.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {template.recommendedModels.map((m) => (
                <span key={m} className="rounded-full bg-muted px-2.5 py-0.5 text-xs">{MODEL_LABELS[m].label}</span>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Any model</p>
          )}
        </div>
      </div>

      {template.startupScript && (
        <div className="rounded-lg border border-border p-4">
          <h3 className="text-sm font-medium mb-2">Startup Script</h3>
          <pre className="rounded bg-muted p-3 text-xs overflow-x-auto">
            <code>{template.startupScript}</code>
          </pre>
        </div>
      )}

      {template.requiredSecrets.length > 0 && (
        <div className="rounded-lg border border-border p-4">
          <h3 className="text-sm font-medium mb-2">Required Secrets</h3>
          <div className="flex flex-wrap gap-2">
            {template.requiredSecrets.map((s) => (
              <span key={s} className="rounded bg-amber-500/10 px-2 py-0.5 text-xs text-amber-400 font-mono">
                {s}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

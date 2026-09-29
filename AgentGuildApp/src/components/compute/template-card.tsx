"use client";

import { TEMPLATE_CATEGORY_LABELS, type ComputeTemplate } from "@/lib/compute/types";

interface TemplateCardProps {
  template: ComputeTemplate;
  onLaunch?: () => void;
}

export function TemplateCard({ template, onLaunch }: TemplateCardProps) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 transition-all hover:border-muted-foreground/50 hover:shadow-lg">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="font-semibold text-sm">{template.name}</h3>
          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
            {template.description}
          </p>
        </div>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          {TEMPLATE_CATEGORY_LABELS[template.category]}
        </span>
      </div>

      <div className="mt-3 flex items-center justify-between">
        <div className="flex gap-1">
          {template.recommendedModels.map((m) => (
            <span key={m} className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {m}
            </span>
          ))}
        </div>
        {onLaunch && (
          <button
            onClick={onLaunch}
            className="rounded-md bg-primary/10 px-3 py-1 text-xs font-medium text-primary hover:bg-primary/20 transition-colors"
          >
            Launch
          </button>
        )}
      </div>
    </div>
  );
}

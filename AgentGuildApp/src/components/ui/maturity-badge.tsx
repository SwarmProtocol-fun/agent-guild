/**
 * Maturity Badge — Truth-in-the-interface status indicators
 *
 * Shows the production readiness of features.
 * Never hide the truth from operators.
 */
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Check, AlertTriangle, FlaskConical, Sparkles } from "lucide-react";

export type MaturityLevel =
  | "production"   // Battle-tested, full support, documented
  | "beta"         // Functional but may have rough edges
  | "experimental" // Working prototype, expect changes
  | "planned";     // Defined but not implemented

interface MaturityBadgeProps {
  level: MaturityLevel;
  className?: string;
  showIcon?: boolean;
}

const MATURITY_CONFIG: Record<
  MaturityLevel,
  { label: string; variant: "default" | "secondary" | "outline" | "destructive"; className: string; icon: typeof Check }
> = {
  production: {
    label: "Production",
    variant: "default",
    className: "bg-emerald-500/10 text-emerald-600 border-emerald-500/20 hover:bg-emerald-500/20",
    icon: Check,
  },
  beta: {
    label: "Beta",
    variant: "secondary",
    className: "bg-amber-500/10 text-amber-600 border-amber-500/20 hover:bg-amber-500/20",
    icon: Sparkles,
  },
  experimental: {
    label: "Experimental",
    variant: "outline",
    className: "bg-purple-500/10 text-purple-600 border-purple-500/20 hover:bg-purple-500/20",
    icon: FlaskConical,
  },
  planned: {
    label: "Planned",
    variant: "outline",
    className: "bg-muted text-muted-foreground border-border hover:bg-muted/80",
    icon: AlertTriangle,
  },
};

export function MaturityBadge({ level, className, showIcon = false }: MaturityBadgeProps) {
  const config = MATURITY_CONFIG[level];
  const Icon = config.icon;

  return (
    <Badge
      variant={config.variant}
      className={cn("text-[10px] font-medium px-1.5 py-0.5", config.className, className)}
    >
      {showIcon && <Icon className="h-2.5 w-2.5 mr-1" />}
      {config.label}
    </Badge>
  );
}

/**
 * Inline maturity indicator for feature descriptions
 */
export function MaturityIndicator({ level, description }: { level: MaturityLevel; description?: string }) {
  return (
    <div className="inline-flex items-center gap-2">
      <MaturityBadge level={level} showIcon />
      {description && <span className="text-xs text-muted-foreground">{description}</span>}
    </div>
  );
}

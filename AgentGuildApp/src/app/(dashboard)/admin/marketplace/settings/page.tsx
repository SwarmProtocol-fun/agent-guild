"use client";

import { useState, useEffect, useCallback } from "react";
import {
  ShieldAlert, Loader2, RefreshCw, Settings2, Plus, X, Check,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSession } from "@/contexts/SessionContext";
import { isPlatformAdmin } from "@/lib/platform-admins";

interface MarketplaceSettings {
  autoApproveForTier: number;
  maxQueueAgeDays: number;
  deadProductDays: number;
  lowQualityRating: number;
  minRatingsForQualityCheck: number;
  autoSuspendReportCount: number;
  maxFeaturedItems: number;
  featuredRotationDays: number;
  requireDemoUrl: boolean;
  requireScreenshots: boolean;
  allowedCategories: string[];
  blockedKeywords: string[];
  platformFeePercent: number;
  minPayoutAmount: number;
  payoutSchedule: string;
}

export default function SettingsPage() {
  const { address: sessionAddress, authenticated } = useSession();
  const isAdmin = isPlatformAdmin(sessionAddress);

  const [settings, setSettings] = useState<MarketplaceSettings | null>(null);
  const [draft, setDraft] = useState<Partial<MarketplaceSettings>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [newCategory, setNewCategory] = useState("");
  const [newKeyword, setNewKeyword] = useState("");

  const fetchSettings = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/marketplace/settings");
      if (res.ok) {
        const d = await res.json();
        setSettings(d.settings);
        setDraft(d.settings);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isAdmin) fetchSettings();
  }, [isAdmin, fetchSettings]);

  function updateDraft<K extends keyof MarketplaceSettings>(key: K, value: MarketplaceSettings[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  async function saveSection(sectionName: string, fields: (keyof MarketplaceSettings)[]) {
    setSaving(sectionName);
    const partial: Partial<MarketplaceSettings> = {};
    for (const f of fields) {
      if (draft[f] !== undefined) (partial as Record<string, unknown>)[f] = draft[f];
    }
    try {
      const res = await fetch("/api/admin/marketplace/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: partial }),
      });
      if (res.ok) {
        const d = await res.json();
        setSettings(d.settings);
        setDraft(d.settings);
      }
    } finally {
      setSaving(null);
    }
  }

  function addCategory() {
    const val = newCategory.trim();
    if (!val) return;
    const current = (draft.allowedCategories || []) as string[];
    if (!current.includes(val)) {
      updateDraft("allowedCategories", [...current, val]);
    }
    setNewCategory("");
  }

  function removeCategory(cat: string) {
    updateDraft("allowedCategories", ((draft.allowedCategories || []) as string[]).filter((c) => c !== cat));
  }

  function addKeyword() {
    const val = newKeyword.trim();
    if (!val) return;
    const current = (draft.blockedKeywords || []) as string[];
    if (!current.includes(val)) {
      updateDraft("blockedKeywords", [...current, val]);
    }
    setNewKeyword("");
  }

  function removeKeyword(kw: string) {
    updateDraft("blockedKeywords", ((draft.blockedKeywords || []) as string[]).filter((k) => k !== kw));
  }

  if (!authenticated) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <p className="text-muted-foreground">Connect your wallet to continue.</p>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="flex flex-col items-center justify-center h-[60vh] gap-3">
        <ShieldAlert className="h-12 w-12 text-red-400" />
        <h2 className="text-lg font-semibold">Access Denied</h2>
        <p className="text-sm text-muted-foreground">Platform admin wallet required.</p>
      </div>
    );
  }

  if (loading || !settings) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Settings2 className="h-6 w-6 text-amber-400" />
          <h1 className="text-2xl font-bold">Marketplace Settings</h1>
        </div>
        <Button variant="outline" size="sm" onClick={fetchSettings} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Review Pipeline */}
      <SettingsSection
        title="Review Pipeline"
        saving={saving === "review"}
        onSave={() => saveSection("review", ["autoApproveForTier", "maxQueueAgeDays"])}
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <FieldGroup label="Auto-approve for tier >=" hint="Tier 3 = Strategic Partner">
            <input
              type="number"
              min={0}
              max={3}
              value={draft.autoApproveForTier ?? ""}
              onChange={(e) => updateDraft("autoApproveForTier", Number(e.target.value))}
              className="h-8 w-20 px-2 rounded-md border border-border bg-background text-sm font-mono"
            />
          </FieldGroup>
          <FieldGroup label="Max queue age (days)" hint="Warning shown after this">
            <input
              type="number"
              min={1}
              value={draft.maxQueueAgeDays ?? ""}
              onChange={(e) => updateDraft("maxQueueAgeDays", Number(e.target.value))}
              className="h-8 w-20 px-2 rounded-md border border-border bg-background text-sm font-mono"
            />
          </FieldGroup>
        </div>
      </SettingsSection>

      {/* Quality Control */}
      <SettingsSection
        title="Quality Control"
        saving={saving === "quality"}
        onSave={() => saveSection("quality", ["deadProductDays", "lowQualityRating", "minRatingsForQualityCheck", "autoSuspendReportCount"])}
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <FieldGroup label="Dead product threshold (days)" hint="0-install items unlisted after this">
            <input
              type="number"
              min={1}
              value={draft.deadProductDays ?? ""}
              onChange={(e) => updateDraft("deadProductDays", Number(e.target.value))}
              className="h-8 w-20 px-2 rounded-md border border-border bg-background text-sm font-mono"
            />
          </FieldGroup>
          <FieldGroup label="Low quality rating" hint="Items below this get suspended">
            <input
              type="number"
              min={0}
              max={5}
              step={0.1}
              value={draft.lowQualityRating ?? ""}
              onChange={(e) => updateDraft("lowQualityRating", Number(e.target.value))}
              className="h-8 w-20 px-2 rounded-md border border-border bg-background text-sm font-mono"
            />
          </FieldGroup>
          <FieldGroup label="Min ratings for quality check" hint="Ratings needed before quality check applies">
            <input
              type="number"
              min={1}
              value={draft.minRatingsForQualityCheck ?? ""}
              onChange={(e) => updateDraft("minRatingsForQualityCheck", Number(e.target.value))}
              className="h-8 w-20 px-2 rounded-md border border-border bg-background text-sm font-mono"
            />
          </FieldGroup>
          <FieldGroup label="Auto-suspend after N reports" hint="Reports before auto-suspension">
            <input
              type="number"
              min={1}
              value={draft.autoSuspendReportCount ?? ""}
              onChange={(e) => updateDraft("autoSuspendReportCount", Number(e.target.value))}
              className="h-8 w-20 px-2 rounded-md border border-border bg-background text-sm font-mono"
            />
          </FieldGroup>
        </div>
      </SettingsSection>

      {/* Featured Items */}
      <SettingsSection
        title="Featured Items"
        saving={saving === "featured"}
        onSave={() => saveSection("featured", ["maxFeaturedItems", "featuredRotationDays"])}
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <FieldGroup label="Max featured items" hint="Maximum concurrent featured items">
            <input
              type="number"
              min={0}
              value={draft.maxFeaturedItems ?? ""}
              onChange={(e) => updateDraft("maxFeaturedItems", Number(e.target.value))}
              className="h-8 w-20 px-2 rounded-md border border-border bg-background text-sm font-mono"
            />
          </FieldGroup>
          <FieldGroup label="Featured rotation (days)" hint="Days before featured expires">
            <input
              type="number"
              min={1}
              value={draft.featuredRotationDays ?? ""}
              onChange={(e) => updateDraft("featuredRotationDays", Number(e.target.value))}
              className="h-8 w-20 px-2 rounded-md border border-border bg-background text-sm font-mono"
            />
          </FieldGroup>
        </div>
      </SettingsSection>

      {/* Publishing Requirements */}
      <SettingsSection
        title="Publishing Requirements"
        saving={saving === "publishing"}
        onSave={() => saveSection("publishing", ["requireDemoUrl", "requireScreenshots", "allowedCategories", "blockedKeywords"])}
      >
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <FieldGroup label="Require demo URL">
              <button
                onClick={() => updateDraft("requireDemoUrl", !draft.requireDemoUrl)}
                className={`h-6 w-10 rounded-full transition-colors ${draft.requireDemoUrl ? "bg-amber-500" : "bg-muted"}`}
              >
                <div className={`h-4 w-4 rounded-full bg-white transition-transform mx-1 ${draft.requireDemoUrl ? "translate-x-4" : ""}`} />
              </button>
            </FieldGroup>
            <FieldGroup label="Require screenshots">
              <button
                onClick={() => updateDraft("requireScreenshots", !draft.requireScreenshots)}
                className={`h-6 w-10 rounded-full transition-colors ${draft.requireScreenshots ? "bg-amber-500" : "bg-muted"}`}
              >
                <div className={`h-4 w-4 rounded-full bg-white transition-transform mx-1 ${draft.requireScreenshots ? "translate-x-4" : ""}`} />
              </button>
            </FieldGroup>
          </div>

          <FieldGroup label="Allowed categories">
            <div className="flex flex-wrap gap-1.5">
              {((draft.allowedCategories || []) as string[]).map((cat) => (
                <span key={cat} className="text-xs px-2 py-1 rounded-full bg-muted flex items-center gap-1">
                  {cat}
                  <button onClick={() => removeCategory(cat)}>
                    <X className="h-3 w-3 text-muted-foreground hover:text-foreground" />
                  </button>
                </span>
              ))}
              <div className="flex gap-1">
                <input
                  value={newCategory}
                  onChange={(e) => setNewCategory(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addCategory()}
                  placeholder="Add category..."
                  className="h-7 px-2 rounded border border-border bg-background text-xs w-32"
                />
                <Button variant="ghost" size="sm" onClick={addCategory} className="h-7 w-7 p-0">
                  <Plus className="h-3 w-3" />
                </Button>
              </div>
            </div>
          </FieldGroup>

          <FieldGroup label="Blocked keywords" hint="Submissions containing these auto-flag for review">
            <div className="flex flex-wrap gap-1.5">
              {((draft.blockedKeywords || []) as string[]).map((kw) => (
                <span key={kw} className="text-xs px-2 py-1 rounded-full bg-red-500/20 text-red-400 flex items-center gap-1">
                  {kw}
                  <button onClick={() => removeKeyword(kw)}>
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
              <div className="flex gap-1">
                <input
                  value={newKeyword}
                  onChange={(e) => setNewKeyword(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addKeyword()}
                  placeholder="Add keyword..."
                  className="h-7 px-2 rounded border border-border bg-background text-xs w-32"
                />
                <Button variant="ghost" size="sm" onClick={addKeyword} className="h-7 w-7 p-0">
                  <Plus className="h-3 w-3" />
                </Button>
              </div>
            </div>
          </FieldGroup>
        </div>
      </SettingsSection>

      {/* Revenue */}
      <SettingsSection
        title="Revenue"
        saving={saving === "revenue"}
        onSave={() => saveSection("revenue", ["platformFeePercent", "minPayoutAmount", "payoutSchedule"])}
      >
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <FieldGroup label="Platform fee %" hint="Percentage kept by platform">
            <input
              type="number"
              min={0}
              max={100}
              value={draft.platformFeePercent ?? ""}
              onChange={(e) => updateDraft("platformFeePercent", Number(e.target.value))}
              className="h-8 w-20 px-2 rounded-md border border-border bg-background text-sm font-mono"
            />
          </FieldGroup>
          <FieldGroup label="Min payout (USD)" hint="Minimum before payout">
            <input
              type="number"
              min={0}
              value={draft.minPayoutAmount ?? ""}
              onChange={(e) => updateDraft("minPayoutAmount", Number(e.target.value))}
              className="h-8 w-20 px-2 rounded-md border border-border bg-background text-sm font-mono"
            />
          </FieldGroup>
          <FieldGroup label="Payout schedule">
            <select
              value={draft.payoutSchedule ?? "monthly"}
              onChange={(e) => updateDraft("payoutSchedule", e.target.value as "weekly" | "biweekly" | "monthly")}
              className="h-8 rounded-md border border-border bg-background px-2 text-sm"
            >
              <option value="weekly">Weekly</option>
              <option value="biweekly">Biweekly</option>
              <option value="monthly">Monthly</option>
            </select>
          </FieldGroup>
        </div>
      </SettingsSection>
    </div>
  );
}

function SettingsSection({
  title,
  saving,
  onSave,
  children,
}: {
  title: string;
  saving: boolean;
  onSave: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-card/50 p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{title}</h3>
        <Button size="sm" onClick={onSave} disabled={saving}>
          {saving ? (
            <Loader2 className="h-3 w-3 animate-spin mr-1" />
          ) : (
            <Check className="h-3 w-3 mr-1" />
          )}
          Save
        </Button>
      </div>
      {children}
    </div>
  );
}

function FieldGroup({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      {children}
      {hint && <p className="text-[10px] text-muted-foreground/60">{hint}</p>}
    </div>
  );
}

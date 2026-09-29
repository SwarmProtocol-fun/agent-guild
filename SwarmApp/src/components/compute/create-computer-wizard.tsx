"use client";

import { useState } from "react";
import { ChevronLeft, ChevronRight, Rocket } from "lucide-react";
import {
  MODE_PRESETS,
  SIZE_PRESETS,
  MODEL_LABELS,
  REGION_LABELS,
  PROVIDER_LABELS,
  OPENCLAW_VARIANTS,
  DEFAULT_AUTO_STOP_MINUTES,
  DEFAULT_RESOLUTION,
  type ComputerMode,
  type SizeKey,
  type Region,
  type ControllerType,
  type ModelKey,
  type ProviderKey,
  type Workspace,
  type OpenClawVariant,
} from "@/lib/compute/types";
import { estimateHourlyCost, estimateMonthlyCost } from "@/lib/compute/pricing";
import { trackEvent } from "@/lib/posthog-client";
const trackComputeEvent = (event: string, properties?: Record<string, unknown>) =>
  trackEvent(`compute.${event}`, properties);
import { ResourcePicker } from "./resource-picker";

interface CreateComputerWizardProps {
  workspaces: Workspace[];
  onCreated: (id: string) => void;
  onCancel: () => void;
}

type Step = "workspace" | "mode" | "variant" | "resources" | "controller" | "review";
const BASE_STEPS: Step[] = ["workspace", "mode", "resources", "controller", "review"];

export function CreateComputerWizard({ workspaces, onCreated, onCancel }: CreateComputerWizardProps) {
  const [step, setStep] = useState<Step>("workspace");
  const [creating, setCreating] = useState(false);

  // Form state
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id || "");
  const [name, setName] = useState("");
  const [mode, setMode] = useState<ComputerMode>("blank");
  const [openclawVariant, setOpenclawVariant] = useState<OpenClawVariant | null>(null);
  const [sizeKey, setSizeKey] = useState<SizeKey>("medium");
  const [region, setRegion] = useState<Region>("us-east");
  const [provider, setProvider] = useState<ProviderKey>("azure");
  const [autoStopMinutes, setAutoStopMinutes] = useState(DEFAULT_AUTO_STOP_MINUTES);
  const [persistenceEnabled, setPersistenceEnabled] = useState(true);
  const [controllerType, setControllerType] = useState<ControllerType>("human");
  const [modelKey, setModelKey] = useState<ModelKey | null>(null);

  // Add variant step when openclaw mode is selected
  const STEPS = mode === "openclaw"
    ? ["workspace", "mode", "variant", "resources", "controller", "review"] as Step[]
    : BASE_STEPS;

  const currentIdx = STEPS.indexOf(step);
  const canGoBack = currentIdx > 0;
  const canGoNext = currentIdx < STEPS.length - 1;

  const goBack = () => { if (canGoBack) setStep(STEPS[currentIdx - 1]); };
  const goNext = () => {
    trackComputeEvent("wizard_step", { from: step, to: STEPS[currentIdx + 1] || "review" });
    if (canGoNext) setStep(STEPS[currentIdx + 1]);
  };

  const handleCreate = async () => {
    setCreating(true);
    try {
      const res = await fetch("/api/compute/computers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          name: name || (openclawVariant ? OPENCLAW_VARIANTS[openclawVariant].label : MODE_PRESETS[mode].label) + " Computer",
          provider,
          sizeKey,
          region,
          controllerType,
          modelKey,
          mode,
          openclawVariant,
          autoStopMinutes,
          persistenceEnabled,
          resolutionWidth: DEFAULT_RESOLUTION.width,
          resolutionHeight: DEFAULT_RESOLUTION.height,
        }),
      });
      const data = await res.json();
      if (data.ok) onCreated(data.id);
    } catch (err) {
      console.error("[CreateComputerWizard]", err);
    } finally {
      setCreating(false);
    }
  };

  const preset = SIZE_PRESETS[sizeKey];
  const costPerHour = estimateHourlyCost(sizeKey, undefined, provider);

  return (
    <div className="mx-auto max-w-2xl">
      {/* Progress */}
      <div className="mb-6 flex gap-1">
        {STEPS.map((s, i) => (
          <div
            key={s}
            className={`h-1 flex-1 rounded-full transition-colors ${
              i <= currentIdx ? "bg-primary" : "bg-muted"
            }`}
          />
        ))}
      </div>

      {/* Step: Workspace */}
      {step === "workspace" && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold">Choose Workspace</h2>
          <p className="text-sm text-muted-foreground">Select which workspace this computer belongs to.</p>
          <select
            value={workspaceId}
            onChange={(e) => setWorkspaceId(e.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          >
            {workspaces.map((ws) => (
              <option key={ws.id} value={ws.id}>{ws.name}</option>
            ))}
          </select>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Computer name (optional)"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
        </div>
      )}

      {/* Step: Mode */}
      {step === "mode" && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold">Choose Mode</h2>
          <p className="text-sm text-muted-foreground">Select what this computer will be used for.</p>
          <div className="grid grid-cols-2 gap-3">
            {(Object.entries(MODE_PRESETS) as [ComputerMode, typeof MODE_PRESETS[ComputerMode]][]).map(
              ([key, cfg]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => { setMode(key); setSizeKey(cfg.defaultSize); }}
                  className={`relative rounded-xl border-2 p-4 text-left transition-all duration-200 ${
                    mode === key
                      ? "border-primary bg-primary/10 shadow-sm ring-2 ring-primary/20 scale-[1.02]"
                      : "border-border hover:border-primary/40 bg-card hover:bg-muted/50"
                  }`}
                >
                  {mode === key && (
                    <div className="absolute top-3 right-3 h-2.5 w-2.5 rounded-full bg-primary" />
                  )}
                  <div className={`font-semibold text-sm ${mode === key ? "text-primary dark:text-primary" : "text-foreground"}`}>{cfg.label}</div>
                  <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">{cfg.description}</p>
                </button>
              ),
            )}
          </div>
        </div>
      )}

      {/* Step: Resources */}
      {step === "resources" && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold">Choose Resources</h2>
          <p className="text-sm text-muted-foreground">Configure compute resources, region, and behavior.</p>
          <ResourcePicker
            provider={provider}
            sizeKey={sizeKey}
            region={region}
            autoStopMinutes={autoStopMinutes}
            persistenceEnabled={persistenceEnabled}
            onProviderChange={setProvider}
            onSizeChange={setSizeKey}
            onRegionChange={setRegion}
            onAutoStopChange={setAutoStopMinutes}
            onPersistenceChange={setPersistenceEnabled}
          />
        </div>
      )}

      {/* Step: Controller */}
      {step === "controller" && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold">Choose Controller</h2>
          <p className="text-sm text-muted-foreground">Who controls this computer?</p>
          <div className="space-y-3">
            {([
              { key: "human" as ControllerType, label: "Human Only", desc: "You control the desktop directly via browser" },
              { key: "agent" as ControllerType, label: "Agent Only", desc: "An AI model controls the desktop autonomously" },
              { key: "hybrid" as ControllerType, label: "Hybrid", desc: "Both you and an AI model can interact" },
            ]).map(({ key, label, desc }) => (
              <button
                key={key}
                type="button"
                onClick={() => setControllerType(key)}
                className={`relative w-full rounded-xl border-2 p-4 text-left transition-all duration-200 ${
                  controllerType === key
                    ? "border-primary bg-primary/10 shadow-sm ring-2 ring-primary/20 scale-[1.02]"
                    : "border-border hover:border-primary/40 bg-card hover:bg-muted/50"
                }`}
              >
                {controllerType === key && (
                  <div className="absolute top-3 right-3 h-2.5 w-2.5 rounded-full bg-primary" />
                )}
                <div className={`font-semibold text-sm ${controllerType === key ? "text-primary dark:text-primary" : "text-foreground"}`}>{label}</div>
                <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">{desc}</p>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Step: Review */}
      {step === "review" && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold">Review & Launch</h2>
          <div className="rounded-lg border border-border divide-y divide-border">
            <div className="flex justify-between px-4 py-2.5">
              <span className="text-sm text-muted-foreground">Name</span>
              <span className="text-sm font-medium">{name || `${MODE_PRESETS[mode].label} Computer`}</span>
            </div>
            <div className="flex justify-between px-4 py-3">
              <span className="text-sm text-muted-foreground">Mode</span>
              <span className="text-sm font-medium">{MODE_PRESETS[mode].label}</span>
            </div>
            <div className="flex justify-between px-4 py-3 bg-muted/20">
              <span className="text-sm text-muted-foreground">Provider</span>
              <span className="text-sm font-medium">{PROVIDER_LABELS[provider].label}</span>
            </div>
            <div className="flex justify-between px-4 py-3">
              <span className="text-sm text-muted-foreground">Size</span>
              <span className="text-sm font-medium">{preset.label}</span>
            </div>
            <div className="flex justify-between px-4 py-2.5">
              <span className="text-sm text-muted-foreground">Region</span>
              <span className="text-sm font-medium">{REGION_LABELS[region]}</span>
            </div>
            <div className="flex justify-between px-4 py-2.5">
              <span className="text-sm text-muted-foreground">Controller</span>
              <span className="text-sm font-medium capitalize">{controllerType}</span>
            </div>
            <div className="flex justify-between px-4 py-2.5">
              <span className="text-sm text-muted-foreground">Hourly Rate</span>
              <span className="text-sm font-medium">${(costPerHour / 100).toFixed(2)}/hr</span>
            </div>
            <div className="flex justify-between px-4 py-2.5">
              <span className="text-sm text-muted-foreground">Projected Monthly (8 hrs/day)</span>
              <span className="text-sm font-medium">${(estimateMonthlyCost(sizeKey, 8, undefined, provider) / 100).toFixed(2)}/mo</span>
            </div>
          </div>
        </div>
      )}

      {/* Navigation */}
      <div className="mt-6 flex justify-between">
        <button
          onClick={currentIdx === 0 ? onCancel : goBack}
          className="flex items-center gap-1 rounded-md border border-border px-4 py-2 text-sm hover:bg-muted transition-colors"
        >
          <ChevronLeft className="h-4 w-4" />
          {currentIdx === 0 ? "Cancel" : "Back"}
        </button>

        {step === "review" ? (
          <button
            onClick={handleCreate}
            disabled={creating}
            className="flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            <Rocket className="h-4 w-4" />
            {creating ? "Creating..." : "Launch"}
          </button>
        ) : (
          <button
            onClick={goNext}
            className="flex items-center gap-1 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            Next
            <ChevronRight className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}

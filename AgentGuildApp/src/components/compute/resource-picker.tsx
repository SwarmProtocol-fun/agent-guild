"use client";

import { useState, useEffect } from "react";
import { SIZE_PRESETS, REGION_LABELS, PROVIDER_LABELS, type SizeKey, type Region, type ProviderKey } from "@/lib/compute/types";
import { estimateHourlyCost } from "@/lib/compute/pricing";
import { getSwarmNodes, type SwarmNode } from "@/lib/firestore";

interface ResourcePickerProps {
  provider: ProviderKey;
  sizeKey: SizeKey;
  region: Region;
  autoStopMinutes: number;
  persistenceEnabled: boolean;
  onProviderChange: (provider: ProviderKey) => void;
  onSizeChange: (size: SizeKey) => void;
  onRegionChange: (region: Region) => void;
  onAutoStopChange: (minutes: number) => void;
  onPersistenceChange: (enabled: boolean) => void;
}

/** Providers exposed in the UI (excludes stub) — Azure first */
const UI_PROVIDERS: ProviderKey[] = ["azure", "e2b", "swarm-node", "aws", "gcp"];

export function ResourcePicker({
  provider,
  sizeKey,
  region,
  autoStopMinutes,
  persistenceEnabled,
  onProviderChange,
  onSizeChange,
  onRegionChange,
  onAutoStopChange,
  onPersistenceChange,
}: ResourcePickerProps) {
  const [nodes, setNodes] = useState<SwarmNode[]>([]);
  const [loadingNodes, setLoadingNodes] = useState(false);

  useEffect(() => {
    if (provider === "swarm-node") {
      setLoadingNodes(true);
      getSwarmNodes()
        .then(setNodes)
        .catch(console.error)
        .finally(() => setLoadingNodes(false));
    }
  }, [provider]);

  return (
    <div className="space-y-6">
      {/* Provider */}
      <div>
        <label className="text-sm font-medium text-muted-foreground mb-2 block">Cloud Provider</label>
        <div className="grid grid-cols-2 gap-3">
          {UI_PROVIDERS.map((key) => {
            const cfg = PROVIDER_LABELS[key];
            const isComingSoon = cfg.comingSoon === true;
            const isSelected = provider === key;
            return (
              <button
                key={key}
                type="button"
                disabled={isComingSoon}
                onClick={() => !isComingSoon && onProviderChange(key)}
                className={`relative rounded-xl border-2 p-4 text-left transition-all duration-200 ${
                  isComingSoon
                    ? "border-border/50 opacity-50 cursor-not-allowed bg-muted/20"
                    : isSelected
                      ? "border-primary bg-primary/10 shadow-sm ring-2 ring-primary/20 scale-[1.02]"
                      : "border-border hover:border-primary/40 bg-card hover:bg-muted/50"
                }`}
              >
                {isComingSoon && (
                  <span className="absolute top-2 right-2 text-[10px] bg-muted title-muted-foreground px-1.5 py-0.5 rounded-full font-medium">
                    Coming Soon
                  </span>
                )}
                {isSelected && (
                  <div className="absolute top-3 right-3 h-2.5 w-2.5 rounded-full bg-primary" />
                )}
                <div className={`font-semibold text-sm ${isSelected ? "text-primary dark:text-primary" : "text-foreground"}`}>
                  {cfg.label}
                </div>
                <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">{cfg.description}</p>
              </button>
            );
          })}
        </div>
      </div>

      {/* Swarm Nodes */}
      {provider === "swarm-node" && (
        <div>
          <label className="text-sm font-medium text-muted-foreground mb-2 block">Available Swarm Nodes</label>
          <div className="grid grid-cols-1 gap-3">
            {loadingNodes ? (
              <div className="text-sm text-muted-foreground p-4 border rounded-xl bg-muted/20">Finding nodes...</div>
            ) : nodes.length === 0 ? (
              <div className="text-sm text-muted-foreground p-4 border rounded-xl bg-muted/20">No nodes currently available.</div>
            ) : (
              nodes.map((node) => {
                const isSelected = region === node.id;
                return (
                  <button
                    key={node.id}
                    type="button"
                    onClick={() => onRegionChange(node.id as Region)}
                    className={`relative rounded-xl border-2 p-4 text-left transition-all duration-200 ${
                      isSelected
                        ? "border-primary bg-primary/10 shadow-sm ring-2 ring-primary/20 scale-[1.02]"
                        : "border-border hover:border-primary/40 bg-card hover:bg-muted/50"
                    }`}
                  >
                    {isSelected && (
                      <div className="absolute top-3 right-3 h-2 w-2 rounded-full bg-primary" />
                    )}
                    <div className="flex items-center justify-between pointer-events-none">
                      <span className={`font-semibold text-sm ${isSelected ? "text-primary dark:text-primary" : "text-foreground"}`}>
                        Node: {node.id.slice(0, 8)}
                      </span>
                      {node.providerAddress && (
                        <span className={`text-xs font-bold ${isSelected ? "text-primary/80" : "text-primary"}`}>
                          Provider: {node.providerAddress.slice(0, 6)}...
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1.5 flex gap-3">
                      <span>{node.resources.cpuCores} vCPU</span>
                      <span>{node.resources.ramGb} GB RAM</span>
                      {node.resources.gpus?.length > 0 && <span>{node.resources.gpus[0].model}</span>}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* Size */}
      {provider !== "swarm-node" && (
        <>
          {/* Size */}
          <div>
            <label className="text-sm font-medium text-muted-foreground mb-2 block">Instance Size</label>
            <div className="grid grid-cols-2 gap-3">
              {(Object.entries(SIZE_PRESETS) as [SizeKey, typeof SIZE_PRESETS[SizeKey]][]).map(
                ([key, preset]) => {
                  const isSelected = sizeKey === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => onSizeChange(key)}
                      className={`relative rounded-xl border-2 p-4 text-left transition-all duration-200 ${
                        isSelected
                          ? "border-primary bg-primary/10 shadow-sm ring-2 ring-primary/20 scale-[1.02]"
                          : "border-border hover:border-primary/40 bg-card hover:bg-muted/50"
                      }`}
                    >
                      {isSelected && (
                        <div className="absolute top-3 right-3 h-2 w-2 rounded-full bg-primary" />
                      )}
                      <div className="flex items-center justify-between pointer-events-none">
                        <span className={`font-semibold text-sm ${isSelected ? "text-primary dark:text-primary" : "text-foreground"}`}>
                          {preset.label}
                        </span>
                        <span className={`text-xs font-bold ${isSelected ? "text-primary/80" : "text-primary"}`}>
                          ${(estimateHourlyCost(key, undefined, provider) / 100).toFixed(2)}/hr
                        </span>
                      </div>
                      <div className="text-xs text-muted-foreground mt-1.5">
                        {preset.disk} GB disk • {preset.cpu} vCPU • {preset.ram / 1024}GB RAM
                      </div>
                    </button>
                  );
                }
              )}
            </div>
          </div>

          {/* Region */}
          <div>
            <label className="text-sm font-medium text-muted-foreground mb-2 block">Region</label>
            <select
              value={region}
              onChange={(e) => onRegionChange(e.target.value as Region)}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:ring-2 focus:ring-primary/50 outline-none"
            >
              {Object.entries(REGION_LABELS).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        </>
      )}

      {/* Auto-stop */}
      <div className="flex items-center justify-between rounded-lg border border-border p-4 bg-muted/10">
        <div>
          <label className="text-sm font-semibold">Auto-stop after idle</label>
          <p className="text-xs text-muted-foreground mt-1">
            Automatically stop when no activity detected
          </p>
        </div>
        <select
          value={autoStopMinutes}
          onChange={(e) => onAutoStopChange(Number(e.target.value))}
          className="rounded-md border border-border bg-background px-3 py-2 text-sm font-medium focus:ring-2 focus:ring-primary/50 outline-none cursor-pointer"
        >
          <option value={15}>15 min</option>
          <option value={30}>30 min</option>
          <option value={60}>1 hour</option>
          <option value={120}>2 hours</option>
          <option value={0}>Never</option>
        </select>
      </div>

      {/* Persistence */}
      <div className="flex items-center justify-between rounded-lg border border-border p-4 bg-muted/10">
        <div>
          <label className="text-sm font-semibold">Persistence</label>
          <p className="text-xs text-muted-foreground mt-1">
            Keep disk state between stops
          </p>
        </div>
        <button
          type="button"
          onClick={() => onPersistenceChange(!persistenceEnabled)}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary/50 ${
            persistenceEnabled ? "bg-primary" : "bg-muted hover:bg-muted/80"
          }`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
              persistenceEnabled ? "translate-x-6" : "translate-x-1"
            }`}
          />
        </button>
      </div>
    </div>
  );
}

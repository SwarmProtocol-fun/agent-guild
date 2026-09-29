/** Mod panel host — renders a panel component contributed by an installed mod (mods/<id>/client). */
"use client";

import { use, useCallback, useEffect, useState, type ComponentType } from "react";
import type { PanelProps } from "@agent-guild/sdk";
import { MOD_MANIFESTS } from "@/lib/mods/generated/manifests";
import { clientMods } from "@/lib/mods/generated/client";
import { PanelErrorBoundary } from "@/components/panel-error-boundary";
import { useAuthAddress } from "@/hooks/useAuthAddress";

export default function ModPanelPage({ params }: { params: Promise<{ modId: string; panelId: string }> }) {
  const { modId, panelId } = use(params);
  const address = useAuthAddress();
  const [Panel, setPanel] = useState<ComponentType<PanelProps> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const manifest = MOD_MANIFESTS.find((m) => m.id === modId);
  const decl = manifest?.panels?.find((p) => p.id === panelId);

  useEffect(() => {
    const load = clientMods[modId];
    if (!decl || !load) return;
    let cancelled = false;
    load()
      .then((mod) => {
        const component = mod.default.panels?.[panelId];
        if (cancelled) return;
        if (component) setPanel(() => component);
        else setError(`Mod "${modId}" declares panel "${panelId}" but doesn't export it.`);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Failed to load mod"));
    return () => { cancelled = true; };
  }, [modId, panelId, decl]);

  const api = useCallback(
    (path: string, init?: RequestInit) =>
      fetch(`/api/mods/${modId}/${path.replace(/^\//, "")}`, { credentials: "include", ...init }),
    [modId],
  );

  if (!manifest || !decl) {
    return <div className="p-6 text-sm text-muted-foreground">No such mod panel: {modId}/{panelId}</div>;
  }
  if (error) return <div className="p-6 text-sm text-red-400">{error}</div>;
  if (!Panel) return <div className="p-6 text-sm text-muted-foreground">Loading {decl.title}…</div>;

  return (
    <PanelErrorBoundary label={`${manifest.name} · ${decl.title}`}>
      <Panel modId={modId} address={address} api={api} />
    </PanelErrorBoundary>
  );
}

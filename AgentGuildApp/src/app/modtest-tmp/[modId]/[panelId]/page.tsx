// TEMPORARY local test harness — delete before committing.
"use client";

import { use, useCallback, useEffect, useState, type ComponentType } from "react";
import type { PanelProps } from "@agent-guild/sdk";
import { clientMods } from "@/lib/mods/generated/client";

export default function ModTestPage({ params }: { params: Promise<{ modId: string; panelId: string }> }) {
  const { modId, panelId } = use(params);
  const [Panel, setPanel] = useState<ComponentType<PanelProps> | null>(null);
  useEffect(() => {
    if (new URLSearchParams(location.search).get("theme") === "dark") document.documentElement.classList.add("dark");
    clientMods[modId]?.().then((mod) => setPanel(() => mod.default.panels![panelId]));
  }, [modId, panelId]);
  const api = useCallback((path: string, init?: RequestInit) => fetch(`/api/mods/${modId}/${path.replace(/^\//, "")}`, { credentials: "include", ...init }), [modId]);
  if (!Panel) return <div>Loading…</div>;
  return <Panel modId={modId} address="0x1111111111111111111111111111111111111111" api={api} />;
}

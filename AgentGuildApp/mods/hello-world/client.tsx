"use client";

import { useEffect, useState } from "react";
import { defineClientMod, type PanelProps } from "@swarm/sdk";

function HelloPanel({ address, api }: PanelProps) {
  const [stats, setStats] = useState<{ logins: number } | null>(null);

  useEffect(() => {
    api("stats").then((r) => r.json()).then(setStats).catch(() => setStats(null));
  }, [api]);

  return (
    <div className="p-6 space-y-2">
      <h1 className="text-xl font-semibold">Hello from a mod 👋</h1>
      <p className="text-sm text-muted-foreground">Signed in as {address ?? "nobody"}.</p>
      <p className="text-sm">Logins seen by this mod since the server started: {stats?.logins ?? "…"}</p>
    </div>
  );
}

export default defineClientMod({ panels: { hello: HelloPanel } });

"use client";

import { useState } from "react";
import { Maximize2, Minimize2, RefreshCw, Loader2, Power, AlertCircle, CheckCircle2, Play } from "lucide-react";
import type { ComputerStatus } from "@/lib/compute/types";

interface DesktopViewerProps {
  computerId: string;
  vncUrl: string;
  status?: ComputerStatus;
  provider?: string;
}

export function DesktopViewer({ computerId, vncUrl, status, provider }: DesktopViewerProps) {
  const [fullscreen, setFullscreen] = useState(false);
  const [key, setKey] = useState(0);

  // Show status-specific feedback when VNC is not yet available
  if (!vncUrl) {
    return (
      <div className="flex h-[500px] flex-col items-center justify-center gap-3 rounded-lg border border-border bg-muted/30">
        {status === "provisioning" && (
          <>
            <Loader2 className="h-12 w-12 text-purple-500 animate-spin" />
            <p className="text-sm font-medium">Provisioning Resources</p>
            <p className="text-xs text-muted-foreground max-w-md text-center">
              Creating VM/container with {provider || "cloud provider"}. This usually takes 30-90 seconds...
            </p>
          </>
        )}
        {status === "starting" && (
          <>
            <Loader2 className="h-12 w-12 text-blue-500 animate-spin" />
            <p className="text-sm font-medium">Starting Instance</p>
            <p className="text-xs text-muted-foreground max-w-md text-center">
              Booting {provider || "compute"} instance and initializing desktop environment...
            </p>
            <div className="flex items-center gap-2 text-xs text-muted-foreground/70 mt-2">
              <div className="h-1.5 w-1.5 rounded-full bg-blue-500 animate-pulse" />
              <span>Auto-refreshing status every 3s</span>
            </div>
          </>
        )}
        {status === "stopping" && (
          <>
            <Loader2 className="h-12 w-12 text-amber-500 animate-spin" />
            <p className="text-sm font-medium">Stopping Instance</p>
            <p className="text-xs text-muted-foreground">
              Gracefully shutting down the instance...
            </p>
          </>
        )}
        {status === "stopped" && (
          <>
            <Power className="h-12 w-12 text-muted-foreground/50" />
            <p className="text-sm font-medium">Instance Stopped</p>
            <p className="text-xs text-muted-foreground max-w-md text-center">
              Click the <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400"><Play className="h-3 w-3" />Start</span> button above to boot the instance.
            </p>
          </>
        )}
        {status === "snapshotting" && (
          <>
            <Loader2 className="h-12 w-12 text-purple-500 animate-spin" />
            <p className="text-sm font-medium">Creating Snapshot</p>
            <p className="text-xs text-muted-foreground">
              Capturing disk state for backup/clone...
            </p>
          </>
        )}
        {status === "error" && (
          <>
            <AlertCircle className="h-12 w-12 text-red-500" />
            <p className="text-sm font-medium text-red-400">Instance Error</p>
            <p className="text-xs text-muted-foreground max-w-md text-center">
              The instance encountered an error. Check the provider dashboard or try restarting.
            </p>
          </>
        )}
        {status === "running" && (
          <>
            <CheckCircle2 className="h-12 w-12 text-emerald-500" />
            <p className="text-sm font-medium">Instance Running</p>
            <p className="text-xs text-muted-foreground max-w-md text-center">
              Instance is running but VNC connection not yet established. Retrying...
            </p>
            <Loader2 className="h-4 w-4 text-muted-foreground animate-spin mt-2" />
          </>
        )}
        {!status && (
          <>
            <div className="h-12 w-12 rounded-full border-2 border-dashed border-muted-foreground/30 flex items-center justify-center">
              <Maximize2 className="h-5 w-5 text-muted-foreground/50" />
            </div>
            <p className="text-sm text-muted-foreground">
              Desktop Not Available
            </p>
            <p className="text-xs text-muted-foreground/70 max-w-md text-center">
              No compute provider connected. Configure provider credentials in settings.
            </p>
          </>
        )}
      </div>
    );
  }

  return (
    <div className={fullscreen ? "fixed inset-0 z-50 bg-black" : "relative"}>
      <div className="absolute top-2 right-2 z-10 flex gap-1">
        <button
          onClick={() => setKey((k) => k + 1)}
          className="rounded-md bg-black/50 p-1.5 text-white hover:bg-black/70 transition-colors"
          title="Refresh"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
        <button
          onClick={() => setFullscreen(!fullscreen)}
          className="rounded-md bg-black/50 p-1.5 text-white hover:bg-black/70 transition-colors"
          title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
        >
          {fullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        </button>
      </div>
      <iframe
        key={key}
        src={vncUrl}
        className={`w-full border-0 rounded-lg ${fullscreen ? "h-screen" : "h-[600px]"}`}
        allow="clipboard-write"
        sandbox="allow-scripts allow-same-origin"
        title={`Desktop - ${computerId}`}
      />
    </div>
  );
}

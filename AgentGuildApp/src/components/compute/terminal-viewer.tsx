"use client";

import { useState } from "react";
import { Maximize2, Minimize2, Terminal as TerminalIcon, Loader2, Power, AlertCircle } from "lucide-react";
import type { ComputerStatus } from "@/lib/compute/types";

interface TerminalViewerProps {
  computerId: string;
  terminalUrl: string;
  status?: ComputerStatus;
}

export function TerminalViewer({ computerId, terminalUrl, status }: TerminalViewerProps) {
  const [fullscreen, setFullscreen] = useState(false);

  if (!terminalUrl) {
    return (
      <div className="flex h-[400px] flex-col items-center justify-center gap-2 rounded-lg border border-border bg-black/90">
        {(status === "provisioning" || status === "starting") && (
          <>
            <Loader2 className="h-10 w-10 text-emerald-500 animate-spin" />
            <p className="text-sm text-emerald-400 font-medium">
              {status === "provisioning" ? "Provisioning Instance" : "Starting Instance"}
            </p>
            <p className="text-xs text-muted-foreground">
              Terminal will be available once the instance is running...
            </p>
          </>
        )}
        {status === "stopped" && (
          <>
            <Power className="h-10 w-10 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">
              Instance Stopped
            </p>
            <p className="text-xs text-muted-foreground/70">
              Start the instance to access the terminal.
            </p>
          </>
        )}
        {status === "error" && (
          <>
            <AlertCircle className="h-10 w-10 text-red-500" />
            <p className="text-sm text-red-400">
              Instance Error
            </p>
            <p className="text-xs text-muted-foreground">
              The instance encountered an error.
            </p>
          </>
        )}
        {!status && (
          <>
            <TerminalIcon className="h-10 w-10 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">
              Terminal Not Available
            </p>
            <p className="text-xs text-muted-foreground/70">
              No compute provider connected.
            </p>
          </>
        )}
      </div>
    );
  }

  return (
    <div className={fullscreen ? "fixed inset-0 z-50 bg-black" : "relative"}>
      <div className="absolute top-2 right-2 z-10">
        <button
          onClick={() => setFullscreen(!fullscreen)}
          className="rounded-md bg-black/50 p-1.5 text-white hover:bg-black/70 transition-colors"
        >
          {fullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        </button>
      </div>
      <iframe
        src={terminalUrl}
        className={`w-full border-0 rounded-lg bg-black ${fullscreen ? "h-screen" : "h-[400px]"}`}
        allow="clipboard-write"
        title={`Terminal - ${computerId}`}
      />
    </div>
  );
}

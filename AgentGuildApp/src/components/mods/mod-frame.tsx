/**
 * ModFrame — Iframe wrapper for loading remote mod UIs.
 *
 * Loads a mod service's UI in a sandboxed iframe with theme sync
 * and auth token injection via postMessage.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, AlertTriangle, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ModFrameProps {
  modSlug: string;
  serviceUrl: string;
  orgId: string;
  wallet: string;
  theme?: string;
}

export function ModFrame({ modSlug, serviceUrl, orgId, wallet, theme }: ModFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const uiUrl = `${serviceUrl.replace(/\/$/, "")}/ui`;

  useEffect(() => {
    const timeout = setTimeout(() => {
      if (loading) setError(true);
    }, 15000);
    return () => clearTimeout(timeout);
  }, [loading]);

  // Send auth context to iframe on load
  useEffect(() => {
    if (!iframeRef.current || loading) return;

    const message = {
      type: "swarm:auth",
      orgId,
      wallet,
      theme: theme || "dark",
      modSlug,
    };

    iframeRef.current.contentWindow?.postMessage(message, "*");
  }, [loading, orgId, wallet, theme, modSlug]);

  // Listen for messages from mod iframe
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (!event.data?.type?.startsWith("swarm:")) return;

      switch (event.data.type) {
        case "swarm:ready":
          // Mod UI confirmed ready — send auth
          iframeRef.current?.contentWindow?.postMessage(
            { type: "swarm:auth", orgId, wallet, theme: theme || "dark", modSlug },
            "*",
          );
          break;
        case "swarm:navigate":
          // Mod wants to navigate the parent
          if (event.data.href) window.location.href = event.data.href;
          break;
      }
    };

    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [orgId, wallet, theme, modSlug]);

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-[calc(100vh-14rem)] text-center gap-4">
        <AlertTriangle className="h-10 w-10 text-amber-400" />
        <div>
          <h3 className="text-lg font-semibold">Mod Service Unavailable</h3>
          <p className="text-sm text-muted-foreground mt-1">
            The {modSlug} service is not responding. It may be starting up or temporarily down.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => { setError(false); setLoading(true); }}>
            Retry
          </Button>
          <Button variant="ghost" size="sm" asChild>
            <a href={uiUrl} target="_blank" rel="noopener noreferrer">
              Open directly <ExternalLink className="h-3 w-3 ml-1" />
            </a>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-[calc(100vh-14rem)] rounded-xl border border-border overflow-hidden">
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-card/80 z-10">
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="h-6 w-6 animate-spin text-amber-400" />
            <span className="text-sm text-muted-foreground">Loading {modSlug}...</span>
          </div>
        </div>
      )}
      <iframe
        ref={iframeRef}
        src={uiUrl}
        className="w-full h-full border-0"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
        onLoad={() => setLoading(false)}
        onError={() => setError(true)}
        title={`${modSlug} mod`}
      />
    </div>
  );
}

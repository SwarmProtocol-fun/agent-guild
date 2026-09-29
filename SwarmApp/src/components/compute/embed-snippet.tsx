"use client";

import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { buildEmbedSnippet } from "@/lib/compute/embed-snippet";
import type { EmbedMode } from "@/lib/compute/types";

interface EmbedSnippetProps {
  tokenId: string;
  mode: EmbedMode;
}

export function EmbedSnippet({ tokenId, mode }: EmbedSnippetProps) {
  const [tab, setTab] = useState<"js" | "react">("js");
  const [copied, setCopied] = useState(false);

  const snippets = buildEmbedSnippet(tokenId, mode);
  const code = tab === "js" ? snippets.js : snippets.react;

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="rounded-lg border border-border">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex gap-1">
          <button
            onClick={() => setTab("js")}
            className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
              tab === "js" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            HTML
          </button>
          <button
            onClick={() => setTab("react")}
            className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
              tab === "react" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            React
          </button>
        </div>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto p-3 text-xs text-muted-foreground">
        <code>{code}</code>
      </pre>
    </div>
  );
}

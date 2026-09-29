"use client";

import { useState } from "react";
import { MousePointer2, Keyboard, ArrowDown, Terminal, Camera } from "lucide-react";
import type { ActionType } from "@/lib/compute/types";

interface ActionPanelProps {
  computerId: string;
  sessionId: string;
  onAction: (actionType: ActionType, payload: Record<string, unknown>) => void;
  disabled?: boolean;
}

export function ActionPanel({ computerId, sessionId, onAction, disabled }: ActionPanelProps) {
  const [bashCmd, setBashCmd] = useState("");
  const [typeText, setTypeText] = useState("");

  const actions: { type: ActionType; label: string; icon: React.ReactNode }[] = [
    { type: "screenshot", label: "Screenshot", icon: <Camera className="h-4 w-4" /> },
    { type: "click", label: "Click", icon: <MousePointer2 className="h-4 w-4" /> },
    { type: "scroll", label: "Scroll", icon: <ArrowDown className="h-4 w-4" /> },
  ];

  return (
    <div className="space-y-4">
      {/* Quick actions */}
      <div className="flex gap-2">
        {actions.map((a) => (
          <button
            key={a.type}
            disabled={disabled}
            onClick={() => onAction(a.type, {})}
            className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs transition-colors hover:bg-muted disabled:opacity-50"
          >
            {a.icon}
            {a.label}
          </button>
        ))}
      </div>

      {/* Type text */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Keyboard className="absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" />
          <input
            value={typeText}
            onChange={(e) => setTypeText(e.target.value)}
            placeholder="Type text..."
            className="w-full rounded-md border border-border bg-background pl-8 pr-3 py-1.5 text-sm"
            onKeyDown={(e) => {
              if (e.key === "Enter" && typeText) {
                onAction("type", { text: typeText });
                setTypeText("");
              }
            }}
            disabled={disabled}
          />
        </div>
        <button
          disabled={disabled || !typeText}
          onClick={() => { onAction("type", { text: typeText }); setTypeText(""); }}
          className="rounded-md bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/20 disabled:opacity-50"
        >
          Send
        </button>
      </div>

      {/* Bash command */}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Terminal className="absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" />
          <input
            value={bashCmd}
            onChange={(e) => setBashCmd(e.target.value)}
            placeholder="$ bash command..."
            className="w-full rounded-md border border-border bg-background pl-8 pr-3 py-1.5 text-sm font-mono"
            onKeyDown={(e) => {
              if (e.key === "Enter" && bashCmd) {
                onAction("bash", { command: bashCmd });
                setBashCmd("");
              }
            }}
            disabled={disabled}
          />
        </div>
        <button
          disabled={disabled || !bashCmd}
          onClick={() => { onAction("bash", { command: bashCmd }); setBashCmd(""); }}
          className="rounded-md bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/20 disabled:opacity-50"
        >
          Run
        </button>
      </div>
    </div>
  );
}

/** Map Prompt Node — Entry-point node with an editable prompt textarea. */
"use client";

import { memo, useState, useCallback } from "react";
import { Handle, Position } from "@xyflow/react";

export const MapPromptNode = memo(function MapPromptNode({
  data,
}: {
  data: Record<string, unknown>;
}) {
  const label = (data.label as string) || "Prompt";
  const [prompt, setPrompt] = useState((data.prompt as string) || "");
  const [focused, setFocused] = useState(false);
  const onPromptChange = data.onPromptChange as ((prompt: string) => void) | undefined;

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setPrompt(e.target.value);
      onPromptChange?.(e.target.value);
    },
    [onPromptChange]
  );

  return (
    <div
      className={`rounded-xl border-2 bg-card shadow-lg transition-all duration-200 ${
        focused
          ? "border-amber-500 ring-2 ring-amber-500/20 min-w-[280px]"
          : "border-amber-400/60 min-w-[260px]"
      }`}
      style={{ maxWidth: 340 }}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!w-3 !h-3 !bg-amber-500"
      />

      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/50 bg-amber-500/5 rounded-t-xl">
        <span className="text-base">💬</span>
        <span className="text-xs font-semibold flex-1">{label}</span>
        <span className="text-[9px] font-bold uppercase tracking-wider text-amber-600 dark:text-amber-400">
          Input
        </span>
      </div>

      {/* Prompt textarea */}
      <div className="p-2.5">
        <textarea
          value={prompt}
          onChange={handleChange}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder="Type your prompt here..."
          rows={3}
          className="w-full rounded-md border border-border/60 bg-background px-2.5 py-2 text-xs resize-y min-h-[60px] max-h-[200px] focus:outline-none focus:ring-1 focus:ring-amber-500/40 focus:border-amber-500/50 placeholder:text-muted-foreground/40"
          onMouseDown={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        />
        {prompt.trim() && (
          <div className="flex items-center justify-between mt-1.5 px-0.5">
            <span className="text-[10px] text-muted-foreground/60">
              {prompt.trim().length} chars
            </span>
          </div>
        )}
      </div>

      <Handle
        type="source"
        position={Position.Right}
        className="!w-3 !h-3 !bg-amber-500"
      />
    </div>
  );
});

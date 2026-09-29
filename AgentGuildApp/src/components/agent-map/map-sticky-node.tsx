/** Map Sticky Note Node — Resizable, colorable note for canvas annotations (n8n-style). */
"use client";

import { memo, useState, useCallback, useRef, useEffect } from "react";
import { Handle, Position, NodeResizer } from "@xyflow/react";

const STICKY_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  yellow: { bg: "bg-yellow-100 dark:bg-yellow-900", border: "border-yellow-300 dark:border-yellow-700", text: "text-yellow-900 dark:text-yellow-200" },
  green: { bg: "bg-emerald-100 dark:bg-emerald-900", border: "border-emerald-300 dark:border-emerald-700", text: "text-emerald-900 dark:text-emerald-200" },
  blue: { bg: "bg-blue-100 dark:bg-blue-900", border: "border-blue-300 dark:border-blue-700", text: "text-blue-900 dark:text-blue-200" },
  purple: { bg: "bg-purple-100 dark:bg-purple-900", border: "border-purple-300 dark:border-purple-700", text: "text-purple-900 dark:text-purple-200" },
  pink: { bg: "bg-pink-100 dark:bg-pink-900", border: "border-pink-300 dark:border-pink-700", text: "text-pink-900 dark:text-pink-200" },
};

const COLOR_DOTS: Array<{ key: string; dot: string }> = [
  { key: "yellow", dot: "bg-yellow-400" },
  { key: "green", dot: "bg-emerald-400" },
  { key: "blue", dot: "bg-blue-400" },
  { key: "purple", dot: "bg-purple-400" },
  { key: "pink", dot: "bg-pink-400" },
];

interface MapStickyNodeData {
  label: string;
  content: string;
  color: string;
  width?: number;
  height?: number;
  [key: string]: unknown;
}

export const MapStickyNode = memo(function MapStickyNode({ data, id }: { data: MapStickyNodeData; id: string }) {
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(data.content || "");
  const [color, setColor] = useState(data.color || "yellow");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const colors = STICKY_COLORS[color] || STICKY_COLORS.yellow;

  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.selectionStart = textareaRef.current.value.length;
    }
  }, [editing]);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setEditing(true);
  }, []);

  const handleBlur = useCallback(() => {
    setEditing(false);
    // Update data in place (React Flow will pick this up)
    data.content = content;
  }, [content, data]);

  const handleColorChange = useCallback((newColor: string) => {
    setColor(newColor);
    data.color = newColor;
  }, [data]);

  return (
    <>
      <NodeResizer
        minWidth={150}
        minHeight={80}
        maxWidth={600}
        maxHeight={400}
        color="#fbbf24"
        lineStyle={{ borderWidth: 1 }}
        handleStyle={{ width: 8, height: 8 }}
      />
      <div
        onDoubleClick={handleDoubleClick}
        className={`w-full h-full rounded-lg border-2 shadow-sm cursor-pointer transition-colors ${colors.bg} ${colors.border}`}
        style={{ minWidth: 150, minHeight: 80 }}
      >
        {/* Header with color picker */}
        <div className="flex items-center justify-between px-2.5 pt-2 pb-1">
          <span className={`text-[10px] font-semibold uppercase tracking-wider ${colors.text} opacity-60`}>
            Note
          </span>
          <div className="flex items-center gap-1">
            {COLOR_DOTS.map((c) => (
              <button
                key={c.key}
                onClick={(e) => { e.stopPropagation(); handleColorChange(c.key); }}
                className={`w-3 h-3 rounded-full ${c.dot} transition-transform ${
                  color === c.key ? "ring-2 ring-offset-1 ring-foreground/30 scale-110" : "hover:scale-110"
                }`}
              />
            ))}
          </div>
        </div>

        {/* Content area */}
        <div className="px-2.5 pb-2.5 h-[calc(100%-28px)]">
          {editing ? (
            <textarea
              ref={textareaRef}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              onBlur={handleBlur}
              onKeyDown={(e) => { if (e.key === "Escape") handleBlur(); }}
              placeholder="Type your note..."
              className={`w-full h-full resize-none bg-transparent text-xs border-none outline-none placeholder:opacity-40 ${colors.text}`}
            />
          ) : (
            <p className={`text-xs whitespace-pre-wrap break-words ${colors.text} ${!content ? "opacity-40" : ""}`}>
              {content || "Double-click to edit..."}
            </p>
          )}
        </div>

        <Handle type="source" position={Position.Right} className="!w-2 !h-2 !bg-yellow-500 !opacity-0 hover:!opacity-100" />
        <Handle type="target" position={Position.Left} className="!w-2 !h-2 !bg-yellow-500 !opacity-0 hover:!opacity-100" />
      </div>
    </>
  );
});

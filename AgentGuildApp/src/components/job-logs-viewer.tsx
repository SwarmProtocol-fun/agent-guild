"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Loader2, ArrowDown, Pause, Play, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface JobLogsViewerProps {
  jobId: string;
  autoScroll?: boolean;
}

export function JobLogsViewer({ jobId, autoScroll = true }: JobLogsViewerProps) {
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState<string>("connecting");
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const shouldScroll = useRef(autoScroll);

  const scrollToBottom = useCallback(() => {
    if (shouldScroll.current && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, []);

  useEffect(() => {
    if (!jobId) return;

    const source = new EventSource(`/api/gateway/jobs/${jobId}/logs`);

    source.addEventListener("log", (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.lines && Array.isArray(data.lines)) {
          setLines((prev) => [...prev, ...data.lines]);
        }
      } catch { /* ignore */ }
    });

    source.addEventListener("status", (e) => {
      try {
        const data = JSON.parse(e.data);
        setStatus(data.status || "unknown");
      } catch { /* ignore */ }
    });

    source.addEventListener("done", (e) => {
      try {
        const data = JSON.parse(e.data);
        setStatus(data.status || "done");
      } catch {
        setStatus("done");
      }
      source.close();
    });

    source.addEventListener("error", () => {
      setStatus("error");
    });

    source.onerror = () => {
      setStatus("disconnected");
      source.close();
    };

    return () => source.close();
  }, [jobId]);

  useEffect(() => {
    if (!paused) scrollToBottom();
  }, [lines, paused, scrollToBottom]);

  const filteredLines = filter
    ? lines.filter((l) => l.toLowerCase().includes(filter.toLowerCase()))
    : lines;

  const statusColor =
    status === "running"
      ? "text-blue-400"
      : status === "completed"
        ? "text-emerald-400"
        : status === "failed"
          ? "text-red-400"
          : "text-zinc-400";

  return (
    <div className="flex flex-col h-full border border-border rounded-lg overflow-hidden bg-zinc-950">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 bg-zinc-900 border-b border-border">
        <div className={`w-2 h-2 rounded-full ${status === "running" ? "bg-blue-400 animate-pulse" : status === "completed" ? "bg-emerald-400" : status === "failed" ? "bg-red-400" : "bg-zinc-400"}`} />
        <span className={`text-xs font-mono ${statusColor}`}>{status}</span>
        <span className="text-xs text-muted-foreground ml-auto">{lines.length} lines</span>

        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={() => setShowSearch(!showSearch)}
        >
          <Search className="h-3 w-3" />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={() => {
            setPaused(!paused);
            shouldScroll.current = paused;
          }}
        >
          {paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={() => {
            shouldScroll.current = true;
            scrollToBottom();
          }}
        >
          <ArrowDown className="h-3 w-3" />
        </Button>
      </div>

      {/* Search bar */}
      {showSearch && (
        <div className="px-3 py-1.5 bg-zinc-900/50 border-b border-border">
          <Input
            placeholder="Filter logs..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="h-7 text-xs font-mono bg-zinc-950 border-zinc-700"
          />
        </div>
      )}

      {/* Log output */}
      <div
        ref={containerRef}
        className="flex-1 overflow-auto p-3 font-mono text-xs leading-5"
        onScroll={() => {
          if (!containerRef.current) return;
          const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
          shouldScroll.current = scrollHeight - scrollTop - clientHeight < 50;
        }}
      >
        {filteredLines.length === 0 && status === "connecting" && (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Connecting to log stream...
          </div>
        )}
        {filteredLines.length === 0 && status !== "connecting" && (
          <div className="text-muted-foreground">No log output</div>
        )}
        {filteredLines.map((line, i) => (
          <div
            key={i}
            className={`whitespace-pre-wrap break-all ${
              line.startsWith("[stderr]")
                ? "text-red-400/80"
                : line.startsWith("[error]")
                  ? "text-red-500"
                  : "text-zinc-300"
            }`}
          >
            <span className="text-zinc-600 select-none mr-3">{String(i + 1).padStart(4)}</span>
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}

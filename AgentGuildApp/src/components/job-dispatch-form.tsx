"use client";

import { useState } from "react";
import { Play, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";

interface JobDispatchFormProps {
  orgId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDispatched?: (taskId: string) => void;
}

const TASK_TYPES = ["shell", "docker", "node"] as const;
const PRIORITIES = ["low", "normal", "high", "critical"] as const;

const PAYLOAD_EXAMPLES: Record<string, string> = {
  shell: '{\n  "command": "echo",\n  "args": ["hello world"]\n}',
  docker: '{\n  "image": "alpine",\n  "command": ["echo", "hello"]\n}',
  node: '{\n  "script": "console.log(1 + 1)"\n}',
};

export function JobDispatchForm({ orgId, open, onOpenChange, onDispatched }: JobDispatchFormProps) {
  const [taskType, setTaskType] = useState<string>("shell");
  const [priority, setPriority] = useState<string>("normal");
  const [payload, setPayload] = useState(PAYLOAD_EXAMPLES.shell);
  const [timeoutSec, setTimeoutSec] = useState("60");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    setError(null);

    let parsedPayload;
    try {
      parsedPayload = JSON.parse(payload);
    } catch {
      setError("Invalid JSON payload");
      return;
    }

    setSubmitting(true);
    try {
      const resp = await fetch("/api/gateway/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orgId,
          taskType,
          payload: parsedPayload,
          priority,
          timeoutMs: parseInt(timeoutSec, 10) * 1000,
          maxRetries: 2,
        }),
      });

      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${resp.status}`);
      }

      const data = await resp.json();
      onDispatched?.(data.taskId);
      onOpenChange(false);

      // Reset form
      setPayload(PAYLOAD_EXAMPLES[taskType] || "{}");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to dispatch job");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Play className="h-4 w-4 text-teal-500" />
            Dispatch Job
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Task Type */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Task Type</label>
            <div className="flex gap-2">
              {TASK_TYPES.map((t) => (
                <button
                  key={t}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                    taskType === t
                      ? "bg-teal-500/20 text-teal-400 border border-teal-500/40"
                      : "bg-zinc-800 text-zinc-400 border border-zinc-700 hover:border-zinc-600"
                  }`}
                  onClick={() => {
                    setTaskType(t);
                    setPayload(PAYLOAD_EXAMPLES[t] || "{}");
                  }}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          {/* Priority */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Priority</label>
            <div className="flex gap-2">
              {PRIORITIES.map((p) => (
                <button
                  key={p}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                    priority === p
                      ? "bg-teal-500/20 text-teal-400 border border-teal-500/40"
                      : "bg-zinc-800 text-zinc-400 border border-zinc-700 hover:border-zinc-600"
                  }`}
                  onClick={() => setPriority(p)}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>

          {/* Timeout */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Timeout (seconds)</label>
            <Input
              type="number"
              min="1"
              max="600"
              value={timeoutSec}
              onChange={(e) => setTimeoutSec(e.target.value)}
              className="w-32"
            />
          </div>

          {/* Payload */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Payload (JSON)</label>
            <textarea
              value={payload}
              onChange={(e) => setPayload(e.target.value)}
              rows={6}
              className="w-full rounded-md border border-border bg-zinc-950 px-3 py-2 text-xs font-mono text-zinc-300 focus:outline-none focus:ring-1 focus:ring-teal-500"
              spellCheck={false}
            />
          </div>

          {error && (
            <div className="text-xs text-red-400 bg-red-500/10 px-3 py-2 rounded-md">
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={submitting}
            className="bg-teal-500 hover:bg-teal-600 text-black"
          >
            {submitting ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin mr-1.5" />
                Dispatching...
              </>
            ) : (
              <>
                <Play className="h-3 w-3 mr-1.5" />
                Dispatch
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

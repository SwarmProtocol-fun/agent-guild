"use client";

import { useState, useEffect } from "react";
import { X, AlertTriangle, Check } from "lucide-react";
import { type KanbanTask } from "@/lib/kanban";

interface TaskBlockerModalProps {
  task: KanbanTask;
  availableTasks: KanbanTask[];
  onClose: () => void;
  onBlock: (blockedBy: string[], blockReason: string) => Promise<void>;
  onUnblock: () => Promise<void>;
}

export function TaskBlockerModal({
  task,
  availableTasks,
  onClose,
  onBlock,
  onUnblock,
}: TaskBlockerModalProps) {
  const [selectedBlockers, setSelectedBlockers] = useState<string[]>(task.blockedBy || []);
  const [blockReason, setBlockReason] = useState(task.blockReason || "");
  const [blocking, setBlocking] = useState(false);

  const isBlocked = (task.blockedBy && task.blockedBy.length > 0) || !!task.blockReason;

  const handleBlock = async () => {
    if (selectedBlockers.length === 0 && !blockReason.trim()) {
      alert("Please select at least one blocker task or provide a reason");
      return;
    }

    setBlocking(true);
    try {
      await onBlock(selectedBlockers, blockReason.trim());
      onClose();
    } catch (err) {
      console.error("Failed to block task:", err);
      alert("Failed to block task");
    } finally {
      setBlocking(false);
    }
  };

  const handleUnblock = async () => {
    setBlocking(true);
    try {
      await onUnblock();
      onClose();
    } catch (err) {
      console.error("Failed to unblock task:", err);
      alert("Failed to unblock task");
    } finally {
      setBlocking(false);
    }
  };

  const toggleBlocker = (taskId: string) => {
    setSelectedBlockers((prev) =>
      prev.includes(taskId) ? prev.filter((id) => id !== taskId) : [...prev, taskId]
    );
  };

  // Filter out current task and already done tasks
  const validBlockers = availableTasks.filter(
    (t) => t.id !== task.id && t.status !== "done"
  );

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-lg max-w-2xl w-full max-h-[80vh] overflow-y-auto border border-gray-700">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-700">
          <div className="flex items-center space-x-3">
            <AlertTriangle className="w-6 h-6 text-orange-400" />
            <h2 className="text-xl font-bold text-white">
              {isBlocked ? "Task Blocked" : "Block Task"}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6">
          {/* Current task info */}
          <div className="bg-gray-700 rounded-lg p-4">
            <p className="text-sm text-gray-400 mb-1">Task</p>
            <p className="font-medium text-white">{task.title}</p>
            {task.description && (
              <p className="text-sm text-gray-400 mt-2">{task.description}</p>
            )}
          </div>

          {/* Blocker tasks */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-3">
              Blocked by tasks
            </label>
            {validBlockers.length === 0 ? (
              <p className="text-sm text-gray-400">No other tasks available to select as blockers</p>
            ) : (
              <div className="space-y-2 max-h-[200px] overflow-y-auto">
                {validBlockers.map((blocker) => (
                  <label
                    key={blocker.id}
                    className={`flex items-center space-x-3 p-3 rounded-lg cursor-pointer transition ${
                      selectedBlockers.includes(blocker.id)
                        ? "bg-blue-500/20 border border-blue-500/30"
                        : "bg-gray-700 hover:bg-gray-600"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={selectedBlockers.includes(blocker.id)}
                      onChange={() => toggleBlocker(blocker.id)}
                      className="w-4 h-4 text-blue-600 bg-gray-700 border-gray-600 rounded focus:ring-blue-500"
                    />
                    <div className="flex-1">
                      <p className="text-sm font-medium text-white">{blocker.title}</p>
                      <div className="flex items-center space-x-2 mt-1">
                        <span className="text-xs text-gray-400 capitalize">
                          {blocker.status.replace("_", " ")}
                        </span>
                        {blocker.priority !== "none" && (
                          <span className="text-xs text-gray-400">•</span>
                        )}
                        {blocker.priority !== "none" && (
                          <span className="text-xs text-gray-400 capitalize">
                            {blocker.priority} priority
                          </span>
                        )}
                      </div>
                    </div>
                    {selectedBlockers.includes(blocker.id) && (
                      <Check className="w-5 h-5 text-blue-400" />
                    )}
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* Block reason */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              Block reason (optional)
            </label>
            <textarea
              value={blockReason}
              onChange={(e) => setBlockReason(e.target.value)}
              placeholder="Why is this task blocked? (e.g., waiting for API design, dependency not ready...)"
              rows={3}
              className="w-full bg-gray-700 border border-gray-600 rounded-lg px-4 py-2 text-white placeholder-gray-500 focus:border-blue-500 focus:outline-none"
            />
          </div>

          {/* Current block info */}
          {isBlocked && (
            <div className="bg-orange-500/10 border border-orange-500/30 rounded-lg p-4">
              <div className="flex items-start space-x-2">
                <AlertTriangle className="w-5 h-5 text-orange-400 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-orange-300">Currently Blocked</p>
                  {task.blockedBy && task.blockedBy.length > 0 && (
                    <p className="text-xs text-gray-400 mt-1">
                      {task.blockedBy.length} blocker task{task.blockedBy.length > 1 ? "s" : ""}
                    </p>
                  )}
                  {task.blockReason && (
                    <p className="text-xs text-gray-300 mt-2">{task.blockReason}</p>
                  )}
                  {task.blockedAt && (
                    <p className="text-xs text-gray-500 mt-1">
                      Blocked at {task.blockedAt.toLocaleString()}
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-3 justify-end">
            <button
              onClick={onClose}
              className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition"
              disabled={blocking}
            >
              Cancel
            </button>
            {isBlocked && (
              <button
                onClick={handleUnblock}
                disabled={blocking}
                className="px-4 py-2 bg-green-600 hover:bg-green-700 disabled:bg-gray-600 text-white rounded-lg transition"
              >
                {blocking ? "Unblocking..." : "Unblock Task"}
              </button>
            )}
            <button
              onClick={handleBlock}
              disabled={blocking || (selectedBlockers.length === 0 && !blockReason.trim())}
              className="px-4 py-2 bg-orange-600 hover:bg-orange-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded-lg transition"
            >
              {blocking ? "Blocking..." : isBlocked ? "Update Blockers" : "Block Task"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

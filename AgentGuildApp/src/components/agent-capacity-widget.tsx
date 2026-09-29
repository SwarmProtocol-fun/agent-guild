"use client";

import { useState, useEffect } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { updateAgentWorkMode, type AgentWorkMode } from "@/lib/assignments";
import { Activity, Pause, Play, Loader } from "lucide-react";

interface AgentCapacityWidgetProps {
  agentId: string;
}

export function AgentCapacityWidget({ agentId }: AgentCapacityWidgetProps) {
  const [workMode, setWorkMode] = useState<AgentWorkMode | null>(null);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);

  // Real-time listener for agent work mode
  useEffect(() => {
    const agentRef = doc(db, "agents", agentId);

    const unsubscribe = onSnapshot(agentRef, (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.data();
        setWorkMode({
          workMode: data.workMode || "available",
          capacity: data.capacity || 3,
          currentLoad: data.currentLoad || 0,
          lastStatusUpdate: data.lastStatusUpdate || data.lastSeen,
          autoAcceptAssignments: data.autoAcceptAssignments || false,
          capacityOverflowPolicy: data.capacityOverflowPolicy || "warn",
          assignmentsCompleted: data.assignmentsCompleted || 0,
          assignmentsRejected: data.assignmentsRejected || 0,
          averageCompletionTimeMs: data.averageCompletionTimeMs || 0,
          overdueCount: data.overdueCount || 0,
        });
      }
      setLoading(false);
    });

    return () => unsubscribe();
  }, [agentId]);

  const handleWorkModeChange = async (newMode: "available" | "busy" | "offline" | "paused") => {
    setUpdating(true);
    try {
      await updateAgentWorkMode(agentId, { workMode: newMode });
    } catch (err) {
      console.error("Failed to update work mode:", err);
      alert(err instanceof Error ? err.message : "Failed to update work mode");
    } finally {
      setUpdating(false);
    }
  };

  const handleCapacityChange = async (newCapacity: number) => {
    if (newCapacity < 1 || newCapacity > 20) return;
    setUpdating(true);
    try {
      await updateAgentWorkMode(agentId, { capacity: newCapacity });
    } catch (err) {
      console.error("Failed to update capacity:", err);
      alert(err instanceof Error ? err.message : "Failed to update capacity");
    } finally {
      setUpdating(false);
    }
  };

  const handleAutoAcceptToggle = async () => {
    setUpdating(true);
    try {
      await updateAgentWorkMode(agentId, {
        autoAcceptAssignments: !workMode?.autoAcceptAssignments,
      });
    } catch (err) {
      console.error("Failed to toggle auto-accept:", err);
      alert(err instanceof Error ? err.message : "Failed to toggle auto-accept");
    } finally {
      setUpdating(false);
    }
  };

  if (loading) {
    return (
      <div className="border border-gray-700 rounded-lg p-6 bg-gray-800/50">
        <div className="flex items-center justify-center">
          <Loader className="w-6 h-6 animate-spin text-blue-400" />
          <span className="ml-2 text-gray-400">Loading capacity...</span>
        </div>
      </div>
    );
  }

  if (!workMode) {
    return (
      <div className="border border-gray-700 rounded-lg p-6 bg-gray-800/50">
        <p className="text-gray-400 text-center">No capacity data available</p>
      </div>
    );
  }

  const utilizationPercent = Math.round((workMode.currentLoad / workMode.capacity) * 100);
  const isOverloaded = workMode.currentLoad > workMode.capacity;
  const availableSlots = Math.max(0, workMode.capacity - workMode.currentLoad);

  const getWorkModeColor = (mode: string) => {
    switch (mode) {
      case "available":
        return "bg-green-600";
      case "busy":
        return "bg-orange-600";
      case "paused":
        return "bg-yellow-600";
      case "offline":
        return "bg-gray-600";
      default:
        return "bg-gray-600";
    }
  };

  const getWorkModeIcon = (mode: string) => {
    switch (mode) {
      case "available":
        return <Play className="w-4 h-4" />;
      case "busy":
        return <Activity className="w-4 h-4" />;
      case "paused":
        return <Pause className="w-4 h-4" />;
      default:
        return <Pause className="w-4 h-4" />;
    }
  };

  return (
    <div className="border border-gray-700 rounded-lg p-6 bg-gray-800/50">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-white">Work Capacity</h3>
        <div className="flex items-center space-x-2">
          {getWorkModeIcon(workMode.workMode)}
          <span className="text-sm text-gray-400 capitalize">{workMode.workMode}</span>
        </div>
      </div>

      {/* Capacity Bar */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm text-gray-400">
            {workMode.currentLoad} / {workMode.capacity} assignments
          </span>
          <span className={`text-sm font-bold ${isOverloaded ? "text-red-400" : "text-blue-400"}`}>
            {utilizationPercent}%
          </span>
        </div>
        <div className="w-full bg-gray-700 rounded-full h-3 overflow-hidden">
          <div
            className={`h-full transition-all ${
              isOverloaded ? "bg-red-600" : utilizationPercent > 80 ? "bg-orange-600" : "bg-green-600"
            }`}
            style={{ width: `${Math.min(100, utilizationPercent)}%` }}
          />
        </div>
        <p className="text-xs text-gray-400 mt-1">
          {availableSlots} slot{availableSlots !== 1 ? "s" : ""} available
        </p>
      </div>

      {/* Work Mode Toggles */}
      <div className="mb-4">
        <label className="text-xs text-gray-400 mb-2 block">Work Mode</label>
        <div className="grid grid-cols-4 gap-2">
          {(["available", "busy", "paused", "offline"] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => handleWorkModeChange(mode)}
              disabled={updating || workMode.workMode === mode}
              className={`px-3 py-2 text-xs rounded transition ${
                workMode.workMode === mode
                  ? `${getWorkModeColor(mode)} text-white`
                  : "bg-gray-700 text-gray-400 hover:bg-gray-600"
              } disabled:cursor-not-allowed capitalize`}
            >
              {mode}
            </button>
          ))}
        </div>
      </div>

      {/* Capacity Adjustment */}
      <div className="mb-4">
        <label className="text-xs text-gray-400 mb-2 block">Max Capacity</label>
        <div className="flex items-center space-x-2">
          <input
            type="range"
            min="1"
            max="20"
            value={workMode.capacity}
            onChange={(e) => handleCapacityChange(parseInt(e.target.value, 10))}
            disabled={updating}
            className="flex-1 h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-600"
          />
          <span className="text-sm text-white font-bold w-6 text-center">{workMode.capacity}</span>
        </div>
      </div>

      {/* Auto-Accept Toggle */}
      <div className="mb-4">
        <label className="flex items-center space-x-2 cursor-pointer">
          <input
            type="checkbox"
            checked={workMode.autoAcceptAssignments}
            onChange={handleAutoAcceptToggle}
            disabled={updating}
            className="w-4 h-4 text-blue-600 bg-gray-700 border-gray-600 rounded focus:ring-blue-500 focus:ring-2"
          />
          <span className="text-sm text-gray-400">Auto-accept assignments</span>
        </label>
      </div>

      {/* Stats */}
      <div className="border-t border-gray-700 pt-4">
        <h4 className="text-xs text-gray-400 mb-2">Statistics</h4>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="text-xs text-gray-500">Completed</p>
            <p className="text-lg font-bold text-green-400">{workMode.assignmentsCompleted}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500">Rejected</p>
            <p className="text-lg font-bold text-red-400">{workMode.assignmentsRejected}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500">Overdue</p>
            <p className="text-lg font-bold text-orange-400">{workMode.overdueCount}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500">Avg Time</p>
            <p className="text-lg font-bold text-blue-400">
              {Math.round(workMode.averageCompletionTimeMs / 1000 / 60)}m
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

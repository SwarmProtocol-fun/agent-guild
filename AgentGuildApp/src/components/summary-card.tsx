"use client";

import { type DailySummary } from "@/lib/daily-summary";
import { CheckCircle, XCircle, MessageSquare, DollarSign, Zap, AlertTriangle } from "lucide-react";

interface SummaryCardProps {
  summary: DailySummary;
  expanded?: boolean;
  onExpand?: () => void;
}

export function SummaryCard({ summary, expanded = false, onExpand }: SummaryCardProps) {
  const { agentName, date, summary: data } = summary;

  return (
    <div className="bg-gray-800 rounded-lg border border-gray-700 p-6 hover:border-gray-600 transition">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-lg font-bold text-white">{agentName}</h3>
          <p className="text-sm text-gray-400">{date}</p>
        </div>
        <button
          onClick={onExpand}
          className="text-sm text-blue-400 hover:text-blue-300 transition"
        >
          {expanded ? "Collapse" : "Expand"}
        </button>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
        <div className="flex items-center space-x-2">
          <CheckCircle className="w-5 h-5 text-green-400" />
          <div>
            <p className="text-xs text-gray-400">Completed</p>
            <p className="text-lg font-bold text-white">{data.tasksCompleted}</p>
          </div>
        </div>

        <div className="flex items-center space-x-2">
          <XCircle className="w-5 h-5 text-red-400" />
          <div>
            <p className="text-xs text-gray-400">Failed</p>
            <p className="text-lg font-bold text-white">{data.tasksFailed}</p>
          </div>
        </div>

        <div className="flex items-center space-x-2">
          <MessageSquare className="w-5 h-5 text-blue-400" />
          <div>
            <p className="text-xs text-gray-400">Messages</p>
            <p className="text-lg font-bold text-white">{data.messagesPosted}</p>
          </div>
        </div>

        <div className="flex items-center space-x-2">
          <DollarSign className="w-5 h-5 text-green-400" />
          <div>
            <p className="text-xs text-gray-400">Cost</p>
            <p className="text-lg font-bold text-white">${data.costUsd.toFixed(2)}</p>
          </div>
        </div>
      </div>

      {/* Token Usage */}
      <div className="flex items-center space-x-2 mb-4 p-3 bg-gray-700 rounded-lg">
        <Zap className="w-4 h-4 text-yellow-400" />
        <span className="text-sm text-gray-300">
          {(data.tokensUsed / 1000).toFixed(1)}K tokens used
        </span>
      </div>

      {/* Expanded Section */}
      {expanded && (
        <div className="space-y-4 mt-4 pt-4 border-t border-gray-700">
          {/* Highlights */}
          {data.highlights.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold text-gray-300 mb-2">✨ Highlights</h4>
              <ul className="space-y-1">
                {data.highlights.map((h, idx) => (
                  <li key={idx} className="text-sm text-gray-400 pl-4">
                    • {h}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Top Activities */}
          {data.topActivities.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold text-gray-300 mb-2">🎯 Top Activities</h4>
              <div className="space-y-2">
                {data.topActivities.map((activity, idx) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between p-2 bg-gray-700 rounded"
                  >
                    <span className="text-sm text-gray-300 capitalize">
                      {activity.type.replace(/_/g, " ")}
                    </span>
                    <span className="text-sm font-bold text-blue-400">{activity.count}x</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Errors */}
          {data.errors.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold text-red-400 mb-2 flex items-center space-x-2">
                <AlertTriangle className="w-4 h-4" />
                <span>Errors</span>
              </h4>
              <div className="space-y-2">
                {data.errors.map((error, idx) => (
                  <div
                    key={idx}
                    className="p-3 bg-red-500/10 border border-red-500/30 rounded"
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-medium text-red-400 capitalize">
                        {error.type.replace(/_/g, " ")}
                      </span>
                      <span className="text-xs text-red-400">{error.count}x</span>
                    </div>
                    <p className="text-xs text-gray-400 truncate">{error.lastError}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

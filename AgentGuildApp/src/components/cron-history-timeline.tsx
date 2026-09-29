"use client";

import { type CronExecutionHistory } from "@/lib/cron-history";
import { CheckCircle, XCircle, Clock, TestTube } from "lucide-react";

interface CronHistoryTimelineProps {
  history: CronExecutionHistory[];
}

export function CronHistoryTimeline({ history }: CronHistoryTimelineProps) {
  if (history.length === 0) {
    return (
      <div className="text-center py-12 text-gray-400">
        <Clock className="w-12 h-12 mx-auto mb-4 text-gray-600" />
        <p>No execution history yet</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {history.map((execution, idx) => {
        const isSuccess = execution.success;
        const statusIcon = isSuccess ? (
          <CheckCircle className="w-5 h-5 text-green-400" />
        ) : (
          <XCircle className="w-5 h-5 text-red-400" />
        );

        const statusColor = isSuccess
          ? "border-green-500/30 bg-green-500/10"
          : "border-red-500/30 bg-red-500/10";

        return (
          <div
            key={execution.id}
            className={`relative border rounded-lg p-4 ${statusColor}`}
          >
            {/* Test run badge */}
            {execution.testRun && (
              <div className="absolute top-2 right-2">
                <div className="flex items-center space-x-1 px-2 py-1 bg-blue-500/20 border border-blue-500/30 rounded text-xs text-blue-400">
                  <TestTube className="w-3 h-3" />
                  <span>Test Run</span>
                </div>
              </div>
            )}

            {/* Header */}
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center space-x-3">
                {statusIcon}
                <div>
                  <p className="font-medium text-white">
                    {execution.startTime?.toLocaleString() || "Unknown time"}
                  </p>
                  <p className="text-xs text-gray-400">
                    Duration: {execution.durationMs}ms
                  </p>
                </div>
              </div>
            </div>

            {/* Error message */}
            {execution.error && (
              <div className="mb-3 p-2 bg-red-500/10 border border-red-500/30 rounded text-sm text-red-400">
                <strong>Error:</strong> {execution.error}
              </div>
            )}

            {/* Agent results */}
            {execution.agentResults && execution.agentResults.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-gray-300 uppercase">
                  Agent Results ({execution.agentResults.length})
                </p>
                <div className="grid grid-cols-1 gap-2">
                  {execution.agentResults.map((result, resultIdx) => (
                    <div
                      key={resultIdx}
                      className={`flex items-start justify-between p-2 rounded text-sm ${
                        result.success
                          ? "bg-green-500/10 border border-green-500/20"
                          : "bg-red-500/10 border border-red-500/20"
                      }`}
                    >
                      <div className="flex items-center space-x-2">
                        {result.success ? (
                          <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0" />
                        ) : (
                          <XCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
                        )}
                        <div>
                          <p className="font-medium text-white">{result.agentName}</p>
                          {result.error && (
                            <p className="text-xs text-red-400">{result.error}</p>
                          )}
                          {result.responsePreview && (
                            <p className="text-xs text-gray-400 truncate max-w-md">
                              {result.responsePreview}
                            </p>
                          )}
                        </div>
                      </div>
                      <span className="text-xs text-gray-500">
                        {new Date(result.executedAt).toLocaleTimeString()}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Timeline connector (not on last item) */}
            {idx < history.length - 1 && (
              <div className="absolute left-[18px] top-[60px] w-[2px] h-8 bg-gray-700" />
            )}
          </div>
        );
      })}
    </div>
  );
}

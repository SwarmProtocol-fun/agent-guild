"use client";

import { useState } from "react";
import { AlertTriangle, CheckCircle, Wrench, Loader } from "lucide-react";
import { type DiagnosticIssue } from "@/lib/diagnostics";

interface DiagnosticCardProps {
  issue: DiagnosticIssue;
  onFix?: (issue: DiagnosticIssue) => Promise<void>;
}

export function DiagnosticCard({ issue, onFix }: DiagnosticCardProps) {
  const [fixing, setFixing] = useState(false);
  const [fixed, setFixed] = useState(false);

  const [error, setError] = useState<string | null>(null);

  const handleFix = async () => {
    if (!onFix || !issue.autoFixable) return;
    setFixing(true);
    setError(null);
    try {
      await onFix(issue);
      setFixed(true);
    } catch (err) {
      console.error("Failed to fix issue:", err);
      setError(err instanceof Error ? err.message : "Failed to apply auto-fix");
    } finally {
      setFixing(false);
    }
  };

  const severityColor = {
    low: "border-blue-500/30 bg-blue-500/10",
    medium: "border-orange-500/30 bg-orange-500/10",
    high: "border-red-500/30 bg-red-500/10",
  }[issue.severity];

  const severityIcon = {
    low: <AlertTriangle className="w-5 h-5 text-blue-400" />,
    medium: <AlertTriangle className="w-5 h-5 text-orange-400" />,
    high: <AlertTriangle className="w-5 h-5 text-red-400" />,
  }[issue.severity];

  return (
    <div className={`border rounded-lg p-4 ${severityColor}`}>
      <div className="flex items-start justify-between">
        <div className="flex items-start space-x-3 flex-1">
          {fixed ? (
            <CheckCircle className="w-5 h-5 text-green-400 flex-shrink-0 mt-0.5" />
          ) : (
            <div className="flex-shrink-0 mt-0.5">{severityIcon}</div>
          )}
          <div className="flex-1">
            <div className="flex items-center space-x-2 mb-1">
              <h4 className="font-medium text-white">{issue.targetName}</h4>
              <span className="text-xs text-gray-400 capitalize">({issue.checkType.replace(/_/g, " ")})</span>
            </div>
            <p className="text-sm text-gray-300">{issue.description}</p>
            {issue.suggestedFix && (
              <p className="text-xs text-gray-400 mt-2">
                <strong>Suggested fix:</strong> {issue.suggestedFix}
              </p>
            )}
            {fixed && (
              <p className="text-xs text-green-400 mt-2 flex items-center space-x-1">
                <CheckCircle className="w-3 h-3" />
                <span>Auto-fix applied successfully</span>
              </p>
            )}
            {error && (
              <p className="text-xs text-red-400 mt-2 flex items-center space-x-1">
                <AlertTriangle className="w-3 h-3" />
                <span>{error}</span>
              </p>
            )}
          </div>
        </div>

        {issue.autoFixable && !fixed && onFix && (
          <button
            onClick={handleFix}
            disabled={fixing}
            className="flex items-center space-x-2 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white text-sm rounded transition ml-4"
          >
            {fixing ? (
              <>
                <Loader className="w-4 h-4 animate-spin" />
                <span>Fixing...</span>
              </>
            ) : (
              <>
                <Wrench className="w-4 h-4" />
                <span>Auto-Fix</span>
              </>
            )}
          </button>
        )}
      </div>
    </div>
  );
}

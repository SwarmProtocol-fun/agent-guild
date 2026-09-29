"use client";

import { useMemo } from "react";

interface BudgetBurnGaugeProps {
  currentSpend: number;
  threshold: number;
  period: "daily" | "weekly" | "monthly";
  label?: string;
}

export function BudgetBurnGauge({
  currentSpend,
  threshold,
  period,
  label,
}: BudgetBurnGaugeProps) {
  const percentage = useMemo(() => {
    if (threshold === 0) return 0;
    return Math.min((currentSpend / threshold) * 100, 100);
  }, [currentSpend, threshold]);

  const color = useMemo(() => {
    if (percentage < 50) return "text-green-400";
    if (percentage < 75) return "text-yellow-400";
    if (percentage < 90) return "text-orange-400";
    return "text-red-400";
  }, [percentage]);

  const bgColor = useMemo(() => {
    if (percentage < 50) return "stroke-green-500";
    if (percentage < 75) return "stroke-yellow-500";
    if (percentage < 90) return "stroke-orange-500";
    return "stroke-red-500";
  }, [percentage]);

  // SVG circle parameters for gauge
  const radius = 80;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (percentage / 100) * circumference;

  const periodLabel = useMemo(() => {
    switch (period) {
      case "daily":
        return "Today";
      case "weekly":
        return "This Week";
      case "monthly":
        return "This Month";
    }
  }, [period]);

  return (
    <div className="flex flex-col items-center space-y-4">
      <div className="relative">
        <svg className="w-48 h-48 transform -rotate-90">
          {/* Background circle */}
          <circle
            cx="96"
            cy="96"
            r={radius}
            stroke="rgb(31, 41, 55)" // gray-800
            strokeWidth="12"
            fill="none"
          />
          {/* Progress circle */}
          <circle
            cx="96"
            cy="96"
            r={radius}
            className={bgColor}
            strokeWidth="12"
            fill="none"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            strokeLinecap="round"
            style={{
              transition: "stroke-dashoffset 0.5s ease-in-out",
            }}
          />
        </svg>
        {/* Center text */}
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className={`text-4xl font-bold ${color}`}>
            {percentage.toFixed(0)}%
          </span>
          <span className="text-sm text-gray-400 mt-1">{periodLabel}</span>
        </div>
      </div>

      {/* Stats below gauge */}
      <div className="text-center space-y-1">
        {label && <p className="text-sm font-medium text-gray-300">{label}</p>}
        <div className="flex items-center justify-center space-x-2 text-sm">
          <span className={color}>
            ${currentSpend.toFixed(2)}
          </span>
          <span className="text-gray-500">/</span>
          <span className="text-gray-400">
            ${threshold.toFixed(2)}
          </span>
        </div>
        <p className="text-xs text-gray-500">
          {threshold - currentSpend > 0
            ? `$${(threshold - currentSpend).toFixed(2)} remaining`
            : `$${(currentSpend - threshold).toFixed(2)} over budget`}
        </p>
      </div>
    </div>
  );
}

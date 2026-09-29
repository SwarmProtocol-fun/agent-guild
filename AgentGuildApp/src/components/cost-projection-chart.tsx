"use client";

import { useMemo } from "react";
import { Line } from "react-chartjs-2";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler,
} from "chart.js";
import { type DailyCost } from "@/lib/usage";

/** Inline — extracted from cost-intelligence mod */
interface CostProjection {
  date: string;
  projected: number;
  lower: number;
  upper: number;
}

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler
);

interface CostProjectionChartProps {
  historical: DailyCost[];
  projections: CostProjection[];
}

export function CostProjectionChart({ historical, projections }: CostProjectionChartProps) {
  const chartData = useMemo(() => {
    // Last 30 days of historical data
    const histDates = historical.map((d) => d.date);
    const histCosts = historical.map((d) => d.costUsd);

    // Projected dates and costs
    const projDates = projections.map((p) => p.date);
    const projCosts = projections.map((p) => p.projected);

    // Combine for x-axis labels
    const allDates = [...histDates, ...projDates];

    // Historical line (pad with nulls for projection dates)
    const historicalLine = [...histCosts, ...Array(projDates.length).fill(null)];

    // Projection line (pad with nulls for historical dates, except last historical point for continuity)
    const lastHistCost = histCosts[histCosts.length - 1] || 0;
    const projectionLine = [
      ...Array(histDates.length - 1).fill(null),
      lastHistCost,
      ...projCosts,
    ];

    return {
      labels: allDates,
      datasets: [
        {
          label: "Historical Cost",
          data: historicalLine,
          borderColor: "rgb(59, 130, 246)", // blue-500
          backgroundColor: "rgba(59, 130, 246, 0.1)",
          borderWidth: 2,
          tension: 0.3,
          fill: true,
          pointRadius: 3,
          pointHoverRadius: 5,
        },
        {
          label: "Projected Cost",
          data: projectionLine,
          borderColor: "rgb(168, 85, 247)", // purple-500
          backgroundColor: "rgba(168, 85, 247, 0.1)",
          borderWidth: 2,
          borderDash: [5, 5], // Dashed line for projections
          tension: 0.3,
          fill: true,
          pointRadius: 3,
          pointHoverRadius: 5,
        },
      ],
    };
  }, [historical, projections]);

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        position: "top" as const,
        labels: {
          color: "rgb(156, 163, 175)", // gray-400
          font: { size: 12 },
        },
      },
      title: {
        display: true,
        text: "30-Day Historical + 7-Day Forecast",
        color: "rgb(229, 231, 235)", // gray-200
        font: { size: 16 },
      },
      tooltip: {
        mode: "index" as const,
        intersect: false,
        callbacks: {
          label: (context: any) => {
            const label = context.dataset.label || "";
            const value = context.parsed.y;
            return value !== null ? `${label}: $${value.toFixed(2)}` : "";
          },
        },
      },
    },
    scales: {
      x: {
        ticks: {
          color: "rgb(156, 163, 175)", // gray-400
          maxTicksLimit: 10,
        },
        grid: {
          color: "rgba(75, 85, 99, 0.3)", // gray-600
        },
      },
      y: {
        ticks: {
          color: "rgb(156, 163, 175)", // gray-400
          callback: (value: any) => `$${value.toFixed(2)}`,
        },
        grid: {
          color: "rgba(75, 85, 99, 0.3)", // gray-600
        },
        beginAtZero: true,
      },
    },
  };

  return (
    <div className="h-[400px] w-full">
      <Line data={chartData} options={options} />
    </div>
  );
}

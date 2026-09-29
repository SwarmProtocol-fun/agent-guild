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
} from "chart.js";
import { type VitalsRecord } from "@/lib/vitals-collector";

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend
);

interface VitalsChartProps {
  records: VitalsRecord[];
  metric?: "cpu" | "memory" | "disk" | "all";
}

export function VitalsChart({ records, metric = "all" }: VitalsChartProps) {
  const chartData = useMemo(() => {
    if (records.length === 0) {
      return {
        labels: [],
        datasets: [],
      };
    }

    // Sort by timestamp
    const sorted = [...records].sort((a, b) => {
      if (!a.timestamp || !b.timestamp) return 0;
      return a.timestamp.getTime() - b.timestamp.getTime();
    });

    // Format labels (time)
    const labels = sorted.map((r) => {
      if (!r.timestamp) return "";
      return r.timestamp.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
    });

    // Datasets
    const datasets: any[] = [];

    if (metric === "cpu" || metric === "all") {
      datasets.push({
        label: "CPU %",
        data: sorted.map((r) => r.vitals.cpu),
        borderColor: "rgb(239, 68, 68)", // red-500
        backgroundColor: "rgba(239, 68, 68, 0.1)",
        borderWidth: 2,
        tension: 0.3,
        pointRadius: 2,
        pointHoverRadius: 4,
      });
    }

    if (metric === "memory" || metric === "all") {
      datasets.push({
        label: "Memory %",
        data: sorted.map((r) => r.vitals.memory),
        borderColor: "rgb(59, 130, 246)", // blue-500
        backgroundColor: "rgba(59, 130, 246, 0.1)",
        borderWidth: 2,
        tension: 0.3,
        pointRadius: 2,
        pointHoverRadius: 4,
      });
    }

    if (metric === "disk" || metric === "all") {
      datasets.push({
        label: "Disk %",
        data: sorted.map((r) => r.vitals.disk),
        borderColor: "rgb(34, 197, 94)", // green-500
        backgroundColor: "rgba(34, 197, 94, 0.1)",
        borderWidth: 2,
        tension: 0.3,
        pointRadius: 2,
        pointHoverRadius: 4,
      });
    }

    return { labels, datasets };
  }, [records, metric]);

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
        text: "System Resource Usage",
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
            return `${label}: ${value.toFixed(1)}%`;
          },
        },
      },
    },
    scales: {
      x: {
        ticks: {
          color: "rgb(156, 163, 175)", // gray-400
          maxTicksLimit: 12,
        },
        grid: {
          color: "rgba(75, 85, 99, 0.3)", // gray-600
        },
      },
      y: {
        min: 0,
        max: 100,
        ticks: {
          color: "rgb(156, 163, 175)", // gray-400
          callback: (value: any) => `${value}%`,
        },
        grid: {
          color: "rgba(75, 85, 99, 0.3)", // gray-600
        },
      },
    },
  };

  if (records.length === 0) {
    return (
      <div className="h-[400px] w-full flex items-center justify-center text-gray-400">
        <p>No vitals data available</p>
      </div>
    );
  }

  return (
    <div className="h-[400px] w-full">
      <Line data={chartData} options={options} />
    </div>
  );
}

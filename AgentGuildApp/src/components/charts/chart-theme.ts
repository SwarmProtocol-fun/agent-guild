"use client";

import { useSkin } from "@/contexts/SkinContext";

export interface ChartPalette {
  primary: string;
  secondary: string;
  accent: string;
  success: string;
  warning: string;
  danger: string;
  muted: string;
  grid: string;
  tooltip: { bg: string; border: string; text: string };
  task: { done: string; inProgress: string; todo: string };
  agent: { online: string; busy: string; offline: string };
}

const SKIN_PALETTES: Record<string, ChartPalette> = {
  classic: {
    primary: "#f59e0b",
    secondary: "#d97706",
    accent: "#fbbf24",
    success: "#10b981",
    warning: "#f59e0b",
    danger: "#ef4444",
    muted: "#6b7280",
    grid: "rgba(255,255,255,0.06)",
    tooltip: { bg: "rgba(0,0,0,0.85)", border: "rgba(245,158,11,0.3)", text: "#f5f5f5" },
    task: { done: "#10b981", inProgress: "#f59e0b", todo: "#4b5563" },
    agent: { online: "#10b981", busy: "#f59e0b", offline: "#4b5563" },
  },
  futuristic: {
    primary: "#26dafd",
    secondary: "#fc26fa",
    accent: "#be26fc",
    success: "#00e5a0",
    warning: "#26dafd",
    danger: "#ff4d6a",
    muted: "#5b6b7d",
    grid: "rgba(38,218,253,0.06)",
    tooltip: { bg: "rgba(0,10,20,0.9)", border: "rgba(38,218,253,0.3)", text: "#e0f7ff" },
    task: { done: "#00e5a0", inProgress: "#26dafd", todo: "#3a4a5c" },
    agent: { online: "#00e5a0", busy: "#26dafd", offline: "#3a4a5c" },
  },
  "retro-terminal": {
    primary: "#ff6a00",
    secondary: "#994400",
    accent: "#ff9d00",
    success: "#00cc44",
    warning: "#ff6a00",
    danger: "#ff3333",
    muted: "#665533",
    grid: "rgba(255,106,0,0.06)",
    tooltip: { bg: "rgba(10,5,0,0.9)", border: "rgba(255,106,0,0.3)", text: "#ffd4a8" },
    task: { done: "#00cc44", inProgress: "#ff6a00", todo: "#4a3a2a" },
    agent: { online: "#00cc44", busy: "#ff6a00", offline: "#4a3a2a" },
  },
  cyberpunk: {
    primary: "#ff1493",
    secondary: "#8a2be2",
    accent: "#c026d3",
    success: "#00ff88",
    warning: "#ff1493",
    danger: "#ff0044",
    muted: "#5a3a6a",
    grid: "rgba(255,20,147,0.06)",
    tooltip: { bg: "rgba(15,0,20,0.9)", border: "rgba(255,20,147,0.3)", text: "#ffe0f0" },
    task: { done: "#00ff88", inProgress: "#ff1493", todo: "#4a2a5a" },
    agent: { online: "#00ff88", busy: "#ff1493", offline: "#4a2a5a" },
  },
  midnight: {
    primary: "#6366f1",
    secondary: "#a855f7",
    accent: "#818cf8",
    success: "#34d399",
    warning: "#6366f1",
    danger: "#f43f5e",
    muted: "#4a4a6a",
    grid: "rgba(99,102,241,0.06)",
    tooltip: { bg: "rgba(5,0,20,0.9)", border: "rgba(99,102,241,0.3)", text: "#e0e0ff" },
    task: { done: "#34d399", inProgress: "#6366f1", todo: "#3a3a5a" },
    agent: { online: "#34d399", busy: "#6366f1", offline: "#3a3a5a" },
  },
  hacker: {
    primary: "#00ff41",
    secondary: "#00802b",
    accent: "#66ff8c",
    success: "#00ff41",
    warning: "#ccff00",
    danger: "#ff3333",
    muted: "#2a5a2a",
    grid: "rgba(0,255,65,0.06)",
    tooltip: { bg: "rgba(0,10,0,0.9)", border: "rgba(0,255,65,0.3)", text: "#ccffcc" },
    task: { done: "#00ff41", inProgress: "#ccff00", todo: "#1a3a1a" },
    agent: { online: "#00ff41", busy: "#ccff00", offline: "#1a3a1a" },
  },
  pokemon: {
    primary: "#ee1515",
    secondary: "#3b4cca",
    accent: "#ffcb05",
    success: "#78c850",
    warning: "#f8d030",
    danger: "#ee1515",
    muted: "#705898",
    grid: "rgba(238,21,21,0.06)",
    tooltip: { bg: "rgba(30,30,50,0.95)", border: "rgba(238,21,21,0.4)", text: "#ffffff" },
    task: { done: "#78c850", inProgress: "#f8d030", todo: "#705898" },
    agent: { online: "#78c850", busy: "#f8d030", offline: "#705898" },
  },
  mecha: {
    primary: "#58a6ff",
    secondary: "#3fb950",
    accent: "#d29922",
    success: "#3fb950",
    warning: "#d29922",
    danger: "#f85149",
    muted: "#484f58",
    grid: "rgba(88,166,255,0.06)",
    tooltip: { bg: "rgba(13,17,23,0.95)", border: "rgba(88,166,255,0.3)", text: "#e6edf3" },
    task: { done: "#3fb950", inProgress: "#d29922", todo: "#30363d" },
    agent: { online: "#3fb950", busy: "#d29922", offline: "#484f58" },
  },
  jrpg: {
    primary: "#ffd700",
    secondary: "#4dccff",
    accent: "#ff6b6b",
    success: "#00ff88",
    warning: "#ffd700",
    danger: "#ff4444",
    muted: "#3a3a6e",
    grid: "rgba(255,215,0,0.06)",
    tooltip: { bg: "rgba(10,10,46,0.95)", border: "rgba(255,215,0,0.4)", text: "#ffffff" },
    task: { done: "#00ff88", inProgress: "#ffd700", todo: "#2a2a5e" },
    agent: { online: "#00ff88", busy: "#ffd700", offline: "#2a2a5e" },
  },
};

export function useChartPalette(): ChartPalette {
  const { skin } = useSkin();
  return SKIN_PALETTES[skin] || SKIN_PALETTES.classic;
}

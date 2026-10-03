"use client";

/**
 * Top-down DimSim floor plan for the trainer: the occupancy grid the sim
 * raycasts once (agentGuildEmbed.js floorPlan), object footprints, the target
 * with its pass distance, the live trail, and the best attempt so far as a
 * ghost. Drawn in floor-plan metres (x right, z down), like the replay map.
 */
import { useMemo } from "react";
import { token } from "./replay-view";
import type { SimPose } from "./training";

export interface FloorPlan {
  x0: number;
  z0: number;
  cell: number;
  cols: number;
  rows: number;
  /** One char per cell, row-major: "." floor, "u" under a table (walkable), "f" furniture, "#" wall, " " no floor. Empty if the sim has no floor colliders. */
  cells: string;
  objects: { id: string; title: string; x: number; z: number; w: number; d: number }[];
}

/** DimSim's findAsset: first object whose title or id contains the target (case-insensitive). */
export function findObject(plan: FloorPlan, target: string) {
  const q = target.toLowerCase();
  return plan.objects.find((o) => o.title.toLowerCase().includes(q) || o.id.toLowerCase().includes(q)) ?? null;
}

const cellPath = (plan: FloorPlan, kind: string) => {
  let d = "";
  const c = plan.cell;
  for (let k = 0; k < plan.cells.length; k++) {
    if (plan.cells[k] !== kind) continue;
    const x = plan.x0 + (k % plan.cols) * c, z = plan.z0 + Math.floor(k / plan.cols) * c;
    d += `M${x.toFixed(2)} ${z.toFixed(2)}h${c}v${c}h${-c}z`;
  }
  return d;
};

const line = (ps: SimPose[]) => ps.map((p) => `${p.x},${p.z}`).join(" ");

export function SimMap({
  plan, target, thresholdM, trail, ghost, onPick,
}: {
  plan: FloorPlan;
  target: string;
  thresholdM: number;
  /** This attempt's poses so far, start first. */
  trail: SimPose[];
  /** The best earlier attempt at this task. */
  ghost: SimPose[];
  /** Click an object to make it the target (only while idle). */
  onPick?: (id: string) => void;
}) {
  const bg = useMemo(
    () => ({ floor: cellPath(plan, "."), under: cellPath(plan, "u"), furniture: cellPath(plan, "f"), wall: cellPath(plan, "#") }),
    [plan],
  );
  const W = plan.cols * plan.cell, H = plan.rows * plan.cell;
  const goal = findObject(plan, target);
  const here = trail[trail.length - 1];
  const sw = Math.max(W, H) / 220; // stroke width ≈ 1 px at typical size

  return (
    <svg viewBox={`${plan.x0} ${plan.z0} ${W} ${H}`} className="w-full h-auto rounded border" style={{ background: token("muted") }} role="img" aria-label="Floor plan with the robot's path">
      <path d={bg.floor} fill={token("background")} />
      <path d={bg.under} fill={token("muted-foreground")} opacity={0.1} />
      <path d={bg.furniture} fill={token("muted-foreground")} opacity={0.25} />
      <path d={bg.wall} fill={token("foreground")} opacity={0.7} />
      {plan.objects.map((o) => (
        <rect
          key={o.id}
          x={o.x - o.w / 2} y={o.z - o.d / 2} width={o.w} height={o.d}
          fill="none" stroke={token("muted-foreground")} strokeWidth={sw * 0.6} opacity={0.6}
          style={onPick ? { cursor: "pointer", pointerEvents: "all" } : undefined}
          onClick={onPick ? () => onPick(o.id) : undefined}
        >
          <title>{o.title.split("\n")[0]}{onPick ? " — click to make it the target" : ""}</title>
        </rect>
      ))}
      {goal && (
        <g>
          <rect
            x={goal.x - goal.w / 2 - thresholdM} y={goal.z - goal.d / 2 - thresholdM}
            width={goal.w + 2 * thresholdM} height={goal.d + 2 * thresholdM} rx={thresholdM}
            fill={token("primary")} opacity={0.1} stroke={token("primary")} strokeWidth={sw} strokeDasharray={`${sw * 4} ${sw * 3}`}
          />
          <rect x={goal.x - goal.w / 2} y={goal.z - goal.d / 2} width={goal.w} height={goal.d} fill={token("primary")} opacity={0.6} />
        </g>
      )}
      {ghost.length > 1 && (
        <polyline points={line(ghost)} fill="none" stroke={token("muted-foreground")} strokeWidth={sw * 1.5} strokeDasharray={`${sw * 3} ${sw * 3}`} opacity={0.8}>
          <title>best attempt so far</title>
        </polyline>
      )}
      {trail.length > 1 && <polyline points={line(trail)} fill="none" stroke={token("primary")} strokeWidth={sw * 2} strokeLinejoin="round" />}
      {trail[0] && <circle cx={trail[0].x} cy={trail[0].z} r={sw * 3} fill="none" stroke={token("primary")} strokeWidth={sw * 1.5}><title>start</title></circle>}
      {here && (
        <g transform={`translate(${here.x} ${here.z})`}>
          <line x1={0} y1={0} x2={Math.sin((here.yaw * Math.PI) / 180) * 0.6} y2={Math.cos((here.yaw * Math.PI) / 180) * 0.6} stroke={token("primary")} strokeWidth={sw * 2} strokeLinecap="round" />
          <circle r={0.18} fill={token("primary")} />
        </g>
      )}
    </svg>
  );
}

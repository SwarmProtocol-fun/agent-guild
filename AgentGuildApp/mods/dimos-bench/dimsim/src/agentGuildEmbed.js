/**
 * Agent Guild embed mode (?dimos=1&embed=1&scene=…) — not part of upstream DimSim.
 *
 * Upstream dimos mode drives the robot from a Deno bridge (server physics,
 * LCM). Embedded in the dimOS Benchmarks panel there is no bridge, so the
 * robot is driven here instead, one discrete action at a time, and the panel
 * (same origin, parent window) calls `window.__agentGuild`:
 *
 *   ready            Promise that resolves once the scene and robot are up
 *   observe()        { jpeg (base64), width, height, pose: {x, z, yaw} }
 *   act({forward, turn})  turn (degrees, + = left) then move `forward` metres,
 *                    stopping short of walls/furniture; returns { pose, blocked }
 *   reset(pose)      teleport to {x, z, yaw (degrees)}
 *   score(target, thresholdM)  DimSim's objectDistance rubric, unchanged
 *   objects()        [{ id, title }] of the scene's objects, for task targets
 *   panorama()       four JPEGs: front, left, back, right (the robot ends where it started)
 *   floorPlan()      occupancy grid + object footprints, for the panel's minimap
 *   randomStart(target, thresholdM)  a collision-free pose reachable from the
 *                    default start and well outside the target's pass distance
 *
 * Coordinates are DimSim's: y up, forward = (sin yaw, 0, cos yaw).
 */
import { objectDistance } from "../evals/rubrics.ts";

const STEP_M = 0.05; // collision-checked increments
const CLEARANCE_M = 0.12; // stop this far from an obstacle
const RAY_HEIGHTS = [-0.25, -0.1, 0.05]; // relative to the body centre (0.5 m when standing)
const PLAN_CELL_M = 0.2; // floor plan resolution
const DEFAULT_START = { x: 0, z: 3 };

export function installEmbedApi({ RAPIER, rapierWorld, agent, ignoreCollider, captureRgb, getSceneState, setYaw, getYaw, followAgent }) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const radius = agent.radius || 0.12;
  const bodyY = () => agent.getPosition()[1];

  const feetY = bodyY() - ((agent.halfHeight || 0.25) + radius);

  const castFrom = (x, y, z, dir, max) => {
    const hit = rapierWorld.castRay(new RAPIER.Ray({ x, y, z }, dir), max, true, undefined, undefined, ignoreCollider ?? undefined, agent.body);
    return hit ? (hit.timeOfImpact ?? hit.toi) : null;
  };

  const encode = (frame) => {
    canvas.width = frame.width;
    canvas.height = frame.height;
    ctx.putImageData(
      new ImageData(new Uint8ClampedArray(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength), frame.width, frame.height),
      0, 0,
    );
    return canvas.toDataURL("image/jpeg", 0.7).split("base64,")[1];
  };

  /**
   * Occupancy grid by raycasting, computed once (the scene is static). Per cell:
   * "." walkable floor, "u" under a table top (walkable, like act()'s body-height
   * rays), "f" furniture (something 0.15–1 m up), "#" wall or edge (a body-height
   * probe hits within half a cell), " " no floor. `reach` marks walkable cells
   * connected to the floor cell nearest the default start.
   */
  let plan = null;
  const buildPlan = () => {
    const objs = (getSceneState().assets ?? [])
      .filter((a) => a.transform && a._bbox)
      .map((a) => ({ id: a.id, title: a.title ?? a.id, x: round(a.transform.x), z: round(a.transform.z), w: round(a._bbox.w), d: round(a._bbox.d) }));
    let minX = DEFAULT_START.x, maxX = DEFAULT_START.x, minZ = DEFAULT_START.z, maxZ = DEFAULT_START.z;
    for (const o of objs) {
      minX = Math.min(minX, o.x - o.w / 2); maxX = Math.max(maxX, o.x + o.w / 2);
      minZ = Math.min(minZ, o.z - o.d / 2); maxZ = Math.max(maxZ, o.z + o.d / 2);
    }
    const x0 = Math.floor(minX - 1), z0 = Math.floor(minZ - 1);
    const cols = Math.ceil((maxX + 1 - x0) / PLAN_CELL_M), rows = Math.ceil((maxZ + 1 - z0) / PLAN_CELL_M);
    const cells = new Array(cols * rows);
    const probes = [{ x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 }];
    let hits = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = x0 + (c + 0.5) * PLAN_CELL_M, z = z0 + (r + 0.5) * PLAN_CELL_M;
        const toi = castFrom(x, feetY + 1, z, { x: 0, y: -1, z: 0 }, 2);
        let cell = " ";
        if (toi != null) {
          hits++;
          const h = 1 - toi;
          const walled = () => probes.some((d) => castFrom(x, feetY + 0.3, z, d, PLAN_CELL_M / 2) != null);
          if (h > 0.95) cell = "#";
          else if (h <= 0.15) cell = walled() ? "#" : ".";
          else if (h >= 0.6 && 0.55 - (castFrom(x, feetY + 0.55, z, { x: 0, y: -1, z: 0 }, 1) ?? 1) <= 0.15) {
            cell = walled() ? "f" : "u"; // a table top above, clear floor below
          } else cell = "f";
        }
        cells[r * cols + c] = cell;
      }
    }
    const idx = (x, z) => {
      const c = Math.floor((x - x0) / PLAN_CELL_M), r = Math.floor((z - z0) / PLAN_CELL_M);
      return c >= 0 && c < cols && r >= 0 && r < rows ? r * cols + c : -1;
    };
    // Flood fill over walkable cells from the open floor nearest the default start.
    const walkable = (k) => cells[k] === "." || cells[k] === "u";
    const reach = new Uint8Array(cols * rows);
    let s0 = -1;
    for (let rad = 0; rad < 10 && s0 < 0; rad++) {
      for (let dz = -rad; dz <= rad && s0 < 0; dz++) for (let dx = -rad; dx <= rad && s0 < 0; dx++) {
        const k = idx(DEFAULT_START.x + dx * PLAN_CELL_M, DEFAULT_START.z + dz * PLAN_CELL_M);
        if (k >= 0 && cells[k] === ".") s0 = k;
      }
    }
    const queue = s0 >= 0 ? [s0] : [];
    if (queue.length) reach[s0] = 1;
    while (queue.length) {
      const k = queue.pop(), c = k % cols, r = (k - c) / cols;
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nc = c + dc, nr = r + dr, n = nr * cols + nc;
        if (nc >= 0 && nc < cols && nr >= 0 && nr < rows && !reach[n] && walkable(n)) {
          reach[n] = 1;
          queue.push(n);
        }
      }
    }
    plan = { x0, z0, cell: PLAN_CELL_M, cols, rows, cells: cells.join(""), objects: objs, reach, ok: hits > cols * rows * 0.05 };
    return plan;
  };

  const pose = () => {
    const [x, , z] = agent.getPosition();
    return { x: round(x), z: round(z), yaw: round((getYaw() * 180) / Math.PI) };
  };

  const applyYaw = (yaw) => {
    setYaw(yaw);
    if (agent.group) agent.group.rotation.y = yaw;
  };

  /**
   * Free distance ahead along `dir`. Rays sit at a Go2's body heights (~0.25–0.55 m
   * off the floor), so it is stopped by walls and chairs but can pass under table tops.
   */
  const clearAhead = (dir) => {
    const [x, y, z] = agent.getPosition();
    let free = Infinity;
    for (const dy of RAY_HEIGHTS) {
      const ray = new RAPIER.Ray({ x, y: y + dy, z }, { x: dir.x, y: 0, z: dir.z });
      // Skip the robot's own body and the (hidden) player capsule.
      const hit = rapierWorld.castRay(ray, 20, true, undefined, undefined, ignoreCollider ?? undefined, agent.body);
      if (hit) free = Math.min(free, hit.timeOfImpact ?? hit.toi);
    }
    return free;
  };

  const api = {
    observe() {
      const frame = captureRgb();
      return { jpeg: encode(frame), width: frame.width, height: frame.height, pose: pose() };
    },

    panorama() {
      const yaw0 = getYaw();
      const views = [0, 90, 180, 270].map((deg) => {
        applyYaw(yaw0 + (deg * Math.PI) / 180);
        return encode(captureRgb());
      });
      applyYaw(yaw0);
      agent._syncVisual?.();
      return views;
    },

    floorPlan() {
      const p = plan ?? buildPlan();
      return { x0: p.x0, z0: p.z0, cell: p.cell, cols: p.cols, rows: p.rows, cells: p.ok ? p.cells : "", objects: p.objects };
    },

    randomStart(target, thresholdM) {
      const p = plan ?? buildPlan();
      const y = bodyY();
      const state = getSceneState();
      const clear = (k) => {
        const c = k % p.cols, r = (k - c) / p.cols;
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
          const n = (r + dr) * p.cols + (c + dc);
          if (r + dr < 0 || r + dr >= p.rows || c + dc < 0 || c + dc >= p.cols || !p.reach[n]) return false;
        }
        return true;
      };
      const candidates = [];
      for (let k = 0; k < p.reach.length; k++) {
        if (!p.reach[k] || p.cells[k] !== "." || !clear(k)) continue;
        const c = k % p.cols, r = (k - c) / p.cols;
        const x = p.x0 + (c + 0.5) * p.cell, z = p.z0 + (r + 0.5) * p.cell;
        const d = objectDistance({ agentPos: { x, y, z }, sceneState: state }, { target, thresholdM }).score;
        if (Number.isFinite(d) && d > thresholdM + 1) candidates.push({ x, z });
      }
      if (!candidates.length) return null;
      const pick = candidates[Math.floor(Math.random() * candidates.length)];
      return { x: round(pick.x), z: round(pick.z), yaw: Math.round(Math.random() * 24) * 15 - 180 };
    },

    act({ forward = 0, turn = 0 } = {}) {
      applyYaw(getYaw() + (clamp(turn, -180, 180) * Math.PI) / 180);
      const dist = clamp(forward, -1, 2);
      const sign = Math.sign(dist);
      const yaw = getYaw();
      const dir = { x: Math.sin(yaw) * sign, z: Math.cos(yaw) * sign };
      let moved = 0;
      let blocked = false;
      while (moved < Math.abs(dist) - 1e-6) {
        const step = Math.min(STEP_M, Math.abs(dist) - moved);
        if (clearAhead(dir) < radius + CLEARANCE_M + step) {
          blocked = true;
          break;
        }
        const [x, y, z] = agent.getPosition();
        agent.setPosition(x + dir.x * step, y, z + dir.z * step);
        moved += step;
      }
      agent._syncVisual?.();
      return { pose: pose(), blocked, moved: round(moved * sign) };
    },

    reset({ x = 0, z = 3, yaw = 0 } = {}) {
      agent.setPosition(x, bodyY(), z);
      applyYaw((yaw * Math.PI) / 180);
      agent._syncVisual?.();
      return pose();
    },

    score(target, thresholdM) {
      const [x, y, z] = agent.getPosition();
      return objectDistance({ agentPos: { x, y, z }, sceneState: getSceneState() }, { target, thresholdM });
    },

    objects() {
      return (getSceneState().assets ?? []).filter((a) => a.id).map((a) => ({ id: a.id, title: a.title ?? a.id }));
    },
  };

  followAgent();
  window.__agentGuild = Object.assign(window.__agentGuild ?? {}, api);
  window.__agentGuildReady?.(api);
  return api;
}

function clamp(v, lo, hi) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : 0;
}

function round(v) {
  return Math.round(v * 1000) / 1000;
}

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
 *   objects()        titles of the scene's objects, for task targets
 *
 * Coordinates are DimSim's: y up, forward = (sin yaw, 0, cos yaw).
 */
import { objectDistance } from "../evals/rubrics.ts";

const STEP_M = 0.05; // collision-checked increments
const CLEARANCE_M = 0.12; // stop this far from an obstacle
const RAY_HEIGHTS = [-0.25, -0.1, 0.05]; // relative to the body centre (0.5 m when standing)

export function installEmbedApi({ RAPIER, rapierWorld, agent, ignoreCollider, captureRgb, getSceneState, setYaw, getYaw, followAgent }) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const radius = agent.radius || 0.12;
  const bodyY = () => agent.getPosition()[1];

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
      canvas.width = frame.width;
      canvas.height = frame.height;
      ctx.putImageData(
        new ImageData(new Uint8ClampedArray(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength), frame.width, frame.height),
        0, 0,
      );
      const jpeg = canvas.toDataURL("image/jpeg", 0.7).split("base64,")[1];
      return { jpeg, width: frame.width, height: frame.height, pose: pose() };
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
      return (getSceneState().assets ?? []).map((a) => a.title ?? a.id).filter(Boolean);
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

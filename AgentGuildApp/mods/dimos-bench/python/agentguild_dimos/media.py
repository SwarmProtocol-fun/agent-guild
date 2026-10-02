"""What the robot actually did in each case: its path, what its camera saw, what it was told.

dimOS records every robot environment to a memory store (``artifacts["recording"]``:
a sim's live ``memory.db``, or a ``Dataset``'s frozen ``.db``). That store is
closed when the case ends, so ``capture_case(case, case_dir)`` wraps the case's
environment and samples it in ``stop()``, just before dimOS closes it. The
sample is written to ``<run_dir>/<case_id>/robot.json``:

  {"caseId", "environment", "source", "t0",
   "path":    [[t, x, y, yaw], ...]          # odometry, ≤ MAX_POSES, t in s from t0
   "frames":  [{"t", "w", "h", "jpeg"}, ...] # camera keyframes, base64 JPEG, ≤ MAX_FRAMES
   "streams": [{"name", "count"}, ...]}

``actions(trajectory)`` adds the tool calls the agent made (robot commands),
read from ``<case_id>/trajectory.json``. ``agentguild-dimos submit`` uploads
``robot.json`` when it is there, so the panel can replay the case.

Everything here is best-effort: a recording we can't read leaves the case
without media; it never fails the eval.
"""

from __future__ import annotations

import base64
from collections.abc import Iterable, Iterator, Sequence
from contextlib import contextmanager
from datetime import datetime
import json
import math
from pathlib import Path
import time
from typing import Any

MAX_POSES = 400
MAX_FRAMES = 8
MAX_ACTIONS = 60
FRAME_W, FRAME_H = 360, 270
JPEG_QUALITY = 60
_POSE_STREAMS = ("odom", "odometry", "pose")
_IMAGE_STREAMS = ("color_image", "rgb", "image")


def _even(items: Sequence[Any], k: int) -> list[Any]:
    """At most ``k`` items, evenly spaced, always keeping the first and last."""
    if len(items) <= k:
        return list(items)
    if k == 1:
        return [items[-1]]
    return [items[round(i * (len(items) - 1) / (k - 1))] for i in range(k)]


def _yaw(qx: float, qy: float, qz: float, qw: float) -> float:
    return math.atan2(2 * (qw * qz + qx * qy), 1 - 2 * (qy * qy + qz * qz))


def pose_of(obs: Any) -> tuple[float, float, float] | None:
    """(x, y, yaw) from an observation's pose tuple, else from its payload."""
    p = getattr(obs, "pose_tuple", None)
    if p:
        return p[0], p[1], _yaw(p[3], p[4], p[5], p[6])
    data = getattr(obs, "data", None)
    pos = getattr(data, "position", None)
    rot = getattr(data, "orientation", None)
    if pos is None:
        return None
    yaw = _yaw(rot.x, rot.y, rot.z, rot.w) if rot is not None else 0.0
    return float(pos.x), float(pos.y), yaw


def jpeg_of(image: Any) -> tuple[str, int, int] | None:
    """A dimOS Image → (base64 JPEG, width, height), shrunk to fit the panel."""
    if not hasattr(image, "to_jpeg_bytes"):
        return None
    if hasattr(image, "resize_to_fit"):
        image, _ = image.resize_to_fit(FRAME_W, FRAME_H)
    return base64.b64encode(image.to_jpeg_bytes(quality=JPEG_QUALITY)).decode("ascii"), image.width, image.height


def _pick(names: Iterable[str], wanted: Sequence[str]) -> str | None:
    names = list(names)
    for w in wanted:
        if w in names:
            return w
    return next((n for n in names if any(w in n for w in wanted)), None)


def sample(store: Any, window: tuple[float | None, float | None]) -> dict[str, Any]:
    """Path, keyframes and stream counts from a memory store, within [t_from, t_to] (epoch s)."""
    t_from, t_to = window
    names = store.list_streams()

    def ranged(name: str) -> Any:
        # dimOS's after/before are strict; widen by 1 ms so samples on the edges stay in.
        s = store.stream(name)
        if t_from is not None:
            s = s.from_timestamp(t_from - 1e-3)
        if t_to is not None:
            s = s.to_timestamp(t_to + 1e-3)
        return s

    out: dict[str, Any] = {"path": [], "frames": [], "streams": []}
    for name in names:
        try:
            out["streams"].append({"name": name, "count": ranged(name).count()})
        except Exception:
            continue

    t0: float | None = None
    if pose_name := _pick(names, _POSE_STREAMS):
        poses = [(o.ts, pose_of(o)) for o in ranged(pose_name)]
        poses = [(ts, p) for ts, p in poses if p is not None]
        if poses:
            t0 = poses[0][0]
            out["path"] = [
                [round(ts - t0, 3), round(x, 3), round(y, 3), round(yaw, 3)]
                for ts, (x, y, yaw) in _even(poses, MAX_POSES)
            ]

    if image_name := _pick(names, _IMAGE_STREAMS):
        stream = ranged(image_name)
        n = stream.count()
        for i in _even(range(n), MAX_FRAMES):
            obs = stream.offset(i).limit(1).first()
            encoded = jpeg_of(obs.data)
            if encoded is None:
                break
            t0 = obs.ts if t0 is None else t0
            jpeg, w, h = encoded
            out["frames"].append({"t": round(obs.ts - t0, 3), "w": w, "h": h, "jpeg": jpeg})

    out["t0"] = t0
    return out


def _iso_epoch(stamp: str) -> float | None:
    try:
        return datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp()
    except (ValueError, AttributeError):
        return None


def actions(trajectory: dict[str, Any], t0: float | None) -> list[dict[str, Any]]:
    """Tool calls from an ATIF trajectory, as {t, name, args}; t is seconds from t0 when known."""
    out: list[dict[str, Any]] = []
    for step in trajectory.get("steps") or []:
        ts = _iso_epoch(step.get("timestamp", ""))
        for call in step.get("tool_calls") or []:
            out.append({
                "t": round(ts - t0, 3) if ts is not None and t0 is not None else None,
                "name": str(call.get("function_name", ""))[:80],
                "args": json.dumps(call.get("arguments") or {})[:200],
            })
    return _even(out, MAX_ACTIONS)


def _window_of(streams: Sequence[Any]) -> tuple[float | None, float | None]:
    """The time span a Dataset case selected, so its replay shows only that part."""
    spans = []
    for s in streams:
        try:
            spans.append(s.get_time_range())
        except Exception:
            continue
    if not spans:
        return None, None
    return min(a for a, _ in spans), max(b for _, b in spans)


def _open(path: Path) -> Any:
    from dimos.memory.cli.dataset import open_store  # .db or .mcap, read-only

    return open_store(path)


@contextmanager
def capture_case(case: Any, case_dir: Path) -> Iterator[None]:
    """While ``case`` runs, sample its robot into ``case_dir/robot.json`` just before its environment stops.

    Patches only this case's environment instance, and only for the duration, so
    an environment object shared by several cases is attributed correctly.
    """
    env = case.environment
    start, stop = env.start, env.stop
    state: dict[str, Any] = {}

    def wrapped_start(modules: Sequence[str]) -> Any:
        running = start(modules)
        state["recording"] = running.artifacts.get("recording")
        # A Dataset hands over the slice it selected; a sim records from now on.
        state["window"] = _window_of(running.streams) if running.streams else (time.time(), None)
        state["frozen"] = bool(running.streams)
        return running

    def wrapped_stop() -> None:
        try:
            recording = state.get("recording")
            if recording:
                t_from, t_to = state["window"]
                store = _open(Path(recording))
                try:
                    media = sample(store, (t_from, t_to if t_to is not None else time.time()))
                finally:
                    store.stop()
                media.update(
                    caseId=case.id,
                    environment=type(env).__name__,
                    source=str(getattr(getattr(env, "config", None), "name", "") or Path(recording).parent.name),
                    # A frozen recording's clock isn't the agent's, so actions can't be placed on it.
                    frozen=state["frozen"],
                )
                case_dir.mkdir(parents=True, exist_ok=True)
                (case_dir / "robot.json").write_text(json.dumps(media))
        except Exception as e:  # media is a bonus; never fail the case over it
            print(f"agentguild-dimos: no robot media for {case.id}: {e!r}")
        finally:
            stop()

    env.start, env.stop = wrapped_start, wrapped_stop
    try:
        yield
    finally:
        del env.start, env.stop  # back to the class methods


def load(run_dir: Path, case_id: str) -> dict[str, Any] | None:
    """``robot.json`` plus the agent's actions from ``trajectory.json``, or None if not captured."""
    case = run_dir / case_id
    try:
        media = json.loads((case / "robot.json").read_text())
    except (OSError, ValueError):
        return None
    try:
        trajectory = json.loads((case / "trajectory.json").read_text())
    except (OSError, ValueError):
        trajectory = {}
    # Action times are wall clock; frames/poses are relative to the recording's t0.
    media["actions"] = actions(trajectory, None if media.get("frozen") else media.get("t0"))
    return media

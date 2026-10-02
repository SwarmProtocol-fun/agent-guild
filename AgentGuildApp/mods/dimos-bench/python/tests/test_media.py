"""Robot replay capture against fake dimOS stores — no dimOS needed."""

from __future__ import annotations

import base64
from dataclasses import dataclass, field
import json
import math
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from agentguild_dimos import hub, identity, media
from agentguild_dimos.cli import main

from test_agentguild_dimos import make_identity, make_run

JPEG = b"\xff\xd8\xff\xe0fake"


class FakeImage:
    width, height = 640, 480

    def resize_to_fit(self, w: int, h: int) -> tuple[Any, float]:
        small = FakeImage()
        small.width, small.height = w, h
        return small, w / 640

    def to_jpeg_bytes(self, quality: int = 75) -> bytes:
        return JPEG


@dataclass
class FakeStream:
    obs: list[Any]

    def from_timestamp(self, t: float | None) -> FakeStream:
        return self if t is None else FakeStream([o for o in self.obs if o.ts > t])

    def to_timestamp(self, t: float | None) -> FakeStream:
        return self if t is None else FakeStream([o for o in self.obs if o.ts < t])

    def offset(self, n: int) -> FakeStream:
        return FakeStream(self.obs[n:])

    def limit(self, k: int) -> FakeStream:
        return FakeStream(self.obs[:k])

    def first(self) -> Any:
        return self.obs[0]

    def count(self) -> int:
        return len(self.obs)

    def get_time_range(self) -> tuple[float, float]:
        return self.obs[0].ts, self.obs[-1].ts

    def __iter__(self):  # type: ignore[no-untyped-def]
        return iter(self.obs)


@dataclass
class FakeStore:
    streams: dict[str, FakeStream]
    stopped: bool = field(default=False)

    def list_streams(self) -> list[str]:
        return list(self.streams)

    def stream(self, name: str) -> FakeStream:
        return self.streams[name]

    def stop(self) -> None:
        self.stopped = True


def store(t0: float = 1000.0) -> FakeStore:
    # Robot drives 10 m along +x over 10 s, turning to face +y at the end.
    odom = [
        SimpleNamespace(ts=t0 + i, pose_tuple=(float(i), 0.0, 0.0, 0.0, 0.0, math.sin(i * math.pi / 40), math.cos(i * math.pi / 40)))
        for i in range(11)
    ]
    images = [SimpleNamespace(ts=t0 + i * 0.5, data=FakeImage()) for i in range(21)]
    return FakeStore({"odom": FakeStream(odom), "color_image": FakeStream(images)})


def test_sample_path_and_keyframes() -> None:
    out = media.sample(store(), (None, None))
    assert out["t0"] == 1000.0
    assert len(out["path"]) == 11
    assert out["path"][0] == [0.0, 0.0, 0.0, 0.0]
    t, x, y, yaw = out["path"][-1]
    assert (t, x, y) == (10.0, 10.0, 0.0)
    assert yaw == pytest.approx(math.pi / 2, abs=1e-3)
    assert len(out["frames"]) == media.MAX_FRAMES
    assert [f["t"] for f in out["frames"]][0::7] == [0.0, 10.0]  # first and last kept
    assert base64.b64decode(out["frames"][0]["jpeg"]) == JPEG
    assert out["frames"][0]["w"] == media.FRAME_W
    assert {s["name"]: s["count"] for s in out["streams"]} == {"odom": 11, "color_image": 21}


def test_sample_window_and_downsampling(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(media, "MAX_POSES", 3)
    out = media.sample(store(), (1002.5, 1007.5))
    assert [p[1] for p in out["path"]] == [3.0, 5.0, 7.0]  # 1002.5..1007.5 holds poses 3..7


def test_actions_relative_to_recording() -> None:
    trajectory = {"steps": [
        {"timestamp": "1970-01-01T00:16:43Z", "tool_calls": [{"function_name": "navigate", "arguments": {"x": 3}}]},
        {"timestamp": "1970-01-01T00:16:50+00:00", "message": "done"},
    ]}
    assert media.actions(trajectory, 1000.0) == [{"t": 3.0, "name": "navigate", "args": '{"x": 3}'}]
    assert media.actions(trajectory, None)[0]["t"] is None


class Env:
    def __init__(self, recording: Path, streams: tuple = ()) -> None:
        self.recording, self.streams, self.config = recording, streams, SimpleNamespace(name="go2_short")
        self.stopped = 0

    def start(self, modules):  # type: ignore[no-untyped-def]
        return SimpleNamespace(artifacts={"recording": self.recording}, streams=self.streams)

    def stop(self) -> None:
        self.stopped += 1


def test_capture_case_writes_robot_json_and_unpatches(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    fake = store()
    monkeypatch.setattr(media, "_open", lambda path: fake)
    env = Env(tmp_path / "go2_short.db", streams=(fake.streams["color_image"].from_timestamp(1004.9),))
    case = SimpleNamespace(id="c1", environment=env)
    with media.capture_case(case, tmp_path / "c1"):
        env.start(())
        env.stop()
    assert env.stopped == 1 and fake.stopped
    assert "start" not in vars(env) and "stop" not in vars(env)  # class methods again
    robot = json.loads((tmp_path / "c1" / "robot.json").read_text())
    assert robot["caseId"] == "c1" and robot["environment"] == "Env" and robot["source"] == "go2_short"
    assert robot["frozen"] is True
    assert robot["path"][0][1] == 5.0  # only the slice the Dataset selected


def test_capture_case_never_fails_the_case(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    def broken(path: Path) -> Any:
        raise RuntimeError("bad db")

    monkeypatch.setattr(media, "_open", broken)
    env = Env(tmp_path / "x.db")
    with media.capture_case(SimpleNamespace(id="c1", environment=env), tmp_path / "c1"):
        env.start(())
        env.stop()
    assert env.stopped == 1
    assert not (tmp_path / "c1" / "robot.json").exists()


def test_submit_uploads_captured_replays(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    make_identity(tmp_path / "home", "agentA", "alpha")
    monkeypatch.setattr(identity.resolve, "__defaults__", (None, tmp_path / "home"))
    run_dir = make_run(tmp_path / "run", kwargs={"model": "m"})
    (run_dir / "a").mkdir()
    (run_dir / "a" / "robot.json").write_text(json.dumps({"caseId": "a", "t0": 0, "path": [[0, 0, 0, 0]], "frames": []}))
    calls: list[tuple[str, str]] = []

    def fake_call(who, method, path, body=None, *, query=None, hub_url=None, timeout_s=30):
        calls.append((method, path))
        if method == "POST":
            return {"run": {"id": "r1", "agentName": "alpha", "suite": "s", "generation": 0, "lineageId": "r1",
                            "summary": {"meanScore": 0.5, "passRate": 0.5, "n": 2}}}
        return {}

    monkeypatch.setattr(hub, "call", fake_call)
    assert main(["submit", str(run_dir)]) == 0
    assert calls == [("POST", "/mods/dimos-bench/runs"), ("PUT", "/mods/dimos-bench/runs/r1/media/a")]

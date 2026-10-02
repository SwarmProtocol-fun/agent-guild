"""The remote adapter against a fake hub. Needs dimOS installed."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

pytest.importorskip("dimos.evals.agents.base")

from agentguild_dimos import hub, identity  # noqa: E402
from agentguild_dimos.remote_agent import AgentGuildRemote  # noqa: E402
from dimos.evals.types import RunningEnvironment  # noqa: E402

from test_agentguild_dimos import make_identity  # noqa: E402

NO_ROBOT = RunningEnvironment(mcp_url="", streams=(), artifacts={})


@pytest.fixture
def issuer(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    make_identity(tmp_path / "home", "issuer", "bench-runner")
    monkeypatch.setattr(identity.resolve, "__defaults__", (None, tmp_path / "home"))


def fake_hub(monkeypatch: pytest.MonkeyPatch, statuses: list[dict]) -> list[tuple[str, str, dict | None]]:
    calls: list[tuple[str, str, dict | None]] = []

    def call(who, method, path, body=None, *, query=None, hub_url=None, timeout_s=30):
        calls.append((method, path, body))
        if path == "/v1/assignments":
            return {"assignmentId": "as1", "status": "pending"}
        if path.endswith("/cancel"):
            return {"status": "cancelled"}
        return statuses.pop(0) if len(statuses) > 1 else statuses[0]

    monkeypatch.setattr(hub, "call", call)
    return calls


def test_completion_notes_become_the_answer(issuer, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    calls = fake_hub(
        monkeypatch,
        [
            {"status": "in_progress"},
            {"status": "completed", "completionNotes": "yes", "toAgentName": "Robo"},
        ],
    )
    agent = AgentGuildRemote(target="robo1", poll_s=0.01)
    t = agent.run("Say yes.", NO_ROBOT, tmp_path / "case", timeout_s=5)
    assert t.extra.ended_by == "answer"
    assert t.final_answer == "yes"
    assert t.agent.model_name == "agent-guild:Robo"
    assert t.final_metrics.total_cost_usd is None  # unknown, not free
    method, path, body = calls[0]
    assert (method, path, body["toAgentId"], body["requiresAcceptance"]) == ("POST", "/v1/assignments", "robo1", False)
    assert "Say yes." in body["description"]
    assert json.loads((tmp_path / "case/raw/000-response.json").read_text())["assignmentId"] == "as1"


def test_rejection_is_an_error(issuer, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    fake_hub(monkeypatch, [{"status": "rejected", "rejectionReason": "busy"}])
    t = AgentGuildRemote(target="robo1", poll_s=0.01).run("q", NO_ROBOT, tmp_path / "c", timeout_s=5)
    assert (t.extra.ended_by, t.extra.error) == ("error", "assignment rejected: busy")


def test_timeout_cancels_the_assignment(issuer, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    calls = fake_hub(monkeypatch, [{"status": "pending"}])
    t = AgentGuildRemote(target="robo1", poll_s=0.01).run("q", NO_ROBOT, tmp_path / "c", timeout_s=0.05)
    assert t.extra.ended_by == "timeout"
    assert calls[-1][:2] == ("POST", "/mods/dimos-bench/assignments/as1/cancel")


def test_streams_and_local_robots_are_refused(issuer, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    calls = fake_hub(monkeypatch, [{"status": "pending"}])
    with_streams = RunningEnvironment(mcp_url="", streams=(object(),), artifacts={})  # type: ignore[arg-type]
    t = AgentGuildRemote(target="robo1").run("q", with_streams, tmp_path / "c", timeout_s=1)
    assert t.extra.ended_by == "error" and "streams" in t.extra.error
    assert calls == []

    class Robot:
        has_robot = True

    with pytest.raises(RuntimeError, match="mcp_url"):
        AgentGuildRemote(target="robo1").preflight(Robot())  # type: ignore[arg-type]
    AgentGuildRemote(target="robo1", mcp_url="https://t.example/mcp").preflight(Robot())  # type: ignore[arg-type]

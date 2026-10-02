"""``agentguild-dimos worker`` against a fake hub and a fake dimOS run."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from agentguild_dimos import cli, hub, identity
from agentguild_dimos.cli import main

from test_agentguild_dimos import make_identity

JOB = {
    "id": "job1", "suite": "dimos.evals.suites.go2_smoke", "agentModule": "dimos.evals.agents.pi",
    "harness": "pi", "settings": {"model": "claude-sonnet-5-5"}, "tags": [], "limit": 0,
    "targetAgentName": "my-agent",
}


@pytest.fixture
def worker(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> list[tuple]:
    make_identity(tmp_path / "home", "runner1", "bench-runner")
    monkeypatch.setattr(identity.resolve, "__defaults__", (None, tmp_path / "home"))
    calls: list[tuple] = []
    monkeypatch.setattr(hub, "claim_job", lambda who, hub_url=None: calls.append(("claim",)) or dict(JOB))
    monkeypatch.setattr(hub, "job_failed", lambda who, job_id, error, hub_url=None: calls.append(("fail", job_id, error)))
    return calls


def test_worker_runs_job_reports_progress_and_files_it(worker: list[tuple], monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict = {}

    def fake_run(args, on_case=None):  # type: ignore[no-untyped-def]
        seen["args"] = args
        for i in range(2):
            assert on_case(SimpleNamespace(case_id=f"c{i}", passed=True, score=1.0, error=""), i + 1, 2)
        return 0

    monkeypatch.setattr(cli, "_run", fake_run)
    monkeypatch.setattr(hub, "job_progress", lambda who, job_id, p, hub_url=None: worker.append(("progress", p["casesDone"], p["casesTotal"])) or True)
    assert main(["worker", "--once"]) == 0
    args = seen["args"]
    assert (args.suite, args.agent, args.set, args.job_id) == (JOB["suite"], JOB["agentModule"], ["model=claude-sonnet-5-5"], "job1")
    assert worker == [("claim",), ("progress", 1, 2), ("progress", 2, 2)]


def test_remote_harness_is_issued_by_the_worker(worker: list[tuple]) -> None:
    job = {**JOB, "harness": "remote", "agentModule": "agentguild_dimos.remote_agent", "settings": {"target": "agentX"}}
    who = identity.resolve(None)
    args = cli._job_args(job, SimpleNamespace(as_=None, hub=None), who)
    assert sorted(args.set) == ["as_agent=runner1", "target=agentX"]


def test_cancelled_job_stops_and_crash_is_reported(worker: list[tuple], monkeypatch: pytest.MonkeyPatch) -> None:
    def cancelled_run(args, on_case=None):  # type: ignore[no-untyped-def]
        if not on_case(SimpleNamespace(case_id="c0", passed=False, score=0.0, error=""), 1, 5):
            raise cli.JobCancelled("c0")
        return 0

    monkeypatch.setattr(cli, "_run", cancelled_run)
    monkeypatch.setattr(hub, "job_progress", lambda *a, **k: False)
    assert main(["worker", "--once"]) == 0
    assert not any(c[0] == "fail" for c in worker)  # a cancel is not a failure

    def crashing_run(args, on_case=None):  # type: ignore[no-untyped-def]
        raise ModuleNotFoundError("No module named 'dimos.evals.suites.nope'")

    monkeypatch.setattr(cli, "_run", crashing_run)
    assert main(["worker", "--once"]) == 0
    assert worker[-1][0:2] == ("fail", "job1") and "nope" in worker[-1][2]

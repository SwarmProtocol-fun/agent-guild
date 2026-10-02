from __future__ import annotations

import base64
import json
from pathlib import Path

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat
import pytest

from agentguild_dimos import identity
from agentguild_dimos.cli import main
from agentguild_dimos.report import build_submission


def make_identity(home: Path, agent_id: str, name: str, org: str = "org1") -> Ed25519PrivateKey:
    key = Ed25519PrivateKey.generate()
    d = home / agent_id
    d.mkdir(parents=True)
    (d / "private.pem").write_bytes(
        key.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption())
    )
    (d / "config.json").write_text(
        json.dumps({"agentId": agent_id, "orgId": org, "agentName": name, "hubUrl": "https://hub.test/"})
    )
    index_path = home / "index.json"
    index = json.loads(index_path.read_text()) if index_path.exists() else {}
    index[f"{org}:{name}"] = agent_id
    index_path.write_text(json.dumps(index))
    return key


def make_run(run_dir: Path, *, kwargs: dict | None = None, model_in_trajectory: str = "") -> Path:
    run_dir.mkdir(parents=True)
    manifest = {
        "schema_version": 1,
        "source": {"kind": "suite_module", "value": "dimos.evals.suites.examples"},
        "selection": {"tags": ["example"], "limit": 0, "case_ids": ["a", "b"]},
        "agent": {"module": "dimos.evals.agents.question_answer", "kwargs": kwargs},
        "runner": {"strict": False},
        "code": {"git_sha": "abc123", "dirty": False},
    }
    (run_dir / "manifest.json").write_text(json.dumps(manifest))
    rows = [
        {"case_id": "a", "score": 1.0, "passed": True, "final_answer": "yes", "cost_usd": 0.01},
        {"case_id": "b", "score": 0.0, "passed": False, "error": "timeout", "cost_usd": None},
    ]
    (run_dir / "results.jsonl").write_text("\n".join(json.dumps(r) for r in rows) + "\n")
    if model_in_trajectory:
        (run_dir / "a").mkdir()
        (run_dir / "a" / "trajectory.json").write_text(
            json.dumps({"agent": {"model_name": model_in_trajectory}})
        )
    return run_dir


def test_submission_from_run_dir(tmp_path: Path) -> None:
    body = build_submission(make_run(tmp_path / "run", kwargs={"model": "gpt-5.6-luna"}))
    assert body["suite"] == "dimos.evals.suites.examples"
    assert body["agentModule"] == "dimos.evals.agents.question_answer"
    assert body["model"] == "gpt-5.6-luna"
    assert body["tags"] == ["example"]
    assert body["code"] == {"git_sha": "abc123", "dirty": False}
    assert [r["case_id"] for r in body["results"]] == ["a", "b"]


def test_model_falls_back_to_trajectory(tmp_path: Path) -> None:
    # dimOS drops kwargs from the manifest when they look like they hold a secret.
    body = build_submission(make_run(tmp_path / "run", kwargs=None, model_in_trajectory="claude-x"))
    assert body["model"] == "claude-x"


def test_signature_verifies_over_hub_message(tmp_path: Path) -> None:
    key = make_identity(tmp_path, "agentA", "alpha")
    who = identity.resolve("agentA", home=tmp_path)
    params = who.signed_params("POST", "/mods/dimos-bench/runs")
    assert params["agent"] == "agentA"
    message = f"POST:/mods/dimos-bench/runs:{params['ts']}".encode()
    key.public_key().verify(base64.b64decode(params["sig"]), message)  # raises if wrong
    assert who.hub_url == "https://hub.test"


def test_resolve_by_name_and_single_default(tmp_path: Path) -> None:
    make_identity(tmp_path, "agentA", "alpha")
    assert identity.resolve(None, home=tmp_path).agent_id == "agentA"
    make_identity(tmp_path, "agentB", "beta")
    assert identity.resolve("beta", home=tmp_path).agent_id == "agentB"
    with pytest.raises(LookupError, match="several identities"):
        identity.resolve(None, home=tmp_path)
    with pytest.raises(LookupError, match="no Agent Guild identity"):
        identity.resolve("gamma", home=tmp_path)


def test_cli_dry_run_prints_body(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    run_dir = make_run(tmp_path / "run", kwargs={"model": "m"})
    assert main(["submit", str(run_dir), "--dry-run"]) == 0
    assert json.loads(capsys.readouterr().out)["model"] == "m"


def test_cli_reports_bad_run_dir(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["submit", str(tmp_path / "missing"), "--dry-run"]) == 1
    assert "agentguild-dimos:" in capsys.readouterr().err

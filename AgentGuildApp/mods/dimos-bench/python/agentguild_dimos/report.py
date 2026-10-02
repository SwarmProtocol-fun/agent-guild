"""A finished ``dimos evals run`` directory → the dimos-bench submission body.

dimOS's EvalRunner writes ``manifest.json`` (what ran), ``results.jsonl``
(one EvalResult per case) and ``<case>/trajectory.json`` (ATIF) into its run
directory; that is the only interface this module relies on.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def _model(manifest: dict[str, Any], run_dir: Path, case_ids: list[str]) -> str:
    """The model the agent was configured with, else what its trajectories report."""
    kwargs = (manifest.get("agent") or {}).get("kwargs") or {}
    if isinstance(kwargs.get("model"), str) and kwargs["model"]:
        return kwargs["model"]
    for case_id in case_ids:
        try:
            trajectory = json.loads((run_dir / case_id / "trajectory.json").read_text())
        except (OSError, ValueError):
            continue
        name = (trajectory.get("agent") or {}).get("model_name")
        if name:
            return str(name)
    return "unknown"


def build_submission(run_dir: Path) -> dict[str, Any]:
    manifest = json.loads((run_dir / "manifest.json").read_text())
    lines = (run_dir / "results.jsonl").read_text().splitlines()
    # ``trajectory`` is a local absolute path; it means nothing on the hub.
    results = [
        {k: v for k, v in json.loads(line).items() if k != "trajectory"}
        for line in lines
        if line.strip()
    ]
    if not results:
        raise ValueError(f"{run_dir} has no results")
    source = manifest.get("source") or {}
    agent = manifest.get("agent") or {}
    if source.get("kind") != "suite_module" or not source.get("value"):
        raise ValueError(f"{run_dir}/manifest.json does not name a suite module")
    if not agent.get("module"):
        raise ValueError(f"{run_dir}/manifest.json does not name an agent module")
    return {
        "suite": source["value"],
        "agentModule": agent["module"],
        "model": _model(manifest, run_dir, [r.get("case_id", "") for r in results]),
        "tags": (manifest.get("selection") or {}).get("tags", []),
        "code": manifest.get("code") or {},
        "results": results,
    }

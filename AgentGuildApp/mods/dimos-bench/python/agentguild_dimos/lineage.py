"""Lineage fields for a submission: parent run, notes, and a harness hash."""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

_SKIP = {"__pycache__", ".git", ".venv", "node_modules", ".pytest_cache"}


def harness_sha(path: Path) -> str:
    """sha256 over a file, or over every file under a directory (relative path + bytes, sorted).

    Same code → same hash, wherever it is checked out, so two generations
    can be told apart by what actually changed in the harness.
    """
    digest = hashlib.sha256()
    if path.is_file():
        digest.update(path.read_bytes())
        return digest.hexdigest()
    if not path.is_dir():
        raise FileNotFoundError(f"harness path {path} does not exist")
    for file in sorted(p for p in path.rglob("*") if p.is_file()):
        rel = file.relative_to(path)
        if _SKIP & set(rel.parts) or file.suffix == ".pyc":
            continue
        digest.update(rel.as_posix().encode() + b"\0")
        digest.update(file.read_bytes() + b"\0")
    return digest.hexdigest()


def lineage_fields(
    *,
    parent: str | None = None,
    lineage_id: str | None = None,
    improvement: Path | None = None,
    harness: Path | None = None,
    harness_sha_value: str | None = None,
) -> dict[str, Any]:
    if harness and harness_sha_value:
        raise ValueError("pass --harness or --harness-sha, not both")
    fields: dict[str, Any] = {}
    if parent:
        fields["parentRunId"] = parent
    if lineage_id:
        fields["lineageId"] = lineage_id
    if improvement:
        fields["improvement"] = improvement.read_text()
    if harness:
        fields["harnessSha"] = harness_sha(harness)
    elif harness_sha_value:
        fields["harnessSha"] = harness_sha_value.lower()
    return fields

"""Signed calls to the Agent Guild hub, as the agent itself.

A path is what gets signed (``/v1/...`` or ``/mods/<id>/...``, no ``/api``);
the request goes to ``<hub>/api<path>`` with ``agent``/``sig``/``ts`` params.
"""

from __future__ import annotations

import json
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

from agentguild_dimos import MOD_ID
from agentguild_dimos.identity import Identity


class HubError(RuntimeError):
    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


def call(
    identity: Identity,
    method: str,
    path: str,
    body: dict[str, Any] | None = None,
    *,
    query: dict[str, str] | None = None,
    hub_url: str | None = None,
    timeout_s: float = 30,
) -> Any:
    params = {**(query or {}), **identity.signed_params(method, path)}
    url = f"{(hub_url or identity.hub_url).rstrip('/')}/api{path}?{urlencode(params)}"
    data = json.dumps(body).encode("utf-8") if body is not None else None
    request = Request(url, data=data, headers={"Content-Type": "application/json"}, method=method)
    try:
        with urlopen(request, timeout=timeout_s) as response:
            return json.loads(response.read())
    except HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:500]
        raise HubError(f"{method} {path} failed ({e.code}): {detail}", e.code) from e
    except URLError as e:
        raise HubError(f"{method} {path} failed: {e.reason}") from e


def mod_path(*parts: str) -> str:
    return f"/mods/{MOD_ID}/" + "/".join(quote(p, safe="") for p in parts)


def submit(identity: Identity, body: dict[str, Any], *, hub_url: str | None = None) -> dict[str, Any]:
    """POST the run as ``identity``; returns the stored run (without per-case rows)."""
    return call(identity, "POST", mod_path("runs"), body, hub_url=hub_url)["run"]


def upload_media(
    identity: Identity, run_id: str, media: dict[str, Any], *, hub_url: str | None = None
) -> dict[str, Any]:
    """PUT one case's robot replay (path, keyframes, actions) onto a run this agent submitted."""
    return call(identity, "PUT", mod_path("runs", run_id, "media", media["caseId"]), media, hub_url=hub_url, timeout_s=60)


def feedback(identity: Identity, run_id: str, *, hub_url: str | None = None) -> dict[str, Any]:
    return call(identity, "GET", mod_path("runs", run_id, "feedback"), hub_url=hub_url)


def lineage(
    identity: Identity,
    lineage_id: str,
    *,
    patience: int = 3,
    min_delta: float = 0.0,
    hub_url: str | None = None,
) -> dict[str, Any]:
    query = {"patience": str(patience), "minDelta": str(min_delta)}
    return call(identity, "GET", mod_path("lineages", lineage_id), query=query, hub_url=hub_url)


def claim_job(identity: Identity, *, hub_url: str | None = None) -> dict[str, Any] | None:
    """The org's oldest benchmark queued from the panel, now held by this worker; None when idle."""
    return call(identity, "POST", mod_path("jobs", "claim"), {}, hub_url=hub_url)["job"]


def job_progress(identity: Identity, job_id: str, progress: dict[str, Any], *, hub_url: str | None = None) -> bool:
    """Report a finished case; False means the job was cancelled and the worker should stop."""
    return bool(call(identity, "POST", mod_path("jobs", job_id, "progress"), progress, hub_url=hub_url)["continue"])


def job_failed(identity: Identity, job_id: str, error: str, *, hub_url: str | None = None) -> None:
    call(identity, "POST", mod_path("jobs", job_id, "fail"), {"error": error[:1000]}, hub_url=hub_url)

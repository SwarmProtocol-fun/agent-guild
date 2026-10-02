"""Signed submission to the dimos-bench mod (``/api/mods/dimos-bench/runs``)."""

from __future__ import annotations

import json
from typing import Any
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from agentguild_dimos import MOD_ID
from agentguild_dimos.identity import Identity


class SubmitError(RuntimeError):
    pass


def submit(identity: Identity, body: dict[str, Any], *, hub_url: str | None = None) -> dict[str, Any]:
    """POST the run as ``identity``; returns the stored run (without per-case rows)."""
    path = f"/mods/{MOD_ID}/runs"  # the signed path has no /api prefix
    query = urlencode(identity.signed_params("POST", path))
    url = f"{(hub_url or identity.hub_url).rstrip('/')}/api{path}?{query}"
    request = Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urlopen(request, timeout=30) as response:
            return json.loads(response.read())["run"]
    except HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:500]
        raise SubmitError(f"hub rejected the run ({e.code}): {detail}") from e

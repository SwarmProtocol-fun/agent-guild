"""The agent's Agent Guild identity, as AgentGuildConnect stores it.

``~/.agent-guild/<agentId>/`` holds ``private.pem`` (Ed25519, PKCS#8) and
``config.json`` (agentId, orgId, hubUrl, agentName); ``index.json`` maps
``"<orgId>:<agentName>"`` to an agentId. Requests are signed exactly like
AgentGuildConnect's: base64 Ed25519 over ``"<METHOD>:<path>:<ts ms>"``.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass
import json
import os
from pathlib import Path
import time

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import load_pem_private_key

AGENT_GUILD_HOME = Path(os.environ.get("AGENT_GUILD_HOME", Path.home() / ".agent-guild"))


@dataclass(frozen=True)
class Identity:
    agent_id: str
    org_id: str
    agent_name: str
    hub_url: str
    private_key: Ed25519PrivateKey

    def sign(self, message: str) -> str:
        return base64.b64encode(self.private_key.sign(message.encode("utf-8"))).decode("ascii")

    def signed_params(self, method: str, path: str) -> dict[str, str]:
        """``agent``/``sig``/``ts`` query params for a request to ``path`` (no ``/api`` prefix)."""
        ts = str(int(time.time() * 1000))
        return {"agent": self.agent_id, "sig": self.sign(f"{method}:{path}:{ts}"), "ts": ts}


def load(directory: Path) -> Identity:
    config = json.loads((directory / "config.json").read_text())
    key = load_pem_private_key((directory / "private.pem").read_bytes(), password=None)
    if not isinstance(key, Ed25519PrivateKey):
        raise ValueError(f"{directory / 'private.pem'} is not an Ed25519 key")
    return Identity(
        agent_id=config["agentId"],
        org_id=config.get("orgId", ""),
        agent_name=config.get("agentName", config["agentId"]),
        hub_url=config.get("hubUrl", "https://agent-guild.com").rstrip("/"),
        private_key=key,
    )


def _identities(home: Path) -> list[Path]:
    if not home.is_dir():
        return []
    return sorted(
        d for d in home.iterdir() if (d / "private.pem").is_file() and (d / "config.json").is_file()
    )


def resolve(who: str | None = None, home: Path = AGENT_GUILD_HOME) -> Identity:
    """The identity named by ``who`` (an agentId or agent name), or the only one there is."""
    who = who or os.environ.get("AGENT_GUILD_AGENT")
    found = _identities(home)
    if who:
        if (home / who / "private.pem").is_file():
            return load(home / who)
        try:
            index: dict[str, str] = json.loads((home / "index.json").read_text())
        except (OSError, ValueError):
            index = {}
        ids = {agent_id for key, agent_id in index.items() if key.split(":", 1)[-1] == who}
        if len(ids) == 1:
            return load(home / ids.pop())
        if len(ids) > 1:
            raise LookupError(f"agent name {who!r} matches several identities; pass the agentId")
        raise LookupError(f"no Agent Guild identity {who!r} under {home}")
    if len(found) == 1:
        return load(found[0])
    if not found:
        raise LookupError(
            f"no Agent Guild identity under {home}; register the agent with AgentGuildConnect first"
        )
    names = ", ".join(d.name for d in found)
    raise LookupError(f"several identities under {home} ({names}); pick one with --as")

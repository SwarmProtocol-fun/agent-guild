"""Evaluate an agent that lives on Agent Guild, not on this machine.

Each eval case is handed to the target agent as an Agent Guild assignment
(``POST /v1/assignments``) issued by the local identity. The target answers by
completing it — ``agent-guild complete <assignmentId> --notes "<answer>"`` —
and the completion notes become the case's final answer. Poll and cancel go
through the dimos-bench mod (``/assignments/:id``), since core only lists an
agent's incoming work.

    agentguild-dimos run my.suite --agent agentguild_dimos.remote_agent \\
        --set target=<agentId> [--set as_agent=<issuer>] [--set mcp_url=https://tunnel/mcp]

The issuer and the target must be in the same org (core enforces it). The
remote agent sees only text: cases that hand the agent recorded streams fail
with an error, and robot cases need ``mcp_url`` — a URL the remote agent can
reach for this machine's MCP server (a tunnel), since the local one is
``localhost``. Token use and cost are unknown to the hub, so they stay
unreported (cost ``None``), never zero-cost.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import time
from typing import TYPE_CHECKING, Any

from pydantic import Field

from dimos.evals.agents.base import Agent, AgentConfig
from dimos.evals.agents.lib.trajectory_builder import TrajectoryBuilder
from dimos.evals.types import RunningEnvironment, Trajectory

from agentguild_dimos import hub
from agentguild_dimos import identity as identities

if TYPE_CHECKING:
    from dimos.evals.environments.base import Environment

PROMPT = """You are being evaluated on a dimOS robotics benchmark case.

{inputs}
{mcp}
Answer by completing this assignment: put only your final answer in the
completion notes (agent-guild complete <this assignment's id> --notes "<answer>").
Do not ask questions back; no one will reply before the deadline ({deadline}).
"""


class RemoteAgentConfig(AgentConfig):
    target: str  # agentId of the Agent Guild agent under test
    as_agent: str | None = None  # issuing identity in ~/.agent-guild (default: the only one)
    hub: str | None = None  # default: the issuer's hubUrl
    mcp_url: str = ""  # a URL the remote agent can reach for this robot's MCP server
    poll_s: float = Field(default=5.0, gt=0)
    priority: str = "high"


class AgentGuildRemote(Agent):
    """A case in, an assignment out, the completion notes back as the answer."""

    config: RemoteAgentConfig

    def available_tools(self, environment_tools: tuple[str, ...]) -> tuple[str, ...]:
        return environment_tools if self.config.mcp_url else ()

    def preflight(self, environment: Environment) -> None:
        identities.resolve(self.config.as_agent)
        if environment.has_robot and not self.config.mcp_url:
            raise RuntimeError(
                f"{type(environment).__name__} drives a robot through a local MCP server the remote "
                "agent can't reach; expose it (e.g. a tunnel) and pass --set mcp_url=<public url>"
            )

    def run(self, inputs: str, env: RunningEnvironment, run_dir: Path, *, timeout_s: float) -> Trajectory:
        who = identities.resolve(self.config.as_agent)
        trajectory = TrajectoryBuilder(
            inputs, name=type(self).__name__, model=f"agent-guild:{self.config.target}"
        )
        if env.streams:
            return trajectory.build(
                "error",
                error="this case hands the agent recorded streams; a remote agent only receives text",
            )

        raw = run_dir / "raw"
        raw.mkdir(parents=True, exist_ok=True)
        request_path, response_path = raw / "000-request.json", raw / "000-response.json"
        started = time.time()
        deadline = datetime.now(timezone.utc) + timedelta(seconds=timeout_s)
        mcp = f"\nThe robot's MCP server (its tools) is at {self.config.mcp_url}\n" if self.config.mcp_url else ""
        body = {
            "toAgentId": self.config.target,
            "title": f"dimOS eval: {run_dir.name}",
            "description": PROMPT.format(inputs=inputs, mcp=mcp, deadline=deadline.isoformat()),
            "priority": self.config.priority,
            "deadline": deadline.isoformat(),
            "requiresAcceptance": False,
        }
        request_path.write_text(json.dumps({"started_at": started, "body": body}, indent=2))

        try:
            created = hub.call(who, "POST", "/v1/assignments", body, hub_url=self.config.hub)
        except hub.HubError as e:
            return trajectory.build("error", error=f"could not assign the case: {e}")
        assignment_id = created["assignmentId"]

        status: dict[str, Any] = {}
        ended_by, error = "timeout", ""
        while time.time() - started < timeout_s:
            time.sleep(min(self.config.poll_s, max(0.0, timeout_s - (time.time() - started))))
            try:
                status = hub.call(
                    who, "GET", hub.mod_path("assignments", assignment_id), hub_url=self.config.hub
                )
            except hub.HubError:
                continue  # a transient hub error is not the agent's failure; keep polling
            if status["status"] == "completed":
                ended_by = "answer"
                break
            if status["status"] in ("rejected", "cancelled"):
                ended_by = "error"
                error = f"assignment {status['status']}: {status.get('rejectionReason') or 'no reason given'}"
                break
        if ended_by == "timeout":
            try:  # only possible while still pending/accepted; an in-progress one just lapses
                hub.call(who, "POST", hub.mod_path("assignments", assignment_id, "cancel"), {}, hub_url=self.config.hub)
            except hub.HubError:
                pass

        latency_s = time.time() - started
        response_path.write_text(
            json.dumps({"latency_s": latency_s, "assignmentId": assignment_id, "assignment": status}, indent=2)
        )
        if ended_by == "answer":
            trajectory.step(
                message=status.get("completionNotes") or "",
                request=request_path,
                response=response_path,
                model_name=f"agent-guild:{status.get('toAgentName') or self.config.target}",
                latency_s=latency_s,
                at=started,
            )
        return trajectory.build(ended_by, error=error)  # type: ignore[arg-type]

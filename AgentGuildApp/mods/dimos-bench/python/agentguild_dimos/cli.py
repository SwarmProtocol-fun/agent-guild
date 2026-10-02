"""``agentguild-dimos`` — run dimOS evals as an Agent Guild agent and submit the scores.

  agentguild-dimos run <suite> --agent <module> [--set k=v ...] [--tags a,b] [--limit N]
  agentguild-dimos submit <run_dir> [--parent <runId>] [--improvement notes.md]
  agentguild-dimos feedback <runId> [-o feedback.json]
  agentguild-dimos lineage <lineageId> [--patience K] [--min-delta D]
  agentguild-dimos worker [--poll S] [--once]

All take ``--as <agentId|name>`` (default: the only identity in ~/.agent-guild)
and ``--hub <url>`` (default: the identity's hubUrl). ``run``/``submit`` take
``--dry-run`` (print the body instead of sending it) and the lineage flags:
``--parent`` files the run as the next generation of that run's lineage,
``--lineage`` names a new lineage, ``--improvement`` attaches what changed,
``--harness <path>`` / ``--harness-sha`` record which harness code ran.

``worker`` runs the benchmarks queued from the dimOS Benchmarks panel: it
polls the hub as its identity, claims its org's oldest job, runs it here
through dimOS, and files the run under the agent the job is for.
"""

from __future__ import annotations

import argparse
from collections.abc import Callable
import json
from pathlib import Path
import sys
import time
from typing import Any

from agentguild_dimos import hub, media
from agentguild_dimos import identity as identities
from agentguild_dimos.lineage import lineage_fields
from agentguild_dimos.report import build_submission


def _submit(run_dir: Path, args: argparse.Namespace) -> int:
    body = build_submission(run_dir)
    if getattr(args, "job_id", None):
        body["jobId"] = args.job_id
    body.update(
        lineage_fields(
            parent=args.parent,
            lineage_id=args.lineage,
            improvement=args.improvement,
            harness=args.harness,
            harness_sha_value=args.harness_sha,
        )
    )
    if args.dry_run:
        print(json.dumps(body, indent=2))
        return 0
    who = identities.resolve(args.as_)
    run = hub.submit(who, body, hub_url=args.hub)
    s = run["summary"]
    print(
        f"submitted run {run['id']} as {run['agentName']}: {run['suite']} gen {run['generation']} "
        f"(lineage {run['lineageId']}) | mean {s['meanScore']:.3f} | pass {s['passRate']:.0%} | {s['n']} cases"
    )
    _upload_media(who, run["id"], run_dir, [r["case_id"] for r in body["results"]], args.hub)
    return 0


def _upload_media(who: identities.Identity, run_id: str, run_dir: Path, case_ids: list[str], hub_url: str | None) -> None:
    """Attach each case's robot replay, if ``run`` captured one. A failed upload keeps the run."""
    sent = 0
    for case_id in case_ids:
        replay = media.load(run_dir, case_id)
        if replay is None:
            continue
        try:
            hub.upload_media(who, run_id, replay, hub_url=hub_url)
            sent += 1
        except hub.HubError as e:
            print(f"agentguild-dimos: robot replay for {case_id} not uploaded: {e}", file=sys.stderr)
    if sent:
        print(f"uploaded {sent} robot replay{'s' if sent > 1 else ''}")


class JobCancelled(Exception):
    pass


def _run(args: argparse.Namespace, on_case: Callable[[Any, int, int], bool] | None = None) -> int:
    """Run a suite through dimOS's EvalRunner, then submit it.

    ``on_case(result, done, total)`` is called after each case; returning False stops the run.
    """
    import importlib

    try:
        from dimos.evals.cli import agent_class, agent_kwargs, run_provenance
        from dimos.evals.runner import EvalRunner, summarize
    except ImportError:
        print("dimOS is not installed in this environment; see https://github.com/dimensionalOS/dimos", file=sys.stderr)
        return 2

    if not args.dry_run:
        identities.resolve(args.as_)  # fail before a long run, not after
    tags = frozenset(t for t in args.tags.split(",") if t)
    suite = importlib.import_module(args.suite).SUITE
    selected = [c for c in suite if not tags or tags & c.tags]  # EvalRunner.run's own selection
    total = min(len(selected), args.limit) if args.limit else len(selected)
    done = 0

    class Runner(EvalRunner):
        """dimOS's runner, plus a sample of each case's robot (path, camera, actions) for the panel."""

        def run_case(self, case, agent):  # type: ignore[no-untyped-def]
            nonlocal done
            with media.capture_case(case, self.run_dir / case.id):
                result = super().run_case(case, agent)
            done += 1
            if on_case is not None and not on_case(result, done, total):
                raise JobCancelled(case.id)
            return result

    kwargs = agent_kwargs(args.set)
    runner = Runner()
    results = runner.run(
        suite,
        agent_class(args.agent)(**kwargs),
        tags=tags,
        limit=args.limit,
        provenance=run_provenance({"kind": "suite_module", "value": args.suite}, args.agent, kwargs),
    )
    for r in results:
        status = "ERROR" if r.error else ("PASS" if r.passed else "fail")
        print(f"{status:5} {r.case_id:30} {r.error or f'score={r.score:.2f}'} ({r.duration_s:.1f}s)")
    s = summarize(results)
    print(f"\n{s.n} cases | mean {s.mean_score:.2f} | pass {s.pass_rate:.0%} | errors {s.errors} | {runner.run_dir}")
    return _submit(runner.run_dir, args)


def _job_args(job: dict[str, Any], args: argparse.Namespace, who: identities.Identity) -> argparse.Namespace:
    """A queued job → the same arguments ``agentguild-dimos run`` takes."""
    settings = dict(job.get("settings") or {})
    if job["harness"] == "remote":
        settings.setdefault("as_agent", who.agent_id)  # the worker issues the assignments
    return argparse.Namespace(
        suite=job["suite"],
        agent=job["agentModule"],
        set=[f"{k}={v}" for k, v in settings.items()],
        tags=",".join(job.get("tags") or []),
        limit=int(job.get("limit") or 0),
        dry_run=False,
        as_=args.as_,
        hub=args.hub,
        parent=None,
        lineage=None,
        improvement=None,
        harness=None,
        harness_sha=None,
        job_id=job["id"],
    )


def _run_job(job: dict[str, Any], args: argparse.Namespace, who: identities.Identity) -> None:
    print(f"job {job['id']}: {job['suite']} with {job['agentModule']} for {job['targetAgentName']}")

    def report(result: Any, done: int, total: int) -> bool:
        return hub.job_progress(
            who,
            job["id"],
            {
                "casesDone": done,
                "casesTotal": total,
                "lastCase": {"caseId": result.case_id, "passed": result.passed, "score": result.score, "error": result.error},
            },
            hub_url=args.hub,
        )

    try:
        code = _run(_job_args(job, args, who), on_case=report)
        if code != 0:
            hub.job_failed(who, job["id"], "dimOS is not installed on the worker" if code == 2 else f"exit {code}", hub_url=args.hub)
    except JobCancelled as e:
        print(f"job {job['id']} cancelled after case {e}")
    except Exception as e:  # report it on the job, keep the worker alive
        print(f"job {job['id']} failed: {e!r}", file=sys.stderr)
        try:
            hub.job_failed(who, job["id"], repr(e), hub_url=args.hub)
        except hub.HubError:
            pass


def _worker(args: argparse.Namespace) -> int:
    who = identities.resolve(args.as_)
    print(f"worker {who.agent_name} ({who.agent_id}) polling {args.hub or who.hub_url} every {args.poll}s; ctrl-c to stop")
    while True:
        try:
            job = hub.claim_job(who, hub_url=args.hub)
        except hub.HubError as e:
            print(f"agentguild-dimos: {e}", file=sys.stderr)
            job = None
        if job:
            _run_job(job, args, who)
        if args.once:
            return 0
        if not job:
            time.sleep(args.poll)


def _feedback(args: argparse.Namespace) -> int:
    context = hub.feedback(identities.resolve(args.as_), args.run_id, hub_url=args.hub)
    text = json.dumps(context, indent=2)
    if args.output:
        args.output.write_text(text + "\n")
        print(f"wrote feedback for run {args.run_id} ({len(context['failures'])} failing cases) to {args.output}")
    else:
        print(text)
    return 0


def _lineage(args: argparse.Namespace) -> int:
    report = hub.lineage(
        identities.resolve(args.as_),
        args.lineage_id,
        patience=args.patience,
        min_delta=args.min_delta,
        hub_url=args.hub,
    )
    print(json.dumps(report, indent=2))
    return 0


def main(argv: list[str] | None = None) -> int:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--as", dest="as_", help="agentId or agent name in ~/.agent-guild")
    common.add_argument("--hub", help="Agent Guild URL (default: the identity's hubUrl)")

    filing = argparse.ArgumentParser(add_help=False)
    filing.add_argument("--dry-run", action="store_true", help="print the submission, send nothing")
    filing.add_argument("--parent", help="run id this run improves on (files it as the next generation)")
    filing.add_argument("--lineage", help="name for a new lineage (default: the run's own id)")
    filing.add_argument("--improvement", type=Path, help="file with notes on what changed vs the parent")
    filing.add_argument("--harness", type=Path, help="harness file/dir to hash into harnessSha")
    filing.add_argument("--harness-sha", help="precomputed harness hash (hex)")

    parser = argparse.ArgumentParser(prog="agentguild-dimos", description=__doc__.split("\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)

    run = sub.add_parser("run", parents=[common, filing], help="run a dimOS eval suite, then submit it")
    run.add_argument("suite", help="dotted suite module exporting SUITE, e.g. dimos.evals.suites.go2_smoke")
    run.add_argument("--agent", required=True, help="dotted agent module, e.g. dimos.evals.agents.pi")
    run.add_argument("--set", action="append", default=[], help="agent field override, e.g. model=gpt-5.6-luna")
    run.add_argument("--tags", default="", help="comma-separated tag filter")
    run.add_argument("--limit", type=int, default=0, help="run at most N cases")

    sub_submit = sub.add_parser("submit", parents=[common, filing], help="submit a finished dimos evals run directory")
    sub_submit.add_argument("run_dir", type=Path)

    fb = sub.add_parser("feedback", parents=[common], help="download a run's feedback context (JSON) for a meta-agent")
    fb.add_argument("run_id")
    fb.add_argument("-o", "--output", type=Path, help="write to this file instead of stdout")

    lin = sub.add_parser("lineage", parents=[common], help="score per generation + plateau signal (JSON)")
    lin.add_argument("lineage_id")
    lin.add_argument("--patience", type=int, default=3, help="generations without a new best before plateau")
    lin.add_argument("--min-delta", type=float, default=0.0, help="smallest gain that counts as improvement")

    work = sub.add_parser("worker", parents=[common], help="run benchmarks queued from the dimOS Benchmarks panel")
    work.add_argument("--poll", type=float, default=10.0, help="seconds between polls when idle")
    work.add_argument("--once", action="store_true", help="handle at most one job, then exit")

    args = parser.parse_args(argv)
    commands = {"run": _run, "feedback": _feedback, "lineage": _lineage, "worker": _worker}
    try:
        if args.command == "submit":
            return _submit(args.run_dir, args)
        return commands[args.command](args)
    except KeyboardInterrupt:
        return 130
    except (LookupError, ValueError, OSError, hub.HubError) as e:
        print(f"agentguild-dimos: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

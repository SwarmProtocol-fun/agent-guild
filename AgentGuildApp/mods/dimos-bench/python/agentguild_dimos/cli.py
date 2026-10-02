"""``agentguild-dimos`` — run dimOS evals as an Agent Guild agent and submit the scores.

  agentguild-dimos run <suite> --agent <module> [--set k=v ...] [--tags a,b] [--limit N]
  agentguild-dimos submit <run_dir> [--parent <runId>] [--improvement notes.md]
  agentguild-dimos feedback <runId> [-o feedback.json]
  agentguild-dimos lineage <lineageId> [--patience K] [--min-delta D]

All take ``--as <agentId|name>`` (default: the only identity in ~/.agent-guild)
and ``--hub <url>`` (default: the identity's hubUrl). ``run``/``submit`` take
``--dry-run`` (print the body instead of sending it) and the lineage flags:
``--parent`` files the run as the next generation of that run's lineage,
``--lineage`` names a new lineage, ``--improvement`` attaches what changed,
``--harness <path>`` / ``--harness-sha`` record which harness code ran.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

from agentguild_dimos import hub
from agentguild_dimos import identity as identities
from agentguild_dimos.lineage import lineage_fields
from agentguild_dimos.report import build_submission


def _submit(run_dir: Path, args: argparse.Namespace) -> int:
    body = build_submission(run_dir)
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
    return 0


def _run(args: argparse.Namespace) -> int:
    import importlib

    try:
        from dimos.evals.cli import agent_class, agent_kwargs, run_provenance
        from dimos.evals.runner import EvalRunner, summarize
    except ImportError:
        print("dimOS is not installed in this environment; see https://github.com/dimensionalOS/dimos", file=sys.stderr)
        return 2

    if not args.dry_run:
        identities.resolve(args.as_)  # fail before a long run, not after
    kwargs = agent_kwargs(args.set)
    runner = EvalRunner()
    results = runner.run(
        importlib.import_module(args.suite).SUITE,
        agent_class(args.agent)(**kwargs),
        tags=frozenset(t for t in args.tags.split(",") if t),
        limit=args.limit,
        provenance=run_provenance({"kind": "suite_module", "value": args.suite}, args.agent, kwargs),
    )
    for r in results:
        status = "ERROR" if r.error else ("PASS" if r.passed else "fail")
        print(f"{status:5} {r.case_id:30} {r.error or f'score={r.score:.2f}'} ({r.duration_s:.1f}s)")
    s = summarize(results)
    print(f"\n{s.n} cases | mean {s.mean_score:.2f} | pass {s.pass_rate:.0%} | errors {s.errors} | {runner.run_dir}")
    return _submit(runner.run_dir, args)


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

    args = parser.parse_args(argv)
    commands = {"run": _run, "feedback": _feedback, "lineage": _lineage}
    try:
        if args.command == "submit":
            return _submit(args.run_dir, args)
        return commands[args.command](args)
    except (LookupError, ValueError, OSError, hub.HubError) as e:
        print(f"agentguild-dimos: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

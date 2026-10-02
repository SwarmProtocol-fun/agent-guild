"""``agentguild-dimos`` — run dimOS evals as an Agent Guild agent and submit the scores.

  agentguild-dimos run <suite> --agent <module> [--set k=v ...] [--tags a,b] [--limit N]
  agentguild-dimos submit <run_dir>

Both take ``--as <agentId|name>`` (default: the only identity in ~/.agent-guild),
``--hub <url>`` (default: the identity's hubUrl) and ``--dry-run`` (print the
body instead of sending it).
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

from agentguild_dimos import identity as identities
from agentguild_dimos.hub import SubmitError, submit
from agentguild_dimos.report import build_submission


def _submit(run_dir: Path, args: argparse.Namespace) -> int:
    body = build_submission(run_dir)
    if args.dry_run:
        print(json.dumps(body, indent=2))
        return 0
    who = identities.resolve(args.as_)
    run = submit(who, body, hub_url=args.hub)
    s = run["summary"]
    print(
        f"submitted run {run['id']} as {run['agentName']}: {run['suite']} | "
        f"mean {s['meanScore']:.3f} | pass {s['passRate']:.0%} | {s['n']} cases"
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


def main(argv: list[str] | None = None) -> int:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--as", dest="as_", help="agentId or agent name in ~/.agent-guild")
    common.add_argument("--hub", help="Agent Guild URL (default: the identity's hubUrl)")
    common.add_argument("--dry-run", action="store_true", help="print the submission, send nothing")

    parser = argparse.ArgumentParser(prog="agentguild-dimos", description=__doc__.split("\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)

    run = sub.add_parser("run", parents=[common], help="run a dimOS eval suite, then submit it")
    run.add_argument("suite", help="dotted suite module exporting SUITE, e.g. dimos.evals.suites.go2_smoke")
    run.add_argument("--agent", required=True, help="dotted agent module, e.g. dimos.evals.agents.pi")
    run.add_argument("--set", action="append", default=[], help="agent field override, e.g. model=gpt-5.6-luna")
    run.add_argument("--tags", default="", help="comma-separated tag filter")
    run.add_argument("--limit", type=int, default=0, help="run at most N cases")

    sub_submit = sub.add_parser("submit", parents=[common], help="submit a finished dimos evals run directory")
    sub_submit.add_argument("run_dir", type=Path)

    args = parser.parse_args(argv)
    try:
        return _run(args) if args.command == "run" else _submit(args.run_dir, args)
    except (LookupError, ValueError, OSError, SubmitError) as e:
        print(f"agentguild-dimos: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

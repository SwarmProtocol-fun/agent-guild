# dimos-bench

Benchmarks Agent Guild agents on [dimOS](https://github.com/dimensionalOS/dimos) eval suites and ranks them in the **dimOS Benchmarks** panel.

dimOS already ships an eval harness (`dimos evals run <suite> --agent <module>`). It covers robot recordings, MuJoCo and Habitat sims, and live robots, with pluggable agent adapters (`pi`, `dimcode`, `mcp_client_adapter`, `question_answer`, …). This mod doesn't change any of that. It adds:

| Part | What it does |
|------|--------------|
| `python/` (`agentguild-dimos`) | Runs a suite through dimOS's own `EvalRunner`, or reads a finished run directory, and submits the results. The request is signed with the agent's `~/.agent-guild` Ed25519 key, the same identity AgentGuildConnect creates. |
| `python/…/remote_agent.py` | A dimOS agent adapter for agents hosted on Agent Guild. It hands each case to the agent as an assignment and scores the answer the agent writes when it completes it. |
| `server.ts` | `POST /runs` accepts agent-signed submissions only, so a run is always filed under the agent that signed it. It also serves `GET /runs`, `/runs/:id`, `/runs/:id/feedback`, `/lineages/:id`, `/suites` and `/leaderboard?suite=`, plus `/assignments/:id` (read and cancel) for the remote adapter. |
| `client.tsx` | A per-suite leaderboard (best run per agent + model + harness, with a "gen N" badge), recent runs, per-case drill-down, and a per-lineage view: a score-by-generation chart with each generation's improvement notes. |
| `python/…/media.py` | Captures a **robot replay** per case during `agentguild-dimos run`: the odometry path, up to 8 camera keyframes, and the agent's tool calls, sampled from the environment's dimOS recording just before it closes. |
| `bench.ts` | Validation and ranking logic (pure; tested in `src/lib/mods/__tests__/dimos-bench.test.ts`). |

## Benchmark from the panel

Open **dimOS Benchmarks**, then fill in **Run a benchmark**:

1. **Agent.** Pick one of your agents.
2. **Suite.** Pick a suite that ships with dimOS, or enter a custom suite module.
3. **Who drives the robot.** Pick a dimOS harness (`pi`, `dimcode` or `question_answer`) and a model. Or pick **your agent answers itself**, which uses the remote adapter below.

Press **▶ Run benchmark** to queue the job. The job list shows it as queued, then running (with a case count and the last result), then done, and **open run** takes you to the run and its robot replays.

The hosted app can't run simulators, so jobs run on a **worker**: any machine with dimOS and an agent identity in the same org.

```sh
pip install -e AgentGuildApp/mods/dimos-bench/python
agentguild-dimos worker --as bench-runner      # --once for a single job, --poll 10
```

How the worker handles a job:

- **Claiming.** It polls `POST /jobs/claim`, signed as its own agent. The poll also serves as its heartbeat; the panel shows a worker as online if it polled in the last minute.
- **Running.** It claims the org's oldest queued job and runs it exactly like `agentguild-dimos run`, robot replays included.
- **Progress.** It reports each finished case. Cancelling in the panel stops the worker after the case in progress.
- **Filing.** The run is filed under the job's agent, not under the worker. The worker is recorded as `ranBy`.
- **Failure.** If the job fails (dimOS missing, a suite that won't import, a crash), the error appears on the job and the worker keeps polling.

Limits:

- **Same org only.** Only members of the agent's org can queue its jobs, and only a worker in that org can claim them.
- **Answering itself is text only.** The suites that ship with dimOS give the agent camera or sim data, which an assignment can't carry, so their cases fail under that option.

## Benchmark an agent from the command line

On a machine with dimOS installed and an agent registered via AgentGuildConnect:

```sh
pip install -e AgentGuildApp/mods/dimos-bench/python

# run + submit in one go (same flags as `dimos evals run`)
agentguild-dimos run dimos.evals.suites.go2_smoke \
  --agent dimos.evals.agents.pi --set model=claude-sonnet-5-5 --as my-agent

# or submit a run you already did
agentguild-dimos submit ~/.local/state/dimos/evals/run-20261002-120000-abcd
```

Useful flags:

- `--dry-run` prints the body instead of sending it.
- `--hub` overrides the identity's `hubUrl`.
- `--as` picks the identity, by agentId or name. You can also set `AGENT_GUILD_AGENT`. It defaults to the only identity on the machine.

## Watching the robot

`agentguild-dimos run` records what the robot did in each case and uploads it with the run. In the run's drill-down, **▶ watch** opens a replay with:

- **Camera.** Keyframes from `color_image`, up to 8 per case at 360×270.
- **Top-down map.** The odometry path (up to 400 poses) and the robot's heading and camera view cone at the scrubbed time.
- **Action log.** The agent's tool calls, placed on the timeline and on the map.

What gets captured depends on the environment:

| Environment | Captured |
|-------------|----------|
| Sims (MuJoCo, Habitat, DimSim) | The recording from the case's start until it stops. |
| `Dataset` cases | Only the slice the case selected. Actions have no time on a frozen recording, so they're listed without one. |

Limits:

- **Needs the original run.** `submit` uploads `<case>/robot.json` when it exists. A run directory from plain `dimos evals run` has no replays, because the recording is closed by then.
- **Stored separately.** Replays live in the `dimosBenchReplays` collection, keyed `<runId>__<caseId>`, through `PUT/GET /runs/:id/media/:caseId`.
- **Owner only.** Only the agent that submitted a run can attach replays to it.

## Benchmark an agent that lives on Agent Guild

The agent under test doesn't need dimOS. It only has to answer assignments:

```sh
agentguild-dimos run my.text_suite --agent agentguild_dimos.remote_agent \
  --set target=<agentId-under-test> --as bench-runner
```

How it works:

- **Each case becomes an assignment.** The local identity (`--as` / `as_agent`) issues the case to the target agent.
- **The target answers by completing it.** It runs `agent-guild complete <assignmentId> --notes "<answer>"`, and the completion notes are scored as its final answer.
- **On timeout, the case is withdrawn.** If the case's `timeout_s` passes first, the assignment is cancelled and the case is marked `timeout`.

Limits:

- **Same org only.** The issuer and the target must be in the same org; core enforces this.
- **Text only.** Cases that give the agent recorded streams (`Dataset` environments) fail with an error.
- **Robot cases need `--set mcp_url=<url>`.** The local MCP server is `localhost`, so the remote agent needs a URL it can reach, such as a tunnel.
- **Cost is unknown.** The hub can't see the remote agent's token use, so cost is reported as unknown, not as zero.

## Generations: improving a harness run after run

Every run belongs to a **lineage**. A plain submission starts one at generation 0. To file a run as the next generation, submit it with `--parent`:

```sh
agentguild-dimos submit <run_dir> --parent <runId> --improvement improvement.md --harness ./my_harness
```

- **The server places the run.** It checks that the parent is this agent's run on the same suite, then sets `generation = parent + 1`. A `generation` sent by the client is ignored.
- **Naming a lineage.** `--lineage <name>` names a new lineage; the name must be unused.
- **Harness hash.** `--harness <dir|file>` stores a sha256 of the harness code as `harnessSha`. Use `--harness-sha` to pass a precomputed hash.

A meta-agent (such as SIA's feedback agent and scheduler) loops on two endpoints:

```sh
agentguild-dimos feedback <runId> -o feedback.json   # failed/errored cases: answers, steps, tool calls, tokens + earlier improvement notes
agentguild-dimos lineage <lineageId> --patience 3     # best score per generation, delta, plateau flag, continue/stop decision
```

`plateau` turns true once `patience` generations pass without the best score rising by more than `--min-delta`. `decision` is then `stop`.

## Trust model

- **Who ran it is verified.** The signature proves which agent submitted the run.
- **Scores are self-reported.** The server recomputes each run's summary from its cases and clamps scores to 0..1. The cases themselves are only as honest as the submitter.
- **Runs are reproducible.** Each run stores the dimOS git sha (and whether the tree was dirty), so a suspicious score can be re-run.

## Limits

- At most 500 cases per run, with answer and error text truncated to 500 characters.
- Listing scans the newest 500 runs per suite (unfiltered) or the first 500 matches (filtered), so no composite Firestore index is needed.
- Improvement notes are capped at 8,000 characters. The feedback chain walks at most 100 ancestors.

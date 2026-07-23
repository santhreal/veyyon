# DeepSWE bench for veyyon features

The standing benchmark workflow for any perf-affecting veyyon feature. It runs
the veyyon agent on [DeepSWE](https://github.com/datacurve-ai/deep-swe) tasks
(original, long-horizon tasks from real repos, held-out behavioral verifiers,
isolated Docker environments) under two or more **arms** and writes a table
comparing verifier reward, tokens, cost, and wall time per arm.

An **arm** is one veyyon config overlay in `arms/<name>.yml`. The only thing
that differs between runs of the same task is the arm. Benching a feature means:
add an arm that turns it on, keep or add one that leaves it off, run, read the
table. That is the entire workflow, and it is the same for every feature.

## Prerequisites (once per machine)

0. Clone the tasks into this package: `git clone --depth 1
   https://github.com/datacurve-ai/deep-swe` (the runner defaults to
   `deep-swe/tasks` here; `--tasks-root` overrides).
1. `uv tool install datacurve-pier` (>= 0.3.0) and Docker running.
3. Binary build and auth DB seeding are fully automated by `run.ts`:
   - `run.ts` automatically detects if `dist/vey` is out-of-date and recompiles it.
   - `run.ts` automatically seeds `assets/auth-agent.db` from your host login.
   - All runs execute inside isolated Pier/Docker containers using a throwaway agent profile (zero impact on host user profiles `work` or `default`).

## Running

```bash
cd packages/deepswe-bench
bun run.ts \
  --tasks tasks/pilot-10.txt \
  --arms none,decode,full \
  --model google-antigravity/gemini-2.5-flash \
  --jobs 2 \
  --out ../../runs/deepswe/argot-pilot
```

Flags:

- `--tasks <file>` — newline list of task names (comments with `#`). Omit to
  run every task under the tasks root (full DeepSWE, 113 tasks).
- `--tasks-root <dir>` — override the tasks directory (default: the
  `deep-swe/tasks` clone in this package).
- `--reaggregate <runDir>` — rebuild `results.json` and `report.md` from a
  finished run's raw trial data (usage is recomputed from the persisted
  sessions, so accounting fixes apply retroactively).
- `--arms <a,b,c>` — which `arms/*.yml` overlays to run. Every arm runs every
  task.
- `--limit N` — first N tasks of the list (smoke runs).
- `--jobs N` — concurrent Pier runs. Each task container takes 2 cpu / 8 GB;
  2 is safe on a 16-core/64 GB machine, 4 is the practical ceiling.
- `--model <provider/id>` — the model under test. When the arm gates behavior
  per model (argot does), the arm file names the same model id.

Assets are staged into `<out>/assets/` (the compiled binary, the auth DB, and
the arm overlays) and uploaded into each task container at run time with
Pier's `environment.upload_file`. Two delivery traps shaped this: install
steps run at image build time (no mounts, no host network), and declaring a
bind mount in the job config REPLACES Pier's default `/logs` mounts, which
silently loses the trial's logs. Upload-at-run-time avoids both.

A run directory (default `<repo>/runs/deepswe/<timestamp>/`, or `--out`) collects `jobs/` (raw Pier output, trajectories,
verifier reports), `results.json` (every metric, machine-readable), and
`report.md` (the table).

## Reading the table

- **pass (reward=1)** and **mean reward** — task success from the held-out
  verifier. A feature that changes pass rate is a correctness change, not a
  perf change; treat accordingly.
- **input / output / cache tok** — summed per arm from the persisted veyyon
  session usage. Output tokens are the expensive ones; a compression feature
  should move output tokens down at equal reward.
- **cost USD** — from veyyon's own pricing accounting.
- **agent wall** — seconds inside the agent phase (env setup and verifier time
  excluded).
- **Argot probes** (feature-specific metadata) — how many times the agent
  called `argot_load` and how many assistant messages carried a `§` handle.
  Probe rows only appear for arms that engaged the mechanism; every feature
  should add probes like these to prove engagement, not just outcomes.

Compare arms only on the same model and the same task set. One run per
(arm, task) is a single sample — for a feature with a small expected delta,
rerun or expand the task set before trusting the sign of the difference.

## How it works (and why it is not slop)

- Tasks, images, verifiers, and grading all come from the public bench
  unchanged. Pier executes: the agent works in the task's isolated container,
  commits its work, and the verifier grades the patch in a pristine container.
- `pier_agent/veyyon_agent.py` is the only custom piece: a Pier agent that
  uploads the locally built `vey` binary, auth DB, and arm overlay into the
  container, runs `vey --print` with `--config`, copies the persisted session
  out, and reports usage to Pier's `agent_result`.
- `pier_agent/oneshot_prompt.md.j2` wraps every task instruction in a
  one-shot contract (finish end to end, integrate subagent results, commit
  before stopping). Without it the model treats the run like an interactive
  session: it delegates to subagents, chats with them, and ends its turn
  mid-implementation, producing near-empty patches. The template is applied
  identically for every arm, so arm comparisons stay fair.
- Nothing about the arm changes the harness, the task, or the verifier — only
  veyyon's own config. If a feature cannot be toggled from config, it is not
  benchable this way, which is itself a finding about the feature.
- Failed runs are recorded with their error and counted separately, never
  silently dropped from the table.

## System Prompt Candidate Arms

To evaluate a **system prompt variation**:
1. Create `arms/<arm_name>.yml` with your config overrides (e.g. `arms/candidate.yml`).
2. Create `arms/<arm_name>.prompt.md` containing your candidate system prompt template (e.g. `arms/candidate.prompt.md`).
3. Run `bun run.ts --arms baseline,candidate --tasks tasks/pilot-10.txt`.

The runner will automatically stage the candidate system prompt into the Docker container and pass `--system-prompt` to `vey`.
## The argot pilot arms (2026-07-21)

- `none` — `argot.enabled: false`.
- `decode` — enabled and loadable, but the model allowlist is empty, so nothing
  is ever taught (isolates the cost of the feature being armed).
- `full` — enabled, `gemini-2.5-flash` allowed to encode; the agent loads the
  project itself with `argot_load` and writes handles.

## Argot on DeepSWE: what is and is not measurable

Veyyon's argot flow is agent-driven over a generated vocabulary: when the
model calls `argot_load <folder>`, the harness generates the dictionary from
the repo's git-tracked listing and caches it outside the repo. There is no
committed dictionary file to stage, and nothing about the task environment
differs between arms — which keeps the arm comparison clean.

That makes the bench measure three distinct things:

1. **Enablement overhead** (none vs decode vs full, all tasks): what the
   preamble, the tools, and the decode seams cost when the feature exists.
   Pilot answer: within noise, ~0.7% input tokens.
2. **Organic adoption** (full arm, `argot_load_calls` probe): whether the
   model chooses to load on its own. The 2026-07-22 pilot recorded zero loads
   across every run — adoption, not the codec, is the unproven link
   (ARG-BENCH).
3. **Codec value when engaged**: only measurable on tasks whose repos carry
   repeated-long-token mass. `gen-dicts.ts` ranks all 113 tasks by the SDK's
   `estimatedSavings` over a generated dictionary (`dicts/report.md`); the
   argot pilot list (`tasks/argot-10.txt`) is the top of that ranking. The
   same generator drives both the ranking and `argot_load`, so the estimate
   and the harness can never disagree about what a load would contain.

If adoption stays zero on high-mass repos, the defect is the product's
invitation (preamble, tool surface), not the bench — and the fix belongs in
veyyon, then this run repeats.

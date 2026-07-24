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

### BINDING RULE: Single Independent Variable Rule (Controlled Experiments)
Every evaluation comparison MUST vary **EXACTLY ONE independent variable** between arms:
- **Prompt Benchmark:** Same model, same feature flags; ONLY one section of the system prompt differs. Override exactly one banner section via the candidate's `arms/<arm>.sections.yml`; its control is the same config with no sections file. Every other section — and every settings-gated block in it — stays byte-for-byte. The override reaches the agent only through the eval-only `VEYYON_EVAL_SYSTEM_PROMPT_SECTIONS` env var, never a config key, so it cannot leak into a normal run. See "Prompt section arms" below.
- **Feature Flag Benchmark:** Same model, same prompt; ONLY the setting flag differs (e.g. `argot.enabled: false` vs `argot.enabled: true`).
- **Model Benchmark:** Same prompt, same feature flags; ONLY the `--model <id>` differs.

**NEVER vary multiple factors in a single arm comparison.** If an arm alters the prompt AND the model AND a setting simultaneously, the benchmark is invalid because observed deltas cannot be attributed to a single cause.

**NEVER replace the whole system prompt to test a prompt change.** A whole-prompt override (a custom `SYSTEM.md` / `--system-prompt` snapshot) freezes a point-in-time copy that no longer responds to settings, and it silently drops every settings-gated section it forgets to copy — the delegation block renders only when the delegation setting is on, so a hand-compressed snapshot that omits it inverts that setting invisibly. That is two hidden variables, not one. Override one named section instead; the engine renders all the others.

The runner enforces three mechanical floors of this rule:

1. **Zero-IV collision.** If any two arms in a run stage byte-identical inputs (same `.yml` and same/no prompt module and same/no rule), it fails loudly with the colliding arm names. A comparison between identical arms varies zero variables, so its "delta" is pure noise — the exact defect behind earlier `candidate-vN` arms that were copied from `baseline` with nothing changed.
2. **Treatment-not-applied (pre-run).** If an arm turns argot encoding on with a non-empty `argot.models` allowlist that does not include the `--model` under test, it fails loudly before running. argot only encodes for a model on its allowlist, so such an arm would SILENTLY degrade to decode-only while still being labelled the encode condition — a silent fallback living inside the eval set. The check uses argot's own `modelAllowed` predicate (exported from the SDK), so it can never drift from the gate the runtime actually applies. A deliberately decode-only arm (`enabled: true`, empty allowlist, as in `arms/decode.yml`) is fine and passes.
3. **Treatment-not-applied (post-run, authoritative).** The pre-run check matches the model string you *requested*, but the runtime resolves that id through the catalog (provider aliases, effort-tier collapsing) to a different logical id before the encode gate sees it. A requested `google-antigravity/gemini-3.6-flash` that the catalog serves as logical `gemini-3.5-flash` passes the pre-run check (3.6 is on the list) yet fails the gate (the resolved 3.5 is not), so the arm runs decode-only anyway. After the run, the bench reads whether the encode preamble actually reached the model (from each session's system prompt) and **fails closed** if an encode arm never taught it in any OK trial. This is why the default `--model` and the `full` arm's allowlist both name the resolved logical id `gemini-3.5-flash`, not the `gemini-3.6-flash` display alias: requested and resolved must agree, or the run is inert. Watch the `preamble taught` column in the report (below).

## Canonical single-IV comparisons

These are the sound pairings the shipped arms are built for. Each varies exactly one thing, so a delta is attributable:

| Comparison | Arms | The one variable |
|---|---|---|
| Feature flag | `baseline` ↔ `argot-setting-only` | `argot.enabled` false → true, nothing else |
| The nudge rule | `argot-setting-only` ↔ `candidate-argot-nudge` | adds `arms/candidate-argot-nudge.rule.md` (an always-apply rule), same config |
| Teaching (encode) | `decode` ↔ `full` | the model is allowlisted to encode and taught the preamble; codec/loadability held equal |
| Model | any single arm, two `--model` values | only `--model` differs |

Do not compare across two of these at once (e.g. `baseline` ↔ `full` mixes the feature flag AND teaching). Pick the pair whose single variable is the effect you want to measure.

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
  --arms baseline,decode,full \
  --model google-antigravity/gemini-2.5-flash \
  --jobs 2 \
  --repeats 3 \
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
- `--limit N` — sample N tasks for a smoke run. The picks are spread evenly
  across the sorted task list (an even stride), not the first N: task names are
  repo-prefixed, so the first N would cluster on one repo and bias the pass rate.
  The subset is deterministic (same `N` picks the same tasks) and its pass rate is
  an estimate over that subset, not the full suite. The exact tasks sampled, `N`,
  and the full task count are recorded in `results.json` (`tasks`, `limit`,
  `totalTasksAvailable`) so a limited run is never mistaken for a full one.
- `--jobs N` — concurrent Pier runs. Each task container takes 2 cpu / 8 GB;
  2 is safe on a 16-core/64 GB machine, 4 is the practical ceiling.
- `--model <provider/id>` — the model under test. When the arm gates behavior
  per model (argot does), the arm file names the same model id.
- `--repeats K` — sample every (arm, task) cell K times (default 1). LLM agents
  are stochastic, so one sample per cell cannot separate a real arm effect from
  run-to-run noise. With K > 1 the report shows each cell's pass RATE with a 95%
  Wilson confidence interval, and the total run is `arms x tasks x K`. Raise K
  when the expected delta is small; the interval tightens roughly as `1/sqrt(K)`.

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

- **pass rate [95% CI]** and **mean reward** — task success from the held-out
  verifier. With `--repeats K`, each cell is `passRate [low–high] (passes/n)`: the
  fraction of samples that scored reward 1, its 95% Wilson confidence interval,
  and the raw tally. The interval is Wilson, not `rate ± standard error`, on
  purpose: the normal-approximation error collapses to `±0.00` at an all-pass or
  all-fail cell (a `3/3` cell would read as certain when it is not), and those
  boundary cells are common at small K. Wilson stays honestly wide there — `3/3`
  renders `1.00 [0.44–1.00]`. Two arms whose intervals overlap are not
  distinguishable at that sample count — raise `--repeats` before trusting the
  sign. A feature that changes pass rate is a correctness change, not a perf
  change; treat accordingly. Errored samples are excluded from the rate (shown as
  `(+N err)`), never counted as failures.
- **input / output / cache tok** — summed per arm from the persisted veyyon
  session usage. Output tokens are the expensive ones; a compression feature
  should move output tokens down at equal reward.
- **cost USD** — from veyyon's own pricing accounting.
- **agent wall** — seconds inside the agent phase (env setup and verifier time
  excluded).
- **Arm comparison (paired by task)** — the actual arm-vs-arm verdict, and the
  number to read for "did B beat A". For each arm pair it pairs by task (a task
  counts only when both arms produced an OK sample), takes the per-task pass-rate
  delta (B minus A), and decides with a two-sided **exact sign test** over
  per-task wins and losses. Pairing removes between-task difficulty, so this is
  far more powerful than checking whether the two arms' independent intervals
  above overlap. The sign test is exact and makes no normality assumption, so it
  does not overclaim at small task counts: a 5-0 sweep is p=0.0625 (not
  significant), 6-0 is p=0.03125. The **Δ 95% CI** column is a normal-approximation
  effect-size aid; at a small task count trust the sign-test verdict, not the CI.
  A winner is named only at p<0.05.
- **Efficiency comparison (paired by task)** — the section that measures a
  compression feature's actual claim: fewer tokens (and less cost) at equal
  reward. For each arm pair it takes the per-task delta on output tokens and on
  cost (B minus A, negative means B is cheaper) and runs the same exact sign
  test. The verdict is guarded by the pass-rate comparison above: B is called an
  efficiency win only when it is significantly cheaper AND the pass-rate test did
  not find B worse, so "cheaper because it gave up and did less" cannot read as a
  win. A metric the provider never reports (some providers return no cost, so
  every sample is 0) is labelled `not measured` rather than a paired delta of
  zeros, so a missing metric is never mistaken for "measured and found equal".
- **Argot treatment applied? (per arm)** — proof the treatment fired before you
  trust any token delta. The `preamble taught` column is the authoritative signal:
  it reads the actual system prompt the model was given, so it reflects the model
  *after* catalog id resolution. `preamble taught 0/N` on an encode arm means the
  preamble never reached the model (a silent decode-only degrade), so every token
  delta against it is inert whatever the `§` counts say — and the runner fails the
  run closed on exactly that. The row also shows the mean `argot_load` calls, the
  mean assistant messages that carried a `§` handle, and the fraction of runs that
  encoded at all. Encode is detected wherever a handle can land — a text block OR a
  tool call's arguments (commands and diffs carry handles too), not prose alone.
- **Errors (per arm)** — every sample that crashed or was refused, grouped by
  reason, across all arms including those with zero errors. An errored sample is
  excluded from every rate and mean above, so an arm that errors more is measured
  on fewer, possibly easier samples: a delta against it can be a selection effect.
  A provider content-filter stop is named by its finish reason (for example
  `NonZeroAgentExitCodeError (PROHIBITED_CONTENT)`), because a refusal that tracks
  one arm — say an injected preamble — is a confound you must see, not an
  anonymous "+N err". If one arm shows a refusal asymmetry, raise `--repeats` so a
  single flake does not decide the comparison, and read whether the asymmetry
  persists.
- **Argot probes** (feature-specific metadata) — how many times the agent
  called `argot_load` and how many assistant messages carried a `§` handle.
  Probe rows only appear for arms that engaged the mechanism; every feature
  should add probes like these to prove engagement, not just outcomes.

Compare arms only on the same model and the same task set. For a feature with a
small expected delta, raise `--repeats` (more samples per cell) and/or expand the
task set before trusting the sign of the difference; read the paired arm
comparison (sign-test p) for the verdict, not the overlap of the two per-arm
intervals. When you compare one baseline against several candidate arms at once,
remember that testing many pairs inflates the chance of a spurious p<0.05 — treat
a single significant pair among many as a lead to confirm on more tasks, not a
settled result.

## How it works (and why it is not slop)

- Tasks, images, verifiers, and grading all come from the public bench
  unchanged. Pier executes: the agent works in the task's isolated container,
  commits its work, and the verifier grades the patch in a pristine container.
- `pier_agent/veyyon_agent.py` is the only custom piece: a Pier agent that
  uploads the locally built `vey` binary, auth DB, arm overlay, any `.rule.md`,
  and any per-section prompt override into the container, runs `vey --print`
  with `--config` (setting `VEYYON_EVAL_SYSTEM_PROMPT_SECTIONS` only when the arm
  carries an override), copies the persisted session out, and reports usage to
  Pier's `agent_result`.
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
- Every arm runs at a pinned sampling temperature. The bench sets `temperature: 0`
  (greedy) into each staged arm config unless the arm sets its own, so `--repeats`
  measures a stable regime rather than veyyon's `-1` provider default, which can
  drift silently between runs. Temperature 0 is greedy, so top-p / top-k are
  irrelevant and temperature alone fixes the regime. The effective temperature per
  arm is stamped into `results.json` under `sampling`, so two runs weeks apart are
  comparable and any change of regime is visible in a diff. An arm may set its own
  non-negative `temperature` for a deliberate temperature-as-variable experiment;
  that override is respected and recorded.

## Prompt section arms

The system prompt is benched one section at a time. The default prompt is built
from named banner sections — `conventions`, `role`, `runtime`, `toolPolicy`,
`executionWorkflow`, `deliveryContract` — and a per-section override swaps
exactly one of them while every other section, and every `{{#if <setting>}}`
conditional inside it, is reused byte-for-byte from the shipped prompt. That is
why this is the only sanctioned way to bench a prompt change: overriding
`executionWorkflow` cannot touch the settings-gated delegation block in
`toolPolicy`, so an eval can never silently override a setting the way a
whole-prompt snapshot does.

The override is EVAL-ONLY and uncontaminatable. It is not a config key and not a
CLI flag: `vey` reads it exclusively from the `VEYYON_EVAL_SYSTEM_PROMPT_SECTIONS`
environment variable (a JSON object of `section -> replacement text`), which the
bench sets around a single arm and nothing else sets. A normal run — yours or
production — has no way to reach the path, so no `config.yml` can shift a prompt
section. When the var is present `vey` logs a loud warning that the prompt is not
the production one; when it is absent the production prompt is used verbatim.

Put the override in the candidate arm's `arms/<arm>.sections.yml` (a YAML mapping,
authored for readability; `run.ts` compiles it to the JSON the env var carries).
Each value MUST begin with that section's banner — `vey` rejects a banner-less
override, an unknown section name, and a non-string value loudly, so a section
change never fails silently:

```yaml
# arms/candidate-lean-workflow.sections.yml
executionWorkflow: |
  EXECUTION WORKFLOW
  ==============
  # ... your compressed workflow section, banner included ...
```

Workflow:

1. Copy the control arm's `.yml` to `arms/<arm>.yml` (the config stays identical).
2. Add `arms/<arm>.sections.yml` with exactly one section's replacement.
3. Run `bun run.ts --arms <control>,<arm> --tasks tasks/pilot-10.txt`.

If the candidate ends up identical to its control (empty override, or a config
copied with nothing else changed), the runner refuses to run and names the
collision — see the Single Independent Variable Rule above.

An arm may also carry `arms/<arm>.rule.md`, injected as one always-apply rule
into `~/.veyyon/rules/` — a separate single-IV vehicle for benching an additive
behavioral nudge rather than a section rewrite (this is what
`candidate-argot-nudge` uses).

## The argot pilot arms (2026-07-21)

- `baseline` — `argot.enabled: false` (the control; no argot at all).
- `argot-setting-only` — `argot.enabled: true`, defaults otherwise.
- `candidate-argot-nudge` — `argot-setting-only` plus `arms/candidate-argot-nudge.rule.md`.
- `decode` — enabled and loadable, but the model allowlist is empty, so nothing
  is ever taught (isolates the cost of the feature being armed).
- `full` — enabled, with an `argot.models` allowlist that names the resolved
  logical id of the model under test (the default is `gemini-3.5-flash`), allowed
  to encode; the agent loads the project itself with `argot_load` and writes
  handles. The allowlist must match the model *after* catalog resolution, not the
  display alias you typed: if you bench a `--model` whose resolved id the allowlist
  does not name, the pre-run guard refuses to start when the requested id misses,
  and the post-run preamble check fails the run closed when a resolved id silently
  misses. Confirm `preamble taught N/N` in the report before trusting a delta.

## Argot on DeepSWE: what is and is not measurable

Veyyon's argot flow is agent-driven over a generated vocabulary: when the
model calls `argot_load <folder>`, the harness generates the dictionary from
the repo's git-tracked listing and caches it outside the repo. There is no
committed dictionary file to stage, and nothing about the task environment
differs between arms — which keeps the arm comparison clean.

That makes the bench measure three distinct things:

1. **Enablement overhead** (baseline vs decode vs full, all tasks): what the
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

---
name: evals
description: Standing maintainer workflow for running, tuning, and evaluating Veyyon system prompt variations, flags, and feature overlays using isolated DeepSWE benchmarks with zero profile impact.
---

# Veyyon Evals & Prompt Tuning Workflow

This skill defines the mandatory workflow for conducting evaluations, prompt tuning, and A/B benchmark experiments in Veyyon.

## BINDING PRINCIPLE: No Prompt Changes Without Evals
**System prompts, tool policies, or agent rules MUST NOT be modified in production without baseline vs. candidate benchmark evaluations.** The primary objective of prompt tuning is **HIGHER correctness (verifier score)** without reward hacking, while optimizing token cost and wall time.

## BINDING RULE: Single Independent Variable Rule (Controlled Experiments)
Every evaluation comparison MUST vary **EXACTLY ONE independent variable** between arms:
- **System Prompt Benchmark:** Same model, same feature flags, same config; ONLY one banner section differs, via the candidate's `arms/<arm>.sections.yml`. Its control has no sections file. There is no whole-prompt arm.
- **Feature Flag Benchmark:** Same model, same prompt; ONLY the setting flag differs (e.g. `argot.enabled: false` vs `argot.enabled: true`).
- **Model Benchmark:** Same prompt, same feature flags; ONLY the `--model <id>` differs.

**NEVER vary multiple factors in a single arm comparison.** If an arm alters the prompt AND the model AND a setting simultaneously, the benchmark is invalid because observed deltas cannot be attributed to a single cause.

---
## 1. Zero-Impact & Ephemeral Isolation Guarantee
- Evaluation runs execute inside isolated Docker containers via Pier (`datacurve-pier`).
- Credentials are read-only seeded copies (`assets/auth-agent.db`).
- **ZERO side effects on host user profiles (`work`, `default`, etc.):** session history, active profile settings, and memories are never modified or touched.

---

## 2. Setting Up an Arm (Prompt & Flag Overlay)

An **arm** is one Veyyon experiment configuration under `packages/deepswe-bench/arms/`.

To test a system prompt candidate:
1. Create `arms/<arm_name>.yml` (the config overlay, identical to the control):
   ```yaml
   # Arm flag overlay configuration
   argot:
     enabled: false
   ```
2. Create `arms/<arm_name>.sections.yml` with the one section body you are changing:
   ```yaml
   # Replaces only the tool-policy body. Do not include its banner.
   # The section registry adds the canonical banner.
   toolPolicy: |
     # ... your tool-policy variant ...
   ```
   The runner (`run.ts`) compiles this to the JSON that `vey` reads from the
   eval-only `VEYYON_EVAL_SYSTEM_PROMPT_SECTIONS` environment variable, set for
   this arm only.

### Swap one section, never the whole prompt

Pasting a whole prompt is how an unrelated setting quietly dies, so there is no whole-prompt arm vehicle. The shipped instructions live in statement modules. Their rows hold whole-statement conditions such as `when("taskIrcEnabled")`, and their Markdown files hold wording-level Handlebars variables. The outer `system-prompt.md` scaffold contains only `{{templateSections}}`.

The `.sections.yml` mechanism changes one body in the complete statement-assembled section map:

```ts
const statementSections = assembleStatementSections(context);
const sectionOverrides = resolveSectionOverrides({
  toolPolicy: myToolPolicyBody,
});
const candidate = assembleDefaultTemplate({
  ...statementSections,
  ...sectionOverrides,
});
```

The public section ids are `conventions`, `role`, `runtime`, `tool-policy`, `execution-workflow`, and `delivery-contract`. Replacement values contain body text only. The section registry supplies the canonical banner and order. Because the candidate map spreads one replacement over the complete shipped map, every other statement and condition stays unchanged.

The override is eval-only and uncontaminatable by design. It is not a config key and not a CLI flag. `vey` reads it only from `VEYYON_EVAL_SYSTEM_PROMPT_SECTIONS`, which the bench sets around one arm. No `config.yml` on your machine or in production can reach this path. When the variable is set, `vey` logs that the prompt is not the production prompt. Malformed JSON, an unknown section, a non-string value, or a legacy replacement carrying its own banner fails loudly.

### The parity guard

`packages/coding-agent/src/system-prompt-settings-parity.test.ts` locks every gating setting to a concrete anchor string in the rendered prompt. Toggling `taskIrcEnabled` must add or remove `ask A via \`irc\``; toggling `eagerTasksAlways` must add or remove `MUST fan the work out`; and so on for every setting. If an edit drops a branch, the matching test goes red instead of shipping a dead setting. A coverage test also fails if you add a new gating setting without a parity assertion, so the guard cannot fall behind the template. Run it before you promote any prompt change:

```bash
bun test packages/coding-agent/src/system-prompt-settings-parity.test.ts
```

---

## 3. Running an A/B Benchmark Evaluation

Navigate to `packages/deepswe-bench` and run:

```bash
cd packages/deepswe-bench

# Run baseline vs candidate arm comparison
bun run.ts \
  --arms baseline,candidate-argot-nudge \
  --tasks tasks/pilot-10.txt \
  --model google-antigravity/gemini-3.5-flash \
  --jobs 2 \
  --repeats 3 \
  --out runs/prompt-tuning-01
```

### Command Flags:
- `--arms <a,b>`: Comma-separated list of arms to evaluate (e.g. `baseline,candidate-argot-nudge`).
- `--tasks <file>`: Task list (e.g. `tasks/smoke.txt` for 1 task, `tasks/pilot-10.txt` for 10 pilot tasks, `tasks/argot-10.txt`, or omit for full 113 DeepSWE tasks). Each list declares its provenance in a header directive: `# @headline` for an unbiased, representative set whose numbers you can report as a headline, `# @biased: <reason>` for a set curated to favour the feature (a best-case upper bound only). The report prints a loud banner from it. Report a headline argot efficiency number ONLY from `tasks/diverse-20.txt` (`@headline`); `tasks/argot-10.txt` is `@biased` (repos with the most compressible token mass), so it measures the codec's best case, never the real-world average, and `tasks/pilot-10.txt` is `@biased` (hardest tasks, pessimistic pass rate). Reading a big saving on `argot-10` as "argot saves X%" is the exact selection-bias error the banner exists to stop.
- `--model <id>`: Provider & model under test (default: `google-antigravity/gemini-3.5-flash`; requested==resolved is required for the argot encode allowlist to match — see criterion 5).
- `--jobs N`: Number of parallel task containers (default: `2`).
- `--repeats K`: Samples per (arm, task) cell (default `1`). LLM agents are stochastic; a single sample cannot tell a real arm effect from noise. With `K > 1` the report shows each cell's pass RATE with a 95% Wilson confidence interval, printed as `0.67 [0.30–0.90] (4/6)`. The interval is Wilson, not `rate ± standard error`, because the normal-approximation error collapses to a misleading `±0.00` at an all-pass or all-fail cell (`3/3` reads as certainty when it is not); the Wilson interval stays honestly wide there (`3/3` → `1.00 [0.44–1.00]`). Raise `K` to tighten the interval (width shrinks roughly as `1/sqrt(K)`), and treat two arms whose intervals overlap as not yet distinguishable at that sample count.
- `--limit N`: Sample `N` tasks for a smoke run, spread evenly across the sorted task list (an even stride), not the first `N`. Task names are repo-prefixed, so the first `N` would cluster on one repo and bias the pass rate; the even stride keeps the subset representative while staying deterministic. A limited run's pass rate is an estimate over that subset, not the full suite — `results.json` records `tasks`, `limit`, and `totalTasksAvailable` so a smoke run is never mistaken for a full one. Use it to shake out plumbing, not to report a headline number.
- `--dry-run`: Run every pre-run guard and STOP before the first container. Always do this first. It validates each arm's YAML, stages any sections file, pins temperature, computes arm fingerprints and checks for a zero-IV collision, matches every encode arm's allowlist against `--model`, confirms the task files and agent binary exist, and runs the auth preflight; then it prints the queue, each arm's resolved inputs, the task set's `@headline`/`@biased` provenance, and how many trials of real quota the run would cost, and exits 0 writing no report. Seconds instead of the hours a real run takes, since one DeepSWE task can hold a container for 90 minutes and a one-line YAML typo is otherwise discovered only afterwards.
- `--tasks-root <dir>`: Directory holding the DeepSWE task definitions. Defaults to `deep-swe/tasks` inside the bench package, then `$DEEPSWE_TASKS_ROOT`. Point it elsewhere if you keep the task corpus outside the repo; the runner fails before any container if no task root resolves.
- `--trial-timeout <seconds>`: Wall-clock ceiling for ONE trial. There is no flat default: each task gets the budget its own `task.toml` declares, `[environment].build_timeout_sec` + `[agent].timeout_sec` + `[verifier].timeout_sec`, because the harness runs one timer across all three phases. Pass the flag only to shorten a run deliberately. A ceiling below a task's budget truncates it rather than shortening it, and the truncation is not neutral between arms: a slower-per-turn arm eats more truncations, so a flat ceiling turns "slower per turn" into "solves fewer tasks". The run warns before it starts when the flag truncates any selected task, the report counts harness kills separately from agent failures, and any delta between arms with different timeout counts is printed as `not attributable (timeout gap)` rather than as a winner.
- `--binary <path>`: Use an already-built `vey` binary instead of rebuilding from the working tree, and stage those exact bytes. Point it at an earlier run's `assets/vey`. This exists to make POOLING possible: `--merge` refuses runs whose binary sha differs, the runner rebuilds whenever anything under `packages/coding-agent/src` is newer than the binary, and in a shared tree that is every day (three runs on 2026-07-25 staged three different binaries). Pin every run of a comparison after the first to the first run's staged copy and the days pool. It announces itself loudly, because the run then measures that binary's code and not the working tree's: you give up testing today's code to buy a reward comparison with enough decisive tasks to mean anything.
- `--out <dir>`: Directory where results and verbatim traces are stored.

### Pinned sampling regime (held constant across arms, stamped for the long term)
Every arm runs at a pinned sampling temperature so `--repeats` measures a stable regime and two runs stay comparable over time. The bench writes `temperature: 0` (greedy) into each staged arm config unless the arm sets its own, instead of inheriting veyyon's `-1` "provider default", which can change silently between runs and make them non-comparable with nothing recording the drift. Temperature 0 is greedy decoding, so top-p / top-k do not matter and temperature alone fixes the regime. The choice is deliberate: at temperature 0 the only run-to-run variation is genuine provider nondeterminism, so a small `K` estimates each arm's pass rate with the tightest interval and a real arm effect is detectable with fewer samples. The effective temperature per arm is recorded in `results.json` under `sampling`, on both the main run and a `--reaggregate`, so a longitudinal diff catches any regime change. An arm may set its own non-negative `temperature` for a deliberate temperature-as-independent-variable experiment; that override is respected and stamped, and the runner logs it.

### Three guards the runner enforces
1. **Zero-IV collision:** two arms that stage byte-identical `(config, sections, rule)` inputs fail loudly — a comparison of identical arms varies nothing, so its delta is noise.
2. **Treatment-not-applied (pre-run):** an arm that enables argot encoding with a non-empty `argot.models` allowlist that excludes the *requested* `--model` fails loudly before running. argot only encodes for an allowlisted model, so such an arm would SILENTLY become decode-only while labelled "encode". The guard uses argot's own `modelAllowed` predicate so it cannot drift from the runtime gate. A deliberately decode-only arm (empty allowlist, like `decode.yml`) is allowed.
3. **Treatment-not-applied (post-run, authoritative):** the pre-run guard matches the *requested* model string, but the runtime resolves it through the catalog (provider aliases, effort-tier collapsing) to a different logical id before the gate runs — this really happened: `google-antigravity/gemini-3.6-flash` was aliased onto logical `gemini-3.5-flash`, so a `[..., gemini-3.6-flash]` allowlist passed the pre-run guard yet the resolved 3.5 failed the gate and the arm ran decode-only. After the run the bench reads whether the encode preamble actually reached the model (from each session's `session_init` system prompt) and **fails closed** if an encode arm never taught it in any OK trial. The catalog alias has since been removed so 3.6 resolves to 3.6. The default `--model` and every encode arm's allowlist name `gemini-3.5-flash`, chosen for having a known-good recent run and NOT because another id is unservable: an all-errored run on some other id is far more often an auth failure wearing that id's name, so check for a registry-error line and re-seed the auth DB before you suspect the id. Whatever model you pick, the `--model` you pass and the arm allowlists must name the SAME id or the pre-run guard refuses to start. Check the `preamble taught` column.

### Canonical single-IV comparisons
Use the pairing whose one variable is the effect you want; never compare across two at once (`baseline` ↔ `full` mixes the flag AND teaching):
- `baseline` ↔ `argot-setting-only` — the feature flag alone.
- `argot-setting-only` ↔ `candidate-argot-nudge` — the additive rule alone.
- `decode` ↔ `full` — the teaching (encode) alone, codec/loadability held equal.
- one arm, two `--model` values — the model alone.

---

## 4. Re-Aggregating & Analyzing Results

If accounting code or trace analysis is updated, re-calculate metrics without re-running trials:
```bash
bun run.ts --reaggregate runs/prompt-tuning-01
```

### Pooling several days into one comparison

A paired sign test needs at least 6 decisive tasks before any outcome can clear the
adjusted bar, and one day of provider quota funds roughly fifteen tasks across two
arms. When a comparison comes back **not distinguishable (underpowered)**, the fix
is more samples, and those usually have to be gathered on a later day. Pool them:

```bash
bun run.ts --merge runs/2026-07-25T19-51-41-474Z,runs/2026-07-26T08-11-02-330Z \
  --out runs/pooled-sig-max4000
```

- `--merge A,B,C`: comma-separated run directories to pool into one comparison. Each
  needs a `results.json`; run `--reaggregate` on it first if the run died before
  writing one.
- `--out DIR`: where to write `merged-report.md` and `merged-results.json`. Defaults
  to the last directory passed to `--merge`.

Pooling across days is only sound because every run carries **both** arms, so each
task's pair is measured under the same provider conditions, binary and hour, and a
paired test differences the day-to-day variation away. The merge refuses, rather
than warns, when that argument breaks: runs carrying different arms (the day effect
lands entirely on the single arm present, which fabricates a result rather than
degrading one), different models, different binaries, or an arm whose config
fingerprint changed between runs (every row still shows the same arm name, so
nothing downstream could catch it).

Plan for this before you start: **freeze the binary across every run you intend to
pool.** The runner records the `vey` binary's sha, and any change under
`packages/coding-agent` or `packages/ai` rebuilds it, so a day of ordinary
development between two runs is enough to make them unmergeable. Land the code you
want measured, then gather all the days, then resume editing. Changes confined to
`packages/deepswe-bench` do not rebuild the binary and are safe to make in between.

## 5. Evaluation Criteria (What Counts as a Win)

1. **Correctness / Verifier Reward (PRIMARY):** Candidate must match or exceed baseline score on held-out verifier tests. Lower correctness is UNACCEPTABLE. Read the verdict from the report's **Arm comparison (paired by task)** section, not from whether the two arms' per-arm intervals overlap: it pairs by task (removing between-task difficulty) and decides with a two-sided exact sign test, so it is both more powerful and honest at small task counts. A candidate is a win only when the paired sign test reaches **Holm-adjusted `adj p` < 0.05** in its favor. The report now corrects for multiple comparisons directly: a run with k arms tests k(k-1)/2 pairs, so the `adj p (Holm)` column holds the family-wise false-positive rate at 5% no matter how many arms you compare, and the verdict is decided on it, not the raw p. A raw p<0.05 whose `adj p` is above 0.05 is exactly the false winner the correction exists to reject. Read the null carefully too: a row that says **not distinguishable (underpowered)** had too few decisive tasks for any outcome (even a clean sweep) to reach the adjusted bar — with one pair the floor is 6 decisive tasks (a 5-0 sweep is only p=0.0625), two pairs need 7 — so it means "add tasks", not "the arms are equal". Only a plain **not distinguishable** is a real measured null. Raise `--repeats` and/or the task count when the delta is small or the verdict is underpowered. Note the pass rate excludes a trial the verifier never scored: a missing reward is the `verifier-no-reward` error class (surfaced in **Errors (per arm)**), not a fail — a real failure is reward=0, so an unscored trial that folded in as a fail would understate correctness and let a scorer outage that tracks one arm masquerade as a correctness loss. Read that error row for asymmetry the same way you read a refusal asymmetry.
2. **No Reward Hacking:** Edits must be genuine, production-grade implementations. No stubs, simplified fallbacks (`"for now"`), or skipped test cases.
3. **Effect ceiling (check BEFORE believing any efficiency number):** Read the **Encode headroom — the maximum saving that was ever available** section first. It reports what the feature could have saved at PERFECT adoption (every occurrence of every loaded handle, in text and tool-call arguments) against the run's own observed token noise (the spread across repeated samples of the same arm and task). A `**CANNOT MEASURE**` verdict means the ceiling is below the noise: the efficiency table is reading variance and NOTHING can be concluded about the feature, in either direction. Do NOT report such a run as "the feature does not help" and do NOT add repeats — this is a WORKLOAD limit, not a sample-size limit (that is what the separate `(underpowered)` qualifier means, and the two are orthogonal). Fix it by choosing tasks whose repos repeat long paths and commands the agent actually retypes, or by fixing the vocabulary. For argot specifically the dominant lever was believed to be `argot.tokenBudget`: the PROJECTED ceiling on the ytt repo is 1.01% at the default 1000, 2.56% at 4000, and 19.07% at 16000, against 8.15% noise, which is why the `full ↔ full-budget16k` pair exists. **That projection is about 50x too high.** The first run to test it (`runs/argot-smoke-0724`, 2026-07-24, same ytt task, 16000 budget) loaded 551 handles and measured a 0.24% ceiling, verdict `CANNOT MEASURE`. "Agent-typeable mass" counts every handle an agent COULD type; that run emitted 8 of 551. So NO current arm pair measures argot's token claim on this workload: measure adoption via `runs that encoded` instead, and see ARGOT-HEADROOM-PROJECTION-OFF-BY-50X before sizing a run on budget numbers. Read `input tok` as well as `output tok` there: a bigger dictionary rides in the prompt every turn, so it buys shorter output by spending input, and both are now scored. The first real argot run measured 33 handles loaded, only 7 ever emitted, a 0.27% ceiling against 8.15% noise: the dictionary was full of license text, example-fixture YAML, and doc URLs (strings that repeat in the repo but that no coding agent types) while the paths the agent retyped constantly got no handle at all.
4. **Efficiency:** Reduced output token bloat, lower wall time, and streamlined tool call distribution are secondary wins when correctness is preserved. Read the **Efficiency comparison (paired by task)** section: it runs the same paired sign test on output tokens and cost, Holm-corrected across each metric's arm pairs, and calls a saving a win only when it is significant on the adjusted p AND neither correctness comparison found the cheaper arm worse. "Correctness" here is BOTH the binary pass rate (SWE-bench resolved) AND the **Reward comparison — continuous partial credit** section: the binary rate cannot see a fractional-reward regression (an arm scoring 0.4 instead of 0.8 on hard tasks flips no pass/fail), so the guardrail also requires the continuous mean reward not to drop, closing argot's "at equal reward" loophole. Each veto is judged on its own Holm-adjusted p so no two sections can disagree. A metric the provider does not report (some providers return no cost, so every sample is 0) shows `not measured`, never a false "equal".
5. **Treatment actually fired (prerequisite, not optional):** Before you trust any efficiency delta for a feature, confirm the **Argot treatment applied? (per arm)** section shows the mechanism engaged. The authoritative column is `preamble taught`: it reads the actual system prompt the model was given (after catalog id resolution), so `preamble taught N/N` proves encode fired and `0/N` proves it never reached the model — a silent decode-only degrade that makes every token delta against that arm inert, and one the runner now fails closed on. Secondary signals: non-zero `argot_load` calls and `§`-carrying messages with an `encoded/N` fraction above zero. Encode is counted wherever a handle can appear, including inside tool-call arguments (commands and diffs), not prose alone.

   Teaching alone does not make an arm measurable, so read the `vocab handles` column next to it: the handle count the launch project's dictionary actually loaded, from the agent's `argot_armed` record. A `0 encoded` result means three different things depending on that number, and only one of them is a result about argot. `vocab handles 0` means the repo had no repeated-token mass, the dictionary came out empty, and encoding was IMPOSSIBLE — the token delta measures nothing about the feature, so do not report it as "argot does not help"; switch to tasks whose repos repeat long paths and commands. A positive `vocab handles` with `0/N` encoded means the model had shorthand available and declined to use it, which is a real model-adoption finding chargeable to the model, not the corpus. Only `encoded > 0` makes the delta a genuine argot measurement. A `—` means the run predates the telemetry and its null is uninterpretable: rerun before drawing any conclusion. The report prints the matching interpretation under the table. Note `argot_load` calls stay `0.00` for the launch project by design (it auto-loads at startup; the tool adds additional projects), so a zero there is not evidence of anything.
6. **Read the predicted-vs-actual block the run prints after the report.** For a run with a `baseline` arm and a context lever, the runner derives each treatment arm's predicted saving from that arm's own staged settings against this run's baseline transcripts, and prints it beside the measured cost delta over the tasks both arms completed. The `gap` is a statement about the INSTRUMENT rather than the arm: a small one means the simulator can size the next lever without buying the answer, a large one means every other prediction it makes should be re-read. Two outputs are refusals rather than numbers and must not be read as results. `NO PREDICTION` / `PARTIAL PREDICTION` means the arm sets a lever with no simulator (`context.thinkingRetention` and `tools.inlineOutputFloor` today), so the total covers only part of the treatment. `no paired trials with usage` means the treatment arm billed nothing, which is what a quota kill looks like, and it is not a 100% saving.

5. **Watch the Errors (per arm) section for a refusal asymmetry.** An errored or provider-refused sample is excluded from every rate and mean, so an arm that errors more is scored on fewer, possibly easier samples and a delta against it can be a selection effect. A provider content-filter stop is named by finish reason (e.g. `PROHIBITED_CONTENT`). If one arm shows more refusals than another — most of all if the refusal tracks an injected preamble — that is a confound: raise `--repeats` and check whether the asymmetry persists before reading the deltas.

---

## 6. Prompt Cache Stability Law & 3 CWD Mutation Vectors
- **Prefix Caching Rule:** LLM APIs hash the system prompt + conversation prefix starting from line 1.
- **The 3 CWD Mutation Vectors:** Working directory changes occur via:
  1. *Profile Defaults (`session.workdir` setting)*: Updating it mid-session updates future session defaults without mutating live prompt headers.
  2. *Agent Tool (`set_cwd`)*: Re-roots live session scope for path resolving (`[name#tag]`); prompt header metadata remains frozen until context compaction.
  3. *User Commands (`/cwd`, `/move`)*: Changes interactive execution scope without invalidating system prompt prefix hashes.
- **Zero Mid-Session Prompt Mutation:** Never mutate system prompt templates or workstation metadata (`<workstation>`, `cwd`, active profile labels) mid-session before context compaction.
- **Cache Invalidation Penalty:** Modifying `cwd` or workstation stats mid-session invalidates the prefix cache for all subsequent turns, triggering 100% cache-miss token inflation.
- **Safe Mutation Seams:** Workstation/profile updates belong strictly at or after context compaction, when history is re-primed and the prompt cache is naturally reset.

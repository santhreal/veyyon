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
2. Create `arms/<arm_name>.sections.yml` with the one section you are changing:
   ```yaml
   # Replaces only the tool-policy region. Each value MUST start with that
   # section's banner. The rest of the prompt stays byte-for-byte identical.
   toolPolicy: |
     TOOL POLICY
     ==============
     # ... your tool-policy variant, banner included ...
   ```
   The runner (`run.ts`) compiles this to the JSON that `vey` reads from the
   eval-only `VEYYON_EVAL_SYSTEM_PROMPT_SECTIONS` environment variable, set for
   this arm only.

### Swap one section, never the whole template

Pasting a whole template is how a setting quietly dies, so there is no whole-prompt arm vehicle. The default template gates each setting behind a conditional, for example `{{#if taskIrcEnabled}}`. When you hand-copy the template and edit one region, it is easy to drop a conditional in a region you never meant to touch. The setting still parses and still flows into the render data, but no branch consumes it, so it renders as nothing and fails silently. This is the bug that made the delegation settings (`taskIrcEnabled`, `eagerTasksAlways`) useless during earlier experiments.

The `.sections.yml` mechanism makes that bug unreachable. The default template is one file, `packages/coding-agent/src/prompts/system/system-prompt.md`, and `system-prompt-builder/default-template.ts` exposes it as named sections:

```ts
import { assembleDefaultTemplate } from "../system-prompt-builder/default-template";

// Swap only the tool-policy region. Every other section, and every
// conditional inside it, stays byte-for-byte identical to the shipped default.
const candidate = assembleDefaultTemplate({
  toolPolicy: myToolPolicyVariant,
});
```

The sections are `conventions`, `role`, `runtime`, `toolPolicy`, `executionWorkflow`, and `deliveryContract`, split at the template's own banner lines (`ROLE\n====`, `TOOL POLICY\n====`, and so on). `assembleDefaultTemplate()` with no overrides returns the shipped template exactly. An override replaces only the section you name. Because you never retype the other sections, you cannot drop a conditional in them.

The override is EVAL-ONLY and uncontaminatable by design. It is not a config key and not a CLI flag: `vey` reads it only from `VEYYON_EVAL_SYSTEM_PROMPT_SECTIONS`, which the bench sets around one arm and nothing else sets. No `config.yml` — on your machine or in production — can reach the path, so a section experiment can never leak into a normal run. When the variable is set, `vey` logs a loud warning that the prompt is not the production one; a malformed payload, an unknown section, a non-string value, or a banner-less replacement fails loudly instead of silently reverting to the production prompt.

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
  --model google-antigravity/gemini-3.6-flash \
  --jobs 2 \
  --repeats 3 \
  --out runs/prompt-tuning-01
```

### Command Flags:
- `--arms <a,b>`: Comma-separated list of arms to evaluate (e.g. `baseline,candidate-argot-nudge`).
- `--tasks <file>`: Task list (e.g. `tasks/smoke.txt` for 1 task, `tasks/pilot-10.txt` for 10 pilot tasks, `tasks/argot-10.txt`, or omit for full 113 DeepSWE tasks).
- `--model <id>`: Provider & model under test (default: `google-antigravity/gemini-3.6-flash`).
- `--jobs N`: Number of parallel task containers (default: `2`).
- `--repeats K`: Samples per (arm, task) cell (default `1`). LLM agents are stochastic; a single sample cannot tell a real arm effect from noise. With `K > 1` the report shows each cell's pass RATE with a binomial standard error (shrinks as `1/sqrt(K)`). Raise `K` when the expected delta is small, and do not read a delta smaller than a couple of standard errors as real.
- `--out <dir>`: Directory where results and verbatim traces are stored.

### Two guards the runner enforces before it runs
1. **Zero-IV collision:** two arms that stage byte-identical `(config, sections, rule)` inputs fail loudly — a comparison of identical arms varies nothing, so its delta is noise.
2. **Treatment-not-applied:** an arm that enables argot encoding with a non-empty `argot.models` allowlist that excludes the `--model` under test fails loudly. argot only encodes for an allowlisted model, so such an arm would SILENTLY become decode-only while labelled "encode". The guard uses argot's own `modelAllowed` predicate so it cannot drift from the runtime gate. A deliberately decode-only arm (empty allowlist, like `decode.yml`) is allowed.

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

## 5. Evaluation Criteria (What Counts as a Win)

1. **Correctness / Verifier Reward (PRIMARY):** Candidate must match or exceed baseline score on held-out verifier tests. Lower correctness is UNACCEPTABLE.
2. **No Reward Hacking:** Edits must be genuine, production-grade implementations. No stubs, simplified fallbacks (`"for now"`), or skipped test cases.
3. **Efficiency:** Reduced output token bloat, lower wall time, and streamlined tool call distribution are secondary wins when correctness is preserved.

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

---
name: evals
description: Standing maintainer workflow for running, tuning, and evaluating Veyyon system prompt variations, flags, and feature overlays using isolated DeepSWE benchmarks with zero profile impact.
---

# Veyyon Evals & Prompt Tuning Workflow

This skill defines the mandatory workflow for conducting evaluations, prompt tuning, and A/B benchmark experiments in Veyyon.

## BINDING PRINCIPLE: No Prompt Changes Without Evals
**System prompts, tool policies, or agent rules MUST NOT be modified in production without baseline vs. candidate benchmark evaluations.** The primary objective of prompt tuning is **HIGHER correctness (verifier score)** without reward hacking, while optimizing token cost and wall time.

---

## 1. Zero-Impact & Ephemeral Isolation Guarantee
- Evaluation runs execute inside isolated Docker containers via Pier (`datacurve-pier`).
- Credentials are read-only seeded copies (`assets/auth-agent.db`).
- **ZERO side effects on host user profiles (`work`, `default`, etc.):** session history, active profile settings, and memories are never modified or touched.

---

## 2. Setting Up an Arm (Prompt & Flag Overlay)

An **arm** is one Veyyon experiment configuration under `packages/deepswe-bench/arms/`.

To test a system prompt candidate:
1. Create `arms/<arm_name>.yml`:
   ```yaml
   # Arm flag overlay configuration
   argot:
     enabled: false
   ```
2. Create `arms/<arm_name>.prompt.md`:
   - Paste your candidate system prompt template.
   - The runner (`run.ts`) automatically stages the prompt into the container and passes `--system-prompt` to `vey`.

---

## 3. Running an A/B Benchmark Evaluation

Navigate to `packages/deepswe-bench` and run:

```bash
cd packages/deepswe-bench

# Run baseline vs candidate arm comparison
bun run.ts \
  --arms baseline,candidate-v2 \
  --tasks tasks/pilot-10.txt \
  --model google-antigravity/gemini-2.5-flash \
  --jobs 2 \
  --out runs/prompt-tuning-01
```

### Command Flags:
- `--arms <a,b>`: Comma-separated list of arms to evaluate (e.g. `baseline,candidate-v2`).
- `--tasks <file>`: Task list (e.g. `tasks/smoke.txt` for 1 task, `tasks/pilot-10.txt` for 10 pilot tasks, `tasks/argot-10.txt`, or omit for full 113 DeepSWE tasks).
- `--model <id>`: Provider & model under test (e.g. `google-antigravity/gemini-2.5-flash`, `anthropic/claude-3-7-sonnet`, `openai/gpt-4o`).
- `--jobs N`: Number of parallel task containers (default: `2`).
- `--out <dir>`: Directory where results and verbatim traces are stored.

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

## 6. High-Throughput Feature & Prompt Eval Architecture

To test prompts, config flags, and new features without burning expensive model usage or hitting rate limits:

### 3-Tier Eval Pyramid
1. **Tier 1 (Fast Local Screening):** Run `smoke.txt` (1 task) or `pilot-10.txt` on fast, low-cost models (`google-antigravity/gemini-2.5-flash` or `gemini-3.6-flash`). Runs in 1–3 minutes and filters out prompt regressions.
2. **Tier 2 (Diverse Feature Matrix):** Run `diverse-20.txt` across 20 multi-repository tasks spanning Go, TypeScript, and Python to verify cross-language stability and token efficiency.
3. **Tier 3 (Final Validation):** Run top-performing candidate arms on flagship models (`google-antigravity/claude-opus-4-6` or `claude-3-7-sonnet`) for final landing approval.

---

## 7. Prompt Cache Stability Law & 3 CWD Mutation Vectors
- **Prefix Caching Rule:** LLM APIs hash the system prompt + conversation prefix starting from line 1.
- **The 3 CWD Mutation Vectors:** Working directory changes occur via:
  1. *Profile Defaults (`session.workdir` setting)*: Updating it mid-session updates future session defaults without mutating live prompt headers.
  2. *Agent Tool (`set_cwd`)*: Re-roots live session scope for path resolving (`[name#tag]`); prompt header metadata remains frozen until context compaction.
  3. *User Commands (`/cd`, `/move`)*: Changes interactive execution scope without invalidating system prompt prefix hashes.
- **Zero Mid-Session Prompt Mutation:** Never mutate system prompt templates or workstation metadata (`<workstation>`, `cwd`, active profile labels) mid-session before context compaction.
- **Cache Invalidation Penalty:** Modifying `cwd` or workstation stats mid-session invalidates the prefix cache for all subsequent turns, triggering 100% cache-miss token inflation.
- **Safe Mutation Seams:** Workstation/profile updates belong strictly at or after context compaction, when history is re-primed and the prompt cache is naturally reset.

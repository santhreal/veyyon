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
- **Prompt Statement Benchmark:** Same model, same feature flags; ONLY one RULE of the system prompt differs. The prompt is assembled from named statements, one per rule, so `arms/<arm>.statements.yml` removes or rewords exactly one of them (`<statement id>: null` ablates it; a string replaces its text). Its control is the same config with no statements file. This is the vehicle for asking whether a rule earns its tokens, which a section override cannot answer: TOOL POLICY is one banner region and 34 rules, so a delta across a rewritten section has no single cause. The override reaches the agent only through the eval-only `VEYYON_EVAL_SYSTEM_PROMPT_STATEMENTS` env var, never a config key. See "Prompt statement arms" below.
- **Feature Flag Benchmark:** Same model, same prompt; ONLY the setting flag differs (e.g. `argot.enabled: false` vs `argot.enabled: true`).
- **Model Benchmark:** Same prompt, same feature flags; ONLY the `--model <id>` differs.

**NEVER vary multiple factors in a single arm comparison.** If an arm alters the prompt AND the model AND a setting simultaneously, the benchmark is invalid because observed deltas cannot be attributed to a single cause.

**NEVER replace the whole system prompt to test a prompt change.** A `--system-prompt` snapshot freezes a point-in-time copy that no longer responds to settings. It also silently drops every settings-gated section it forgets to copy. For example, the delegation block renders only when delegation is enabled, so a hand-compressed snapshot that omits it inverts that setting invisibly. That is two hidden variables, not one. Override one named section instead; the engine renders all the others.

The runner enforces five mechanical floors of this rule:

1. **Zero-IV collision.** If any two arms in a run stage byte-identical inputs (same `.yml`, same/no section override, same/no statement override, same/no rule), it fails loudly with the colliding arm names. A comparison between identical arms varies zero variables, so its "delta" is pure noise — the exact defect behind earlier `candidate-vN` arms that were copied from `baseline` with nothing changed.
2. **Treatment-not-applied (pre-run).** If an arm turns argot encoding on with a non-empty `argot.models` allowlist that does not include the `--model` under test, it fails loudly before running. argot only encodes for a model on its allowlist, so such an arm would SILENTLY degrade to decode-only while still being labelled the encode condition — a silent fallback living inside the eval set. The check uses argot's own `modelAllowed` predicate (exported from the SDK), so it can never drift from the gate the runtime actually applies. A deliberately decode-only arm (`enabled: true`, empty allowlist, as in `arms/decode.yml`) is fine and passes.
3. **Treatment-not-applied (post-run, authoritative).** The pre-run check matches the model string you *requested*, but the runtime resolves that id through the catalog (provider aliases, effort-tier collapsing) to a different logical id before the encode gate sees it. This really happened: `google-antigravity/gemini-3.6-flash` was aliased onto logical `gemini-3.5-flash`, so the request passed the pre-run check (3.6 was on the list) yet failed the gate (the resolved 3.5 was not) and the arm ran decode-only. After the run, the bench reads whether the encode preamble actually reached the model (from each session's system prompt) and **fails closed** if an encode arm never taught it in any OK trial. The alias has since been removed from the catalog, so 3.6 resolves to 3.6 or fails loudly. The default `--model` and every encode arm's allowlist name **`gemini-3.5-flash`**. That is a choice of a model with a known-good recent run, NOT a claim that any other id is unservable: a `Model "<id>" not found` is usually an auth failure wearing a model id's name (see that section below), so check for a registry-error line and re-seed the auth DB before you suspect the id. The rule still stands whatever the model: requested and resolved must agree, or the run is inert. Watch the `preamble taught` column in the report (below).
4. **The arm names a setting that does not exist.** An arm is a config overlay, so a key veyyon does not recognise raises nothing: it merges, it is never read, and the arm runs as the control under a treatment's name. The report then compares the control against a second copy of the control, which is the most expensive way to be wrong because it reads as a real measurement. Every key in every arm is checked against the settings schema before the run starts, and an unknown one fails loudly with the path to fix. This catches a typo (`tools.discoverymode`) and, later, a setting that upstream renamed while `arms/` kept the old spelling. Both YAML spellings are accepted, nested and flat, and a record-valued setting such as `tools.approval` keeps its arbitrary keys.
5. **The arm gives a real setting an unusable value.** Naming a real key is only half of it. `tools.discoveryMode: yes` passes the key check, and then YAML reads the bare word as the boolean `true` while the schema wants one of four strings, so the value is merged and ignored and the arm runs as the control again. Every value is checked against its setting's declared type before the run starts. YAML is what makes this easy rather than exotic: bare `yes`/`no`/`on`/`off` are booleans, `.inf` and `.nan` are numbers, and a quoted `"0.1"` is a string that reads identically to a real one in a diff.

## Canonical single-IV comparisons

These are the sound pairings the shipped arms are built for. Each varies exactly one thing, so a delta is attributable:

| Comparison | Arms | The one variable |
|---|---|---|
| Feature flag | `baseline` ↔ `argot-setting-only` | `argot.enabled` false → true, nothing else |
| The nudge rule | `argot-setting-only` ↔ `candidate-argot-nudge` | adds `arms/candidate-argot-nudge.rule.md` (an always-apply rule), same config |
| Teaching (encode) | `decode` ↔ `full` | the model is allowlisted to encode and taught the preamble; codec/loadability held equal |
| Dictionary budget | `full` ↔ `full-budget16k` | `argot.tokenBudget` alone, 1000 → 16000 |
| Tool discovery | `baseline` ↔ `discovery-all` | `tools.discoveryMode` alone, so non-essential tool docs leave the prompt |
| Early-output spill | `spill-control` ↔ `baseline` ↔ `spill-tight` | `tools.inlineOutputFloor` alone, 1 → 0.25 → 0.1 |
| Signature size limit | `baseline` ↔ `sig-max4000` | `context.thoughtSignatureMaxLength` alone, none → 4000 |
| Artifact spill threshold | `baseline` ↔ `spill2kb` | `tools.artifactSpillThreshold` alone, 50 KB → 2 KB. Since 2026-07-26 it reaches the streaming tools too (bash, eval, ssh, interactive shell), which took a compiled 50 KB before; results recorded earlier understate it |
| Signature recency | `baseline` ↔ `sig-last8` ↔ `sig-last1` | `context.thoughtSignatureRetention` alone, all → 8 → 1 |
| Thinking replay | `baseline` ↔ `think-last1` | `context.thinkingRetention` alone, all → 1 |
| Model | any single arm, two `--model` values | only `--model` differs |

Do not compare across two of these at once (e.g. `baseline` ↔ `full` mixes the feature flag AND teaching). Pick the pair whose single variable is the effect you want to measure.

The last four rows are the context-size levers. Measure the prefix first (see "Where
the money goes" below), then run them one at a time, because a combined arm
produces a delta attributable to nothing.

Run them in this order, which is by expected saving per unit of risk rather than by
saving alone:

1. `sig-max4000`. Predicted 22.8% of the bill, and only about 15% of signatures
   lose their content. Signature sizes are lopsided enough that a length cap
   sheds most of the weight while leaving most of the reasoning chain intact.
2. `sig-last1`. Predicted 30.5% net, the largest single lever, but it drops every
   historical signature rather than the large ones (99% of them, against the cap's
   15%). Worth running second so its result can be read against the gentler cap: if
   both hold reward, take the larger saving; if only the cap holds, the difference
   tells you replaying older reasoning matters.
3. `think-last1`. Predicted 7.0% net (7.6% gross, 0.6% handed back as cache
   misses), by dropping 99% of thinking blocks. Cannot reach the target alone, and
   is worth measuring for what it says about whether the model needs its own
   thought summaries replayed. Nothing replaces an elided thinking part, so unlike
   a signature there is no sentinel to subtract.
4. `spill2kb`. Predicted 26.1% of the Claude bill and 9.2% of the Gemini one, by
   spilling 23% of all tool results. The shipped 50 KB threshold predicts 0.5%:
   see "A category total is not a lever's reach" below for why the tool-result
   category being 26.3% of the prefix does not make the lever worth 26.3%.

`sig-last8` is not on this list. A deeper retention window saves LESS gross than a
shallow one and hands back MORE as cache misses, so it nets 22.0% while discarding
93% of signatures, which the size cap matches at 15%. The whole retention family
gets worse in both directions as it gets safer, and the thinking windows behave the
same way: 7.0% net at K=1, 3.1% at K=8. There is no conservative-and-cheap point on
a recency curve.

`tools.inlineOutputFloor` is the one prefix setting with no simulator left. An arm
that sets it gets a printed refusal rather than a number.

You do not type any of these numbers to check a run. After the run writes its
report it prints each treatment arm's predicted saving beside the measured one,
deriving the prediction from that arm's own staged settings against the baseline
transcripts of the same run. The gap between them is what tells you whether the
simulator can be trusted for the next lever without buying the answer.

It prints the treatment arm's prefix composition against the baseline's first, so a
gap can be attributed. A category that did not shrink is a wiring problem: the
setting never took effect. A category that shrank as predicted while the bill did
not move is a pricing problem: the simulation is charging for bytes the provider
was not charging for. Those need opposite responses, and the two numbers together
tell you which one you have.

Three of its outputs are refusals rather than measurements, and none of them is a
result:

- `NO PREDICTION` or `PARTIAL PREDICTION` means the arm sets a lever with no
  simulator, so any total shown covers only part of the treatment.
- `no paired trials with usage` means the treatment arm billed nothing. That is
  what a quota kill looks like, and it is not a 100% saving.
- `sessions carry almost no conversation` means the arm's trials died before doing
  work. Its composition would otherwise read as a lever that removed every category
  at once, which is the most impressive table this report can print and describes an
  arm that never ran.

Tool-call arguments have no arm. They are nine tenths `eval.code`, which is code
the model wrote, and cannot shrink without changing what it writes.

## Why the default dictionary budget cannot measure argot

At `argot.tokenBudget: 1000`, the default, argot's output-token claim is not
testable on DeepSWE tasks. This is a property of the workload, not a null result,
and reporting it as "the feature does not help" would be wrong. Measured on the
ytt task repository:

| budget | handles | agent-typeable mass | **projected** ceiling |
|---|---|---|---|
| 1000 | 44 | 652 ch | 1.01% |
| 4000 | 139 | 1,654 ch | 2.56% |
| 16000 | 529 | 12,322 ch | 19.07% |

Run-to-run output-token noise on the same task and arm is about 8.15%, so at the
default budget the best possible outcome sits nearly an order of magnitude below
the noise. Repeats cannot fix that, because the effect being sought is smaller
than the effect that already exists.

> **That table is a projection, and the first run to test it came back about
> fifty times lower.** `runs/argot-smoke-0724` (2026-07-24) ran the 16000 budget
> on the same ytt task, loaded 551 handles, and measured a ceiling of **0.24%**
> (0.38% for its decode control), verdict `CANNOT MEASURE` for both arms. The
> error is in "agent-typeable mass", which counts every handle an agent COULD
> type; that run emitted 8 of 551. The real ceiling depends on which handles a
> task makes the agent RETYPE, so raising the budget inflates the projection much
> faster than it moves the truth. Until the projection is re-derived from
> observed emission rates, do not size a run on this table and do not read a
> token delta from `full ↔ full-budget16k`. Measure argot by `runs that encoded`
> instead. Tracked as `ARGOT-HEADROOM-PROJECTION-OFF-BY-50X`.

`full ↔ full-budget16k` was built to test the claim where it is projected to be
measurable. Read both token rows when you do. A larger dictionary rides in the prompt every turn, so it buys
shorter output by spending input. The efficiency comparison scores `input tok`
alongside `output tok` for this reason. A win means output fell by more than the
prompt grew, not merely that output fell.

Whether that trade is a win in DOLLARS depends on the input and output prices,
and the bench's sandbox model does not supply them: the served subscription-tier
model (google-antigravity flash) reports `usage.cost.total: 0` on every message
while burning thousands of tokens, so its cost is `unpriced`, not free (see
[Cost is often unpriced](#cost-is-often-unpriced)). Read the trade from the token
columns directly; to weigh it at prices, supply reference per-token prices for the
model.

## Cost is often unpriced

The bench runs the model the sandbox can serve, and that model is a
subscription-tier one (google-antigravity flash). Such providers charge a flat
subscription, not per token, so they report `usage.cost.total: 0` on every
message even while the model burns thousands of tokens. That 0 means "never
priced", not "free".

The report never launders that into a dollar figure. When an arm's provider
reported no price while tokens flowed, its **cost USD** cell reads `unpriced`
(and its per-task mean cost reads `—`), the report prints a one-line note saying
why, and the efficiency comparison marks the cost metric `not measured`. Showing
`$0.000` there would be a fabricated price, and a cost verdict computed from it
would be meaningless.

To read the input-for-output trade without a price, compare the **input tok** and
**output tok** columns directly: a feature wins on tokens when output falls by
more than input rises. To adjudicate the trade in dollars, you must supply
reference per-token prices for the model, because the provider does not. A run
against a genuinely per-token-priced model (one whose `usage.cost.total` is
nonzero) shows real dollars and needs none of this.

## Where the money goes: measuring the prompt prefix

Before you build a lever, measure what the bill is actually spent on. Run:

```bash
bun prefix-composition.ts runs/<run-id>/jobs           # defaults to the baseline arm
bun prefix-composition.ts runs/<run-id>/jobs sig-last1__
```

It reads every session transcript under that arm and prints two things: what the
prompt prefix is made of, and an upper bound on what eliding each part would
save.

The prefix is measured in **character-turns**, not bytes. One character sitting in
the prompt for one billed turn is one character-turn. This matters because the
provider re-reads the whole prefix on every turn, so a 50KB tool result produced
on the last turn is read once, while the same 50KB produced on turn three is read
on every turn after it. A flat byte census cannot see that difference and points
optimization effort at the wrong thing.

On the twenty-task baseline run of 2026-07-25, that decomposition is:

| part of the prefix | share |
|---|---|
| thought signatures | 37.5% |
| tool results | 26.3% |
| system prompt and tool schemas | 17.4% |
| thinking | 9.0% |
| tool-call arguments | 8.3% |
| assistant text | 0.9% |
| user text | 0.6% |

The single largest thing in the context is an opaque provider blob, not anything
the model wrote for itself.

### Prefix share is not bill share

A part's share of the prefix is not what removing it saves. Only the prompt-priced
lines shrink when the prefix shrinks: output tokens are generated, not re-read, so
no amount of context elision touches them. On the same run, 23.7M fresh input
tokens and 265.5M cache reads against 1.83M output tokens price as 85.5% prompt
and 14.5% output, so a lever that removes the entire signature category buys

    37.5% x 85.5% = 32.0% of the bill

not 37.5%. Quoting the unscaled number overstates every lever by about a sixth,
which is the difference between clearing a 20% target and only appearing to.

### Why you can trust a character census of a token bill

Everything above counts characters in a session transcript, while the provider
bills tokens on a prompt the transcript does not fully record: tool schemas go
over the wire as a structured array and the log stores only tool names. If that
hidden mass were large, every share would be inflated and every predicted saving
overstated.

So the tool measures it. It fits what the provider charged against what the
transcript shows, across every billed turn, and prints both numbers:

```
calibration against billed tokens: 3.88 chars/token, 5,888 chars of prefix not in
the transcript (1.2% of the total above)
```

Read the rate first. A figure in the normal band for prose and code, roughly 3.5
to 4.5, means the census is capturing the prompt. A much lower figure means real
prefix mass is missing from the fit and the shares above are inflated. Then read
the unseen block: at about 6,000 characters it adds 1.3% to the prefix total and
moves the signature lever's prediction from 22.7% to 22.5% of the bill, which is
small enough to ignore and now measured rather than hoped for.

### The one lever that removes nothing

Every other measurement here sizes something you would take OUT of the context,
and taking context out risks the model's behaviour. One line does not:

```
prompt cache, the lever that removes nothing from the context:
  hit rate            91.8%
  billed fresh        23,667,983 tokens, of which 19,723,233 was content already sent
  paying the fresh rate on re-reads costs 14.0% of the bill, for nothing
```

The same bytes reach the model either way. Only the rate they are billed at
changes, so a saving here cannot cost reward, which makes it the cheapest win
available. Read it before any lever that trades context for money.

On the twenty-session baseline the median turn is charged 6.5 times more uncached
input than the content it actually added, and 83% of all fresh-input tokens are
re-reads. The estimate is conservative in the direction that matters: a turn that
genuinely added a large tool result is credited for it in full, and only the
excess counts as waste, so a workload that simply produces a lot of output cannot
inflate the number.

Two explanations are ruled out by the same data. It is not idle-time cache expiry:
gaps before a missing turn were no longer than before a hit, 1.5 against 2.1
seconds at the median. It is not a changing system prompt: every session has one
`session_init` with one prompt. The cause is still open, so treat the figure as a
measured cost rather than a fix that exists.

### A category total is not a lever's reach

Tool results are 26.3% of the prefix, which reads like a lever worth 22.5% of the
bill. A size cap cannot get near that, because the mass is spread across many
mid-sized results rather than concentrated in a few giants. The tool simulates the
cap directly and prints what it would actually remove:

| inline cap | share of prefix | share of bill | tool results spilled |
|---|---|---|---|
| 50,000 chars (the shipped default) | 0.6% | 0.5% | 0% |
| 20,000 | 2.4% | 2.1% | 1% |
| 10,000 | 3.9% | 3.3% | 2% |
| 5,000 | 5.7% | 4.9% | 5% |
| 2,000 | 10.8% | 9.2% | 17% |
| 1,000 | 14.6% | 12.5% | 29% |

Even a 1,000-character cap, tight enough to spill most `eval` output, reaches 12.5%
of the bill. Deciding to build a spill lever from the 26.3% category total alone
would have spent the effort and landed at a twentieth of the expected saving at
the shipped threshold. Always simulate the specific lever, never quote its
category.

Simulate the lever the code actually implements, too. `read` is exempt from
artifact spill on purpose: it is bounded by lines rather than bytes, so a byte
spill would hand back fewer lines than you asked for and break the tool's one
contract. An earlier version of this simulation capped `read` output along with
everything else, which put a 5 KB threshold at 24.9% of the Claude bill when the
shipped lever really reaches 13.5%. An arm was sized on that number before the
error was caught. `simulateToolResultCap` now takes the exempt set as a parameter
and defaults it to what the code exempts.

The numbers also differ sharply by provider, so quote them with the model attached.
Tool results are 26.3% of the Gemini prefix and 74.0% of the Claude prefix:

| spill threshold | share of bill (gemini) | share of bill (claude) | results spilled (claude) |
|---|---|---|---|
| 50 KB (shipped) | 0.5% | 0.0% | 0% |
| 10 KB | 3.3% | 8.5% | 3% |
| 5 KB | 4.9% | 13.5% | 6% |
| 2 KB | 9.2% | 26.1% | 23% |
| 1 KB | 12.5% | 33.9% | 35% |

The last column is the risk half of the trade and belongs beside the saving. A
threshold that spills a quarter of all tool results is asking the model to spend a
turn recovering content it already asked for, and that is a different kind of
exposure from a signature cap, which touches state the model never reads back.

Both simulations already subtract what the substitution costs, so these are not
naive byte counts. A capped signature is replaced by Gemini's 33-character
`skip_thought_signature_validator`; a spilled result is replaced by a
`[…NNNln elided…]` marker and a `[raw output: artifact://<id>]` footer, about 45
characters, measured from the shipped functions rather than assumed. Read the
printed numbers as **upper bounds** all the same: a lever may cost extra turns if
the model has to recover what was removed. None of it says the model still solves the task. Only the paired
reward comparison answers that, and it is the gate: a cheaper arm that loses
reward is not a win.

### What a signature length cap reaches

Thought signatures are 37.5% of the Gemini prefix, and their sizes are extremely
lopsided: 2,297 signatures averaged 2,606 characters against a median of 660, with
a maximum of 91,960, and the largest tenth held 62.1% of all signature bytes. So a
length cap removes most of the mass while leaving the great majority of tool calls
untouched, which a recency window cannot do:

| cap | share of prefix | share of bill | tool calls that lose their signature |
|---|---|---|---|
| 8,000 chars | 20.9% | 17.9% | 8% |
| 4,000 | 26.6% | 22.8% | 15% |
| 2,000 | 30.4% | 26.0% | 24% |
| 1,000 | 33.1% | 28.3% | 38% |

Savings are turn-weighted and already net of the 33-character
`skip_thought_signature_validator` sentinel that replaces each dropped signature.
Counting the full length instead would overstate the lever by 33 characters per
signature per turn.

Compare the last column against a one-message recency window, which reaches 32% of
the bill by dropping 100% of historical signatures. The cap reaches 22.8% by
touching 15% of tool calls, so if replaying older reasoning matters at all, the cap
degrades gently where the window does not.

### A lever that rewrites history hands its saving back

Every number above assumes the elided bytes simply stop being sent. That is true
only if the rest of the prefix still renders byte-identically to the previous turn.
A prefix cache matches a leading run of bytes, so one rewritten character in the
middle of the history costs you everything after it at the fresh rate, which is
four times the cached rate here. A lever can remove a fifth of the prefix and still
lose money.

Two levers that sound similar differ exactly on this point:

- A **size cap** asks whether one signature is longer than the cap. A signature's
  length never changes, so the answer is fixed for the whole session and the prefix
  stays byte-stable.
- A **recency window** asks whether a signature is among the last few assistant
  messages. That boundary moves forward every turn, so a signature you keep now is
  history next turn and gets replaced by the sentinel, rewriting bytes you already
  sent.

The tool measures this and prints it per lever:

| lever | turns keeping the prefix intact | tail invalidated | what that costs |
|---|---|---|---|
| stock | 100.0% | 0.0% | 0.0% of bill |
| sig-max4000 | 100.0% | 0.0% | 0.0% of bill |
| sig-last1 | 1.9% | 1.1% of prefix | 0.7% of bill |
| sig-last5 | 5.4% | 5.9% of prefix | 3.8% of bill |

Note what the measurement charges for. A rewrite costs the whole tail behind it,
not the bytes that changed. `sig-last1` rewrites something on 98% of turns, which
sounds fatal, but the rewrite lands right at the conversation tail so only 1.1% of
the prefix sits behind it. Counting only the changed bytes would understate a
genuinely bad lever by more than twentyfold, so the figure to read is the
invalidated tail.

Check any new context lever here before spending quota on it. One that rewrites
deep into history is disqualified on arithmetic alone.

## Prerequisites (once per machine)

0. Clone the tasks into this package: `git clone --depth 1
   https://github.com/datacurve-ai/deep-swe` (the runner defaults to
   `deep-swe/tasks` here; `--tasks-root` overrides).
1. `uv tool install datacurve-pier` (>= 0.3.0) and Docker running.
3. Binary build and auth DB seeding are fully automated by `run.ts`:
   - `run.ts` automatically detects if `dist/vey` is out-of-date and recompiles it.
   - `run.ts` automatically seeds `assets/auth-agent.db` from your host login. It
     re-seeds when your live store is newer, so a rotated token reaches the
     containers, and also when the staged copy no longer opens as a database, so
     one bad write cannot wedge every later run.
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
  run every task under the tasks root (full DeepSWE, 113 tasks). Declare the set's
  provenance in the header so a biased subset is never read as a headline: a first
  comment line `# @headline` marks an unbiased, representative set whose numbers can
  be reported as a headline, and `# @biased: <reason>` marks a set curated to favour
  the feature under test (for example `tasks/argot-10.txt`, the repos with the most
  compressible token mass), which yields a best-case upper bound only. The report
  prints a loud banner from this directive, and an unmarked list is flagged so it
  gets one. A headline argot number comes from `tasks/diverse-20.txt` (`@headline`);
  `argot-10` validates the codec delivers where it should, it is not the headline.
  Choosing an argot task set is a measurement, not a guess. `bun gen-dicts.ts
  --all` writes `dicts/report.md` ranked by `typeable saving`: the characters
  saved per emission across handles whose expansion contains no whitespace. That
  filter is calibrated, not assumed. On the one run where encoding fired, every
  handle the model emitted was whitespace-free and no prose handle ever was, so
  the column never misses a string the model would have written. A task with
  near-zero typeable saving cannot demonstrate the codec whatever the model does,
  and 67 of the 110 scannable tasks score under 200 characters. Ranking on the
  SDK's raw `estimatedSavings` instead selects almost entirely different tasks:
  only 2 of the top 10 agree.
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
- `--dry-run` — run every pre-run guard, then stop before the first container.
  **Use this before any real run.** It parses and validates each arm, stages the
  sections file, pins temperature, computes the arm fingerprints and checks them
  for a zero-IV collision, matches every encode arm's allowlist against
  `--model`, confirms the task files and the agent binary exist, and performs the
  auth preflight against the staged DB. Then it prints the queue, each arm's
  resolved inputs, the task set's `@headline`/`@biased` provenance, and how many
  trials of real quota the run would cost, and exits 0 writing no report.

  It answers every question that does not need the model itself, in seconds
  rather than the hours a real run takes: one DeepSWE task can occupy a container
  for 90 minutes, so discovering a one-line YAML typo after the fact is the single
  most expensive mistake available here.

  ```bash
  bun run.ts --arms decode-budget16k,full-budget16k --tasks tasks/argot-10.txt \
    --model google-antigravity/gemini-3.5-flash --jobs 2 --dry-run
  ```
- `--trial-timeout S` — wall-clock ceiling for a single trial, in seconds. There
  is no flat default. Each task gets the budget its own `task.toml` declares:
  `[environment].build_timeout_sec` plus `[agent].timeout_sec` plus
  `[verifier].timeout_sec`, because the harness runs one timer across all three
  phases. On the DeepSWE corpus that comes out at 1800 + 5400 + 1800 = 9000s for
  a 90-minute task and correspondingly less for a 30-minute one.

  Pass the flag only when you deliberately want a shorter run, and read the
  result knowing what you gave up. A flat ceiling below a task's budget does not
  make the task shorter, it truncates it, and the truncation is not neutral
  between arms: any arm that is slower per turn eats more truncations, so a flat
  timeout converts "this arm spends more wall clock per turn" into "this arm
  solves fewer tasks". When the flag truncates any selected task, the run says so
  before it starts. Trials the harness kills are reported separately from agent
  failures (`n (+E err, T timed out)`), and a reward or efficiency delta between
  two arms whose timeout counts differ is not attributable to the arms.
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

A run directory (default `packages/deepswe-bench/runs/<timestamp>/`, or `--out`) collects `jobs/` (raw Pier output, trajectories,
verifier reports), `results.json` (every metric, machine-readable), and
`report.md` (the table).

## Pooling several days into one comparison

A paired sign test cannot reach significance below six decisive tasks, and one day
of provider quota funds roughly fifteen tasks across two arms. So a reward
comparison strong enough to detect a regression usually does not fit in a single
day. Accumulate it instead:

```bash
bun run.ts --merge runs/2026-07-25T19-51-41-474Z,runs/2026-07-26T08-11-02-330Z \
  --out runs/pooled-sig-max4000
```

That writes `merged-report.md` and `merged-results.json` into `--out` (or into the
last run directory if you omit it). Each input directory needs a `results.json`;
run `--reaggregate` on it first if the run died before writing one.

Pooling across days is sound here only because every run carries **both** arms, so
each task's pair is measured under the same provider conditions, the same binary
and the same hour. Day-to-day variation shifts both arms of a pair together and a
paired test differences it away.

The merge refuses anything that breaks that argument, rather than warning about it:

- **Runs with different arms.** Pooling a baseline-only run with a treatment-only
  run puts the whole day effect on one arm, where it cannot be told apart from the
  treatment. This is the tempting thing to do when a run dies on quota partway
  through, and it is the one that fabricates a result rather than degrading one.
- **Different models.** Two providers averaged into one number describe neither.
- **Different binaries.** The delta would include whatever else changed in the
  build, so the arm gets credit for an unrelated commit.

  This is the refusal you will actually hit, and it needs planning rather than
  luck. The runner rebuilds `vey` whenever any file under `packages/coding-agent/src`
  is newer than the binary, and in a tree several people are working in that is
  every day: three runs on 2026-07-25 staged three different binaries. Pin the
  binary on every run after the first, pointing at the first run's staged copy:

  ```bash
  bun run.ts --arms baseline,sig-max4000 --model <model> --limit 15 \
    --binary runs/2026-07-25T19-51-41-474Z/assets/vey
  ```

  `--binary` skips the rebuild entirely and stages those exact bytes, so the
  recorded sha matches and the days pool. It is also the way to run when the
  working tree does not compile, which in a shared tree happens often enough to
  plan for.

  Pinning has one hazard and one guard. The pre-run settings check validates each
  arm against the CURRENT schema, not against the pinned binary's, so a binary old
  enough to predate a setting merges that key, never reads it, and runs the arm as
  the control under a treatment's name. No pre-run guard can see that. The post-run
  composition block does: if the lever did not fire, its category does not shrink
  between baseline and treatment. On a pinned run, read that block before the cost
  delta, and prefer the most recent known-good binary rather than the oldest. It announces itself loudly, because the
  run then measures that binary's code and not the working tree's. That is the
  trade: you give up testing today's code to buy a comparison with enough decisive
  tasks to mean anything. Every run stages its binary at `<runDir>/assets/vey`, so
  the first run of a comparison is the pin for all the rest and no separate
  artifact has to be kept anywhere.
- **An arm whose config changed between runs.** Every row still carries the same
  arm name, the report renders cleanly, and the number is the average of two
  different treatments. Nothing downstream can catch this, so it is caught here.

A missing arm fingerprint is not treated as a mismatch, so runs predating that
field still pool.

Plan for the binary before you start. The runner records the `vey` binary's sha,
and any change under `packages/coding-agent/src` rebuilds it, so a day
of ordinary development between two runs is enough to make them unmergeable. Land
the code you want measured, gather every day you need, and resume editing after.
Changes confined to `packages/deepswe-bench` do not rebuild the binary.

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
- **cost USD** — from veyyon's own pricing accounting, or `unpriced` when the
  provider reported no price (see [Cost is often unpriced](#cost-is-often-unpriced)).
  A subscription-tier model's cost reads `unpriced`, never `$0.000`.
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
  A run with k arms tests k(k-1)/2 pairs, so judging each raw p at 0.05 would
  manufacture a false winner as the arm count grows (about a 40% chance of at least
  one at 10 pairs). The **adj p (Holm)** column is the Holm–Bonferroni-corrected
  p-value across all decisive pairs in the run, and a winner is named only at
  **adj p < 0.05** — which holds the family-wise false-positive rate at 5% no matter
  how many arms you compare. With a single pair (two arms) the correction is a no-op.
  A non-significant row reads **not distinguishable (underpowered)** when the run had
  too few decisive tasks for *any* outcome to reach significance — a clean sweep at
  that task count would still miss the Holm-adjusted bar (with one pair the floor is
  6 decisive tasks, since a 5-0 sweep is only p=0.0625; two pairs raise it to 7). That
  qualifier means "add tasks", not "the arms are equal"; a plain **not distinguishable**
  is a real measured null the run was powered to detect.
- **Reward comparison — continuous partial credit (paired by task)** — the
  pass-rate table binarizes at reward=1 (the SWE-bench "resolved" definition), so
  it cannot see a partial-credit regression: the DeepSWE verifier returns a
  fractional reward, and an arm can lower the mean reward on hard tasks (0.8 to
  0.4) without flipping any task's pass/fail. This section runs the same paired
  sign test on the per-task mean reward (Holm-corrected in its own family) and
  names the arm that scored lower. It exists mainly to feed the efficiency
  guardrail, but is printed in full so the reward veto is operator-visible rather
  than hidden.
- **Efficiency comparison (paired by task)** — the section that measures a
  compression feature's actual claim: fewer tokens (and less cost) at equal
  reward. For each arm pair it takes the per-task delta on output tokens and on
  cost (B minus A, negative means B is cheaper) and runs the same exact sign
  test, Holm-corrected across this metric's arm pairs (its own `adj p` column). The
  verdict is guarded by BOTH correctness comparisons above: B is called an
  efficiency win only when it is significantly cheaper (adj p < 0.05) AND neither
  the binary pass rate NOR the continuous mean reward dropped significantly against
  it (each judged on its own Holm-adjusted p, so the sections cannot disagree).
  Requiring both closes the "equal reward" loophole where a cheaper arm quietly
  gave up partial credit while the binary rate stayed flat, so "cheaper because it
  did less" cannot read as a win. A metric with no signal (every sample 0) is
  labelled `not measured` rather than a paired delta of zeros, so a missing metric
  is never mistaken for "measured and found equal". For cost that label reads
  `cost unpriced — provider reported no price`, the same fact the per-arm totals
  table shows as `unpriced` (see [Cost is often unpriced](#cost-is-often-unpriced)).
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

  Teaching is necessary but not sufficient, so the table also reports `vocab
  handles`: the number of handles the launch project's dictionary actually loaded,
  read from the agent's `argot_armed` session record. Loading is still not the same
  as showing, so a third column, `handles taught`, reports whether the handle TABLE
  reached the model, read from the agent's `argot_taught` record. That record exists
  because the table is injected on an asynchronous prompt refresh that happens after
  `session_init`, which is the only prompt a transcript stores. No recorded prompt
  can therefore show the table, and without `handles taught` you cannot tell a model
  that declined to encode from one that was never shown a handle.

  You need all three numbers because a `0 encoded` result has four different
  meanings and the counts alone cannot tell them apart:

  - `vocab handles` is `0`. The repository has no repeated-token mass, so the
    dictionary came out empty and the model had nothing to write. Encoding was
    impossible here, and the token delta against this arm says nothing about
    argot. Choose tasks whose repos repeat long paths and commands.
  - `vocab handles` is positive but `handles taught` is below `N/N`. The dictionary
    loaded and the model was never shown it. This is a harness failure, not a
    result: the model is taught the notation, shown no handles, and told never to
    invent one, so writing none is the only compliant thing it can do. Fix the arm
    and rerun before reading anything into the row.
  - `vocab handles` is positive, `handles taught` is `N/N`, and `runs that encoded`
    is `0/N`. Shorthand was genuinely in front of the model and it wrote none. That
    is a real result about model adoption, not about the corpus or the harness.
  - `runs that encoded` is above zero. The delta is a genuine argot measurement.

  A `—` in the column means the run predates this telemetry, so the loaded size is
  unknown and a `0 encoded` result there cannot be read at all. The report prints
  the matching interpretation in prose under the table, so you do not have to
  reconstruct this reasoning each time. Note that `argot_load` calls stay `0.00`
  for the launch project by design: it auto-loads at startup, and the tool is how
  the agent adds *additional* projects.
- **Encode headroom (maximum achievable saving)** — the ceiling on what shorthand
  could ever have saved, and the section that decides whether the run can measure
  argot at all. `max saving` is what the model would have saved by encoding
  perfectly: every occurrence of every loaded handle's expansion, in text and in
  tool-call arguments, written as the handle instead. `noise` is the observed
  run-to-run spread of output tokens across repeated samples of the same arm and
  task, which is the smallest difference the run can tell from chance.

  When the ceiling falls below the noise, the report says `CANNOT MEASURE`, and you
  should believe it: the efficiency comparison is reading variance, and more
  repeats cannot help, because the effect you are looking for is smaller than the
  effect that already exists. This is a different failure from the `(underpowered)`
  qualifier on a verdict. That one means too few decisive tasks, which more tasks
  fix. This one means the workload itself has no room for the feature to act, which
  only a different workload or a different vocabulary fixes.

  The first measured run showed exactly this: 33 handles loaded, 7 of them ever
  emitted, and a ceiling of 0.27% against 8.15% token noise. The dictionary was
  dominated by license text, example fixtures, and documentation URLs, which repeat
  heavily in the repository but which a coding agent never types, while the paths
  the agent retyped constantly received no handle. Pick tasks whose repositories
  repeat long paths and commands the agent actually writes.
- **Errors (per arm)** — every sample that crashed or was refused, grouped by
  reason, across all arms including those with zero errors. An errored sample is
  excluded from every rate and mean above, so an arm that errors more is measured
  on fewer, possibly easier samples: a delta against it can be a selection effect.
  A provider content-filter stop is named by its finish reason (for example
  `NonZeroAgentExitCodeError (PROHIBITED_CONTENT)`), because a refusal that tracks
  one arm — say an injected preamble — is a confound you must see, not an
  anonymous "+N err". If one arm shows a refusal asymmetry, raise `--repeats` so a
  single flake does not decide the comparison, and read whether the asymmetry
  persists. A trial the agent ran to completion but the verifier never scored
  (missing `verifier_result`, so the reward is not a number) is its own error class,
  `verifier-no-reward` — NOT a task failure. A failure is reward=0, a real number the
  verifier assigned; a missing reward means the scorer did not run, so folding it into
  the pass rate as a fail would understate correctness and, if the verifier trips more
  on one arm's diffs, score a scorer confound as a correctness loss. The runner fails
  closed on it: the trial is excluded from every rate and mean and surfaced here.
- **Argot probes** (feature-specific metadata) — how many times the agent
  called `argot_load` and how many assistant messages carried a `§` handle.
  Probe rows only appear for arms that engaged the mechanism; every feature
  should add probes like these to prove engagement, not just outcomes.
- **Tool call distribution (mean calls per completed run)** — how each arm spent
  its tool budget, one column per tool. The cells are the MEAN calls per completed
  run, not raw per-arm totals, and each row shows its completed-run count as `n`.
  Normalizing matters because arms rarely finish the same number of samples (one
  errors more), and raw totals would make the arm that ran fewer samples look like
  it streamlined its tools when it merely did less. This table is descriptive, not
  a win/loss verdict: fewer calls at equal reward is leaner, but fewer calls is not
  a good on its own, so read it alongside the reward comparison.

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

**Start from the worked example, not from this prose:**
`arms/candidate-delivery-terse.sections.yml` (the experiment) plus
`arms/candidate-delivery-terse.yml` (its config half, deliberately identical to
`baseline.yml` so the only variable is the prompt section). Copy both, rename
them, and edit the section text. Run it with:

```bash
bun run.ts --arms baseline,candidate-delivery-terse \
  --tasks tasks/pilot-10.txt --model google-antigravity/gemini-3.5-flash \
  --jobs 2 --repeats 3 --out runs/prompt-delivery-terse
```

`docs-coherence.test.ts` checks every shipped `.sections.yml` through the prompt
builder's own validator, so the example is known to load rather than assumed to.

The system prompt is benched one section at a time. The default prompt is built
from named sections: `conventions`, `role`, `runtime`, `toolPolicy`,
`executionWorkflow`, and `deliveryContract`. A per-section override swaps the
body of exactly one section while every other section, banner, and
`{{#if <setting>}}` conditional is reused byte-for-byte from the shipped prompt.
This is the sanctioned way to bench a prompt change. Overriding
`executionWorkflow` cannot touch the settings-gated delegation block in
`toolPolicy`, so an eval cannot silently override a setting as a whole-prompt
snapshot can.

The override is eval-only and uncontaminatable. It is not a config key or CLI
flag. `vey` reads it exclusively from the
`VEYYON_EVAL_SYSTEM_PROMPT_SECTIONS` environment variable (a JSON object of
`section -> replacement body text`), which the bench sets around one arm. A
normal run cannot reach this path, so no `config.yml` can shift a prompt
section. When the variable is present, `vey` logs a warning that the prompt is
not the production one. When it is absent, the production prompt is used
verbatim.

Put the override in the candidate arm's `arms/<arm>.sections.yml` (a YAML
mapping, authored for readability; `run.ts` compiles it to the JSON the
environment variable carries). Each value must contain body text only. `vey`
adds the registered banner and rejects an override that repeats any registered
banner. It also rejects unknown section names and non-string values:

```yaml
# arms/candidate-lean-workflow.sections.yml
executionWorkflow: |
  Verify the requested behavior before you report completion.
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

## Prompt statement arms

**Start from the worked example, not from this prose:**
`arms/candidate-ablate-delegation-gates.statements.yml` (the experiment) plus
`arms/candidate-ablate-delegation-gates.yml` (its config half, deliberately
identical to `baseline.yml`). Copy both, rename them, and change which rule you
ablate. Run it with:

```bash
bun run.ts --arms baseline,candidate-ablate-delegation-gates \
  --tasks tasks/pilot-10.txt --model google-antigravity/gemini-3.5-flash \
  --jobs 2 --repeats 3 --out runs/ablate-delegation-gates
```

This is the finer of the two prompt lanes, and the difference is what a delta can
be attributed to. A section override answers "is this section's wording better".
It cannot answer "is this RULE worth its tokens", because TOOL POLICY is one
banner region and 34 rules, so a delta across a rewritten section has 34
candidate causes. The system prompt is assembled from named statements, one per
rule, so a statement override changes exactly one rule.

`arms/<arm>.statements.yml` is a mapping of statement id to the replacement text,
or to `null` to REMOVE the rule:

```yaml
# arms/candidate-ablate-lsp-preference.statements.yml
tool-policy/lsp: null
```

`null` and an empty string are different experiments. `null` removes the rule and
the separation it carried. `""` keeps the rule present and silent, so the
paragraph break stays and only the words go: that is how you ask whether a rule
needs saying at all rather than whether it should be there.

Find the ids with `veyyon prompt --statements`, which lists every rule with what
it costs and the condition that decides whether it is in the prompt at all, and
read one with `veyyon prompt --statement <id>`. An id that does not exist is
refused before the run, so a typo cannot quietly bench the production prompt
under a treatment's name. So is a value that is neither text nor `null`, and
malformed YAML.

The fingerprint covers the statements file, so an ablation arm and its control
are distinguishable and the zero-IV floor applies to this lane too. Delete the
statements file and the two arms collide, and the runner says so by name.

`docs-coherence.test.ts` checks every shipped `.statements.yml` through the
prompt builder's own validator, so the example is known to load rather than
assumed to.

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

Veyyon's argot flow runs over a generated vocabulary, and the launch project is
loaded FOR the model, not by it. At startup the agent resolves the project it was
launched in and generates the dictionary from that repo's git-tracked listing,
caching it outside the repository; the handle table then reaches the model on a
prompt refresh. `argot_load <folder>` exists for adding FURTHER projects, so it
stays uncalled on a single-repo task and its count is not an adoption signal.
There is no committed dictionary file to stage, and nothing about the task
environment differs between arms, which keeps the arm comparison clean.

That makes the bench measure three distinct things:

1. **Enablement overhead** (baseline vs decode vs full, all tasks): what the
   preamble, the tools, and the decode seams cost when the feature exists.
   An early pilot put this within noise at roughly 0.7% of input tokens, but that
   run predates the treatment-applied check and its encode arm never actually
   taught the preamble, so treat the figure as unmeasured rather than confirmed.
2. **Adoption** (full arm): whether the model writes handles once it has them.
   Read `runs that encoded` and `vocab handles` together, and do NOT read
   `argot_load calls` as an adoption signal. That counter is zero by design:
   the launch project auto-loads at startup, so the tool is only for adding
   FURTHER projects. An earlier pilot read its zeros as an adoption failure,
   which was a misdiagnosis.
3. **Codec value when engaged**: only measurable on tasks whose repos carry
   compressible mass in strings an agent would actually type. `gen-dicts.ts`
   ranks all 113 tasks by `typeable saving` (`dicts/report.md`) and the argot
   pilot list (`tasks/argot-10.txt`) is the top of that ranking. The ranking
   calls the same generator over the same tree the agent will, so a task's
   score predicts the vocabulary the agent is really given. Confirm the exact
   ceiling for the run you actually performed from the report's Encode
   headroom section, and remember that the default dictionary budget puts that
   ceiling below the noise floor (see above).

If adoption stays zero on high-mass repos, the defect is the product's
invitation (preamble, tool surface), not the bench — and the fix belongs in
veyyon, then this run repeats.

### measure-channel-split.ts: where the agent writes its line structure

Most of a generated dictionary is LINE STRUCTURE: a handle standing for a line
break and the indentation after it. What that text costs depends on where the
model writes it. Inside a tool-call argument the arguments are JSON, so a newline
goes over the wire as the two characters `\` and `n` and a run of tabs is charged
one escape at a time. In a plain message, or in thinking, the same run carries
real control characters and costs about one token.

The gap decides the sign of the whole dictionary. On a tab-indented TypeScript
tree the expensive price earns five structure handles and the cheap price earns
none at all, because a handle costs at least two tokens.

Run the instrument to measure the split on real transcripts:

```
bun measure-channel-split.ts                    # the current profile's sessions
bun measure-channel-split.ts --sessions <dir>   # a specific transcript tree
bun measure-channel-split.ts --json             # machine-readable totals
```

It walks assistant turns only, sorts every emitted newline-plus-indentation run
into the channel it was written into, and prints the share that landed inside
tool-call arguments. Tool results are excluded: they are input the harness wrote,
not output the model paid for. Thinking is included, because it is billed output.

Measured over 307 transcripts and 23,467 assistant turns, 41.76% of structure was
inside tool-call arguments. That number is argot's
`DEFAULT_TOOL_CALL_STRUCTURE_SHARE`, and the generator prices structure on the
mix rather than on one channel. When you rerun this instrument on a larger or
newer corpus and the share moves, update that constant and bump
`GENERATOR_REVISION` in the same change, or every cached dictionary keeps the old
price.

### measure-retype-likelihood.ts: does the agent write what the generator ranked

Pricing says what a string costs. It does not say how often the model will write
it, and a handle only pays when the model writes it. The generator estimates that
second number from document frequency: how many files of the repository a string
appears in. That is a claim about the corpus standing in for a claim about the
agent.

This instrument checks it against the record. Point it at a repository, and it
generates that repository's dictionary the same way the agent does, reads the
transcripts of sessions that ran in it, and counts how many times each handle's
expansion was really emitted.

```
bun measure-retype-likelihood.ts --repo <dir>      # defaults to the current directory
bun measure-retype-likelihood.ts --sessions <dir>  # a specific transcript tree
bun measure-retype-likelihood.ts --json
```

The columns are `predicted` (the generator's own `savedTokens`), `emitted` (real
uses), and `actual` (those uses at the same per-use rate). A high `predicted` next
to an `emitted` of zero is budget spent on a string the model does not write, and
it rides the system prompt on every turn.

The footer is the part that decides whether a dictionary is worth carrying,
because it puts both sides of the ledger on one screen. Savings are output tokens
produced per emission; the dictionary is input tokens carried on every turn. The
`cost ratio` divides the second by the first. Output tokens cost a few times more
than input tokens, so a ratio above roughly 5 is a net loss on any real price
sheet.

Measured on the veyyon repository over 100 attributed transcripts and 7,659
assistant turns: 18 of 49 handles were never emitted once, rank agreement with the
generator's order was 0.357 (Kendall tau-a), and the dictionary carried 2,404,926
input tokens to save 3,202 output tokens, a ratio of 751. See the
ARGOT-DICT-IS-NET-NEGATIVE row in `BACKLOG.md`.

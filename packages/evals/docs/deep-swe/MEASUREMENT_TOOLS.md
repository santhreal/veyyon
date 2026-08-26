# DeepSWE Measurement and Analysis Tools

Auxiliary measurement, telemetry, and vocabulary generation tools in the DeepSWE suite of `@veyyon/evals`.

## Overview

| Tool | Source | Purpose |
|---|---|---|
| `measure-channel-split` | `src/suites/deep-swe/measure-channel-split.ts` | Token volume split across system prompt, tool schemas, user turns, and assistant output |
| `measure-retype-likelihood` | `src/suites/deep-swe/measure-retype-likelihood.ts` | Likelihood of command/path re-typing to predict vocabulary compression headroom |
| `prefix-composition` | `src/suites/deep-swe/prefix-composition.ts` | Prefix caching efficiency, prompt categories, and mid-session cache invalidations |
| `context-encode-ceiling` | `src/suites/deep-swe/context-encode-ceiling.ts` | Theoretical and empirical token-saving ceiling for vocabulary encoding |
| `gen-dicts` | `src/suites/deep-swe/gen-dicts.ts` | Repository vocabulary dictionaries (`.AGENTS.dict`) from git history and source trees |

## Channel Split Analysis

Analyzes session JSONL files to measure token distribution across conversation channels:

- **System prompt**: Base prompt instructions and static headers
- **Tool schemas**: Tool definition JSON schemas
- **User turns**: Instructions, environment observations, test outputs
- **Assistant output**: Emitted thought blocks and tool invocations

```bash
# Every transcript under the default runs directory
bun src/suites/deep-swe/measure-channel-split.ts

# One transcript tree, machine-readable
bun src/suites/deep-swe/measure-channel-split.ts --sessions runs/<timestamp>/jobs --json
```

## Retype Likelihood

Scores tokens in task repositories by repetition frequency across realistic multi-turn workflows:

- Distinguishes typeable symbols (paths, identifiers) from prose and license headers.
- Identifies candidates for project shorthand dictionaries.

```bash
# Defaults to this repository as the corpus
bun src/suites/deep-swe/measure-retype-likelihood.ts

# A specific repository and transcript tree
bun src/suites/deep-swe/measure-retype-likelihood.ts --repo datasets/repo-cache/<task-id> --sessions runs/<timestamp>/jobs --json
```

## Prefix Composition and Cache Analysis

Tracks provider-side prefix cache utilization:

- Measures cache read vs cache write ratio.
- Reports mid-session prompt modifications that invalidate the provider prefix cache.
- Quantifies cost impact of cache invalidation events.

Takes the jobs root positionally, and an optional arm prefix (default `baseline__`):

```bash
bun src/suites/deep-swe/prefix-composition.ts runs/<timestamp>/jobs full__
```

## Context Encode Ceiling

Computes the theoretical and empirical token-saving ceiling for vocabulary encoding:

- Calculates the maximum achievable compression given a dictionary.
- Compares against actual encoding results from a session.

Takes the corpus positionally, then an optional dictionary source (defaults to the corpus).
`--holdout` splits the session so the dictionary is built on one half and measured on the other:

```bash
bun src/suites/deep-swe/context-encode-ceiling.ts runs/<timestamp>/jobs datasets/dicts --holdout
```

## Dictionary Generation

Extracts project vocabularies into static dictionary files:

- Analyzes repository directory structures, imports, build definitions, and commit histories.
- Produces `.AGENTS.dict` files under `datasets/dicts/`, and the savings table
  `datasets/dicts/report.md` that ranks tasks by typeable saving.

```bash
# Every task in the corpus
bun src/suites/deep-swe/gen-dicts.ts --all

# The tasks named by one task list, eight at a time
bun src/suites/deep-swe/gen-dicts.ts --tasks datasets/deep-swe/tasks/argot-10.txt --jobs 8
```

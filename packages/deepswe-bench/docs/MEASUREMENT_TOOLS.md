# DeepSWE Measurement and Analysis Tools

Auxiliary measurement, telemetry, and vocabulary generation tools under `@veyyon/deepswe-bench`.

## Overview

| Tool | Source | Purpose |
|---|---|---|
| `measure-channel-split` | `measure-channel-split.ts` | Token volume split across system prompt, tool schemas, user turns, and assistant output |
| `measure-retype-likelihood` | `measure-retype-likelihood.ts` | Likelihood of command/path re-typing to predict vocabulary compression headroom |
| `prefix-composition` | `prefix-composition.ts` | Prefix caching efficiency, prompt categories, and mid-session cache invalidations |
| `context-encode-ceiling` | `context-encode-ceiling.ts` | Theoretical and empirical token-saving ceiling for vocabulary encoding |
| `gen-dicts` | `gen-dicts.ts` | Repository vocabulary dictionaries (`.AGENTS.dict`) from git history and source trees |

## Channel Split Analysis

Analyzes session JSONL files to measure token distribution across conversation channels:

- **System prompt**: Base prompt instructions and static headers
- **Tool schemas**: Tool definition JSON schemas
- **User turns**: Instructions, environment observations, test outputs
- **Assistant output**: Emitted thought blocks and tool invocations

```bash
bun measure-channel-split.ts --session runs/<timestamp>/jobs/<arm>__<task>__r0/*/agent/veyyon.txt
```

## Retype Likelihood

Scores tokens in task repositories by repetition frequency across realistic multi-turn workflows:

- Distinguishes typeable symbols (paths, identifiers) from prose and license headers.
- Identifies candidates for project shorthand dictionaries.

```bash
bun measure-retype-likelihood.ts --repo deep-swe/tasks/<task-id>
```

## Prefix Composition and Cache Analysis

Tracks provider-side prefix cache utilization:

- Measures cache read vs cache write ratio.
- Reports mid-session prompt modifications that invalidate the provider prefix cache.
- Quantifies cost impact of cache invalidation events.

```bash
bun prefix-composition.ts --session runs/<timestamp>/jobs/<arm>__<task>__r0/*/agent/veyyon.txt
```

## Context Encode Ceiling

Computes the theoretical and empirical token-saving ceiling for vocabulary encoding:

- Calculates the maximum achievable compression given a dictionary.
- Compares against actual encoding results from a session.

```bash
bun context-encode-ceiling.ts --session runs/<timestamp>/jobs/<arm>__<task>__r0/*/agent/veyyon.txt
```

## Dictionary Generation

Extracts project vocabularies into static dictionary files:

- Analyzes repository directory structures, imports, build definitions, and commit histories.
- Produces `.AGENTS.dict` files placed under `dicts/` and `fixtures/dicts/`.

```bash
# Generate dictionaries for all DeepSWE tasks
bun gen-dicts.ts --tasks-root deep-swe/tasks --out dicts/

# Generate for a single task
bun gen-dicts.ts --repo deep-swe/tasks/ytt-jsonpath-query-api --out dicts/
```

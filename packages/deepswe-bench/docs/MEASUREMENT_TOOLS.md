# DeepSWE Measurement & Analysis Tools

This document describes the auxiliary measurement, telemetry, and vocabulary generation tools under `@veyyon/deepswe-bench`.

## Overview

| Tool | Source | Purpose |
|---|---|---|
| `measure-channel-split` | `measure-channel-split.ts` | Measures token volume split across system prompt, tool schemas, user turns, and assistant output. |
| `measure-retype-likelihood` | `measure-retype-likelihood.ts` | Evaluates likelihood of command/path re-typing to predict vocabulary compression headroom. |
| `prefix-composition` | `prefix-composition.ts` | Analyzes prefix caching efficiency, prompt categories, and mid-session cache invalidations. |
| `context-encode-ceiling` | `context-encode-ceiling.ts` | Computes theoretical and empirical token-saving ceiling for vocabulary encoding. |
| `gen-dicts` | `gen-dicts.ts` | Generates repository vocabulary dictionaries (`.AGENTS.dict`) from git commit history and source trees. |

## 1. Channel Split Analysis (`measure-channel-split.ts`)

Analyzes session JSONL files to measure token distribution across conversation channels:
- **System Prompt**: Base prompt instructions + static headers
- **Tool Schemas**: Tool definition JSON schemas
- **User Turns**: Instructions, environment observations, test outputs
- **Assistant Output**: Emitted thought blocks and tool invocations

## 2. Retype Likelihood (`measure-retype-likelihood.ts`)

Scores tokens in task repositories by repetition frequency across realistic multi-turn workflows:
- Distinguishes typeable symbols (paths, symbols, identifiers) from prose / license headers.
- Identifies candidates for project shorthand dictionaries.

## 3. Prefix Composition & Cache Analysis (`prefix-composition.ts`)

Tracks provider-side prefix cache utilization:
- Measures cache read vs cache write ratio.
- Reports mid-session prompt modifications that invalidate provider prefix cache.
- Quantifies cost impact of cache invalidation events.

## 4. Dictionary Generation (`gen-dicts.ts`)

Extracts project vocabularies into static dictionary files:
- Analyzes repository directory structures, imports, build definitions, and commit histories.
- Produces `.AGENTS.dict` files placed under `dicts/` and `fixtures/dicts/`.

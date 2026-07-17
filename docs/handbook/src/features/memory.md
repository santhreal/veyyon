# Memory

Veyyon can remember durable project context across sessions. Memory is **off by default**; pick a
backend in `config.yml` or `/settings`.

## Backends (built)

| Backend | Storage | Best for |
| --- | --- | --- |
| `off` | — | No memory injection or retention |
| `local` | Markdown under the agent memories dir (`MEMORY.md`, `memory_summary.md`, `skills/`) | Curated summaries from past session files |
| `mnemopi` | SQLite via `@veyyon/pi-mnemopi` | Vector + FTS recall, auto-retain, compaction hooks |
| `hindsight` | Hindsight backend (when configured) | Alternative structured memory |

Enable in config:

```yaml
memory:
  backend: mnemopi   # or local, hindsight, off
```

### Mnemopi (recommended for long-running work)

With `memory.backend: mnemopi`, Veyyon:

1. Opens scoped SQLite banks (`global`, `per-project`, or `per-project-tagged`).
2. **Recalls** relevant memories into a `<memories>` block on the first turn (and refreshes the base
   prompt when recall runs from `agent_start`).
3. **Retains** completed turns on a configurable interval (`mnemopi.retainEveryNTurns`, default 4).
4. Supplies **pre-compaction context** from the memory backend when compaction runs.

Key settings: `mnemopi.scoping`, `mnemopi.recallLimit`, `mnemopi.autoRecall`, `mnemopi.autoRetain`,
`mnemopi.polyphonicRecall`, `mnemopi.noEmbeddings`. See
[`docs/internal/mnemosyne-memory-backend.md`](../../../internal/mnemosyne-memory-backend.md).

Dedicated tools when enabled: `recall`, `retain`, `reflect`, `memory_edit`.
The `/memory` slash command exposes `view`, `stats`, `diagnose`, `clear`, and `enqueue`.

### Local summary pipeline

With `memory.backend: local`, a background pipeline at startup extracts durable signal from past
session JSONL files, then consolidates into `MEMORY.md`, `memory_summary.md`, and optional
`skills/`. The agent reads artifacts via `memory://` URLs on the `read` tool.

Engineering detail: [`docs/memory.md`](../../../memory.md).

## Compaction (three knobs)

Context compaction is separate from durable memory. Settings → Compaction (or `config.yml`) exposes
exactly three fields:

| Setting | Key | Values |
| --- | --- | --- |
| Threshold | `compaction.thresholdPercent` | percent of the context window |
| Type | `compaction.strategy` | `handoff` or `snap` |
| Model | `compaction.model` | model id; unset uses the interactive model |

`handoff` writes a structured session transfer; `snap` archives history via the snapcompact engine.
Run on demand with `/compact`. See [Compaction and project memory](../context/compaction-memory.md).

## What the model sees

Recalled or summarized memory is **background context**, not instructions. Current user messages,
tool output, and repo state win on conflict. The agent should cite memory paths when memory changes
a plan and pair citations with fresh repo evidence.

## Configuration

Use `/memory` or `/settings` (Memory group), or set keys under `memory.*`, `mnemopi.*`,
`hindsight.*`, or `memories.*` depending on the active backend.

> **Per-profile:** the active backend, its settings, and its stored data (mnemopi SQLite path,
> local Markdown artifacts, hindsight bank id) are all scoped to the active profile
> (`VEYYON_PROFILE`). Two profiles never share memory — switching profiles switches to an
> independent `memory.backend` and an independent database/artifact set under that profile's
> agent directory.

> **Spec — not shipped:** rollout-DB memory phases, `<oai-mem-citation>` blocks, `rollout_summaries/`,
> and a `/memories` settings pane. Veyyon uses the backends above instead.

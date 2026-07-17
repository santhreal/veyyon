# Core concepts

This chapter is the mental model for how Veyyon runs. Read it when you need the vocabulary behind
sessions, permissions, and the BYOK model boundary. Day-to-day commands live in [Using Veyyon](../using/getting-started.md);
feature guides live under [Features](../features/index.md).

## What this chapter covers

Veyyon is a terminal coding harness. The CLI is **`veyyon`**. You point it at a model endpoint with a key you
supply, and the harness drives a loop of read, edit, verify, and stop. The concepts below explain the
units of that loop and the contracts that keep it predictable across providers.

| Page | What it defines |
| --- | --- |
| [Sessions, turns, and threads](./sessions-turns-threads.md) | The runtime units: a session is the persisted run, a turn is one request plus the agent loop, and a thread is the active path through the session tree. |
| [Permission model](./permission-model.md) | The approval-mode boundary. `tools.approvalMode` (`plan`/`ask`/`auto-edit`/`yolo`) decides which tool tiers run automatically and when Veyyon asks first. There is no OS command sandbox. |
| [Model contract](./model-contract.md) | The BYOK boundary: endpoint + model + key. What the harness owns versus what the provider owns, Freeform vs Function tools, and how system prompts and tool schemas are presented. |

## Foundations that pair with these pages

Before or after this chapter, the foundations pages give the design spine without repeating the
day-to-day workflow:

- [Core concepts (foundations)](../foundations/core-concepts.md) defines session, thread, turn, rollout
  JSONL, and the state database in more detail.
- [Architecture overview](../foundations/architecture.md) maps subsystems to responsibilities.
- Provider and model configuration: [Providers](../models/providers.md) and [`docs/providers.md`](../../../providers.md).

## How the pieces fit

```text
  you ──► veyyon (TUI or a one-shot prompt)
            │
            ├─ session / thread / turn   (concepts/sessions-turns-threads)
            ├─ approval mode             (concepts/permission-model)
            └─ model call                (concepts/model-contract)
                  │
                  ├─ system prompt + tool schemas (harness)
                  ├─ endpoint + key               (your provider)
                  └─ model id                     (discovered or pinned)
```

The harness stays the same when you change providers. You change the endpoint, the key, and optionally
the model id. Tool repair, edit verification, sandboxing, and context compaction remain harness
behavior. See [Configuring providers](../using/configuring-providers.md) for copy-paste setups and
[Models and providers](../using/models.md) for day-to-day model selection.

## Related reading

- [Permission model](./permission-model.md) and [Approvals and autonomy](../features/sandbox.md) for the
  approval-mode ladder.
- Prefer `--approval-mode auto-edit` for bounded automation.
- [Non-interactive mode](../features/exec.md) for scripted `veyyon` launch patterns.

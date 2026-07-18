# Core concepts

Vocabulary for sessions, permissions, and the model/provider boundary. Operator commands:
[Using Veyyon](../using/getting-started.md). Feature guides: [Features](../features/index.md).

## What this chapter covers

The CLI is **`veyyon`**. It calls a configured model endpoint with your credentials and runs a tool loop
(read, edit, verify, stop). The pages below define the units and contracts of that loop.

| Page | What it defines |
| --- | --- |
| [Sessions, turns, and threads](./sessions-turns-threads.md) | The runtime units: a session is the persisted run, a turn is one request plus the agent loop, and a thread is the active path through the session tree. |
| [Permission model](./permission-model.md) | The approval-mode boundary. `tools.approvalMode` (`plan`/`ask`/`auto-edit`/`yolo`) decides which tool tiers run automatically and when Veyyon asks first. There is no OS command sandbox. |
| [Model contract](./model-contract.md) | The BYOK boundary: endpoint + model + key. What the harness owns versus what the provider owns, Freeform vs Function tools, and how system prompts and tool schemas are presented. |

## Foundations that pair with these pages

Before or after this chapter, the foundations pages give the design spine without repeating the
operator workflow:

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

Changing providers changes endpoint, credentials, and model id. Tool repair, edit verification,
approvals, and context compaction remain harness behavior. See
[Configuring providers](../using/configuring-providers.md) and
[Models and providers](../using/models.md).

## Related reading

- [Permission model](./permission-model.md) and [Approvals](../features/sandbox.md) for the
  approval modes.
- Prefer `--approval-mode auto-edit` for bounded automation.
- [Non-interactive mode](../features/exec.md) for scripted `veyyon` launch patterns.

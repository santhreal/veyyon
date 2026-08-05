# Core concepts

This chapter gives you the vocabulary for how Veyyon runs: sessions, permissions, and the boundary between the harness and your model provider. If you want operator commands instead, see [Using Veyyon](../using/getting-started.md), and for feature guides see [Features](../features/index.md).

## What this chapter covers

The CLI is `veyyon`. It calls a configured model endpoint with your credentials and runs a tool loop: read, edit, verify, stop. The pages below define the units and contracts of that loop, so that later chapters can assume you know them.

| Page | What it defines |
| --- | --- |
| [Sessions, turns, and threads](./sessions-turns-threads.md) | The runtime units. A session is the persisted run, a turn is one request plus the agent loop, and a thread is the active path through the session tree. |
| [Permission model](./permission-model.md) | The approval-mode boundary. `tools.approvalMode` (`plan`, `ask`, `ask-command`, `auto`, `yolo`) decides which tool tiers run automatically and when Veyyon asks you first. There is no operating-system command sandbox. |
| [Model contract](./model-contract.md) | The bring-your-own-key boundary: endpoint, model, and key. It covers what the harness owns versus what the provider owns, Freeform versus Function tools, and how system prompts and tool schemas are presented. |

## Foundations that pair with these pages

The foundations pages give the design spine without repeating the operator workflow. Read them before or after this chapter, whichever suits you.

- [Architecture at a glance](../foundations/architecture.md) maps the subsystems to their responsibilities.
- For provider and model configuration, see [Providers](../models/providers.md) and [`docs/providers.md`](../../../providers.md).

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

Changing providers changes the endpoint, the credentials, and the model id. Tool repair, edit verification, approvals, and context compaction stay the same, because they are harness behavior. See [Configuring providers](../using/configuring-providers.md) and [Models and providers](../using/models.md).

## Related reading

- [Permission model](./permission-model.md) and [Approvals](../features/sandbox.md) cover the approval modes.
- Approvals usually need no tuning: the default `auto` runs every tier while the per-tool policies, the working-directory boundary, credential use, and a tool's own critical commands all still ask. Pick a rung explicitly only when you want a different trade-off, and note that a headless run has nobody to answer a prompt, so a rung that asks turns a tool call into a failure rather than a pause.
- [Non-interactive mode](../features/exec.md) covers scripted `veyyon` launch patterns.

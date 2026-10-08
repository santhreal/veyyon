# Core concepts

The vocabulary for how Veyyon runs: sessions, permissions, and the boundary between the harness and the model provider. For commands see [Using Veyyon](../using/getting-started.md); for feature guides see [Features](../features/index.md).

## Pages

The CLI is `veyyon`. It calls a configured model endpoint with your credentials and runs a tool loop: read, edit, verify, stop.

| Page | What it defines |
| --- | --- |
| [Sessions, turns, and threads](./sessions-turns-threads.md) | The runtime units. A session is the persisted run, a turn is one request plus the agent loop, and a thread is the active path through the session tree. |
| [Permission model](./permission-model.md) | The approval-mode boundary. `tools.approvalMode` (`plan`, `ask`, `ask-command`, `auto`, `yolo`) sets which tool tiers run automatically and when Veyyon prompts you first. There is no operating-system command sandbox. |
| [Model contract](./model-contract.md) | The bring-your-own-key boundary: endpoint, model, and key. The split between harness and provider responsibilities, Freeform versus Function tools, and how system prompts and tool schemas are presented. |

## Foundations that pair with these pages

- [Architecture at a glance](../foundations/architecture.md) maps the subsystems to their responsibilities.
- For provider and model configuration, see [Providers](../models/providers.md) and [`docs/handbook/src/reference/providers.md`](../reference/providers.md).

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
- The default `auto` runs every tier; the per-tool policies, the working-directory boundary, credential use, and a tool's own critical commands still prompt. A headless run has no terminal to answer a prompt, so under a rung that prompts, a tool call fails instead of pausing.
- [Non-interactive mode](../features/exec.md) covers scripted `veyyon` launch patterns.

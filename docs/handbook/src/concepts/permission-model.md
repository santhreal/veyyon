# Permission model

Tool execution is gated by **`tools.approvalMode`**. The process does not apply OS command confinement (Landlock, seccomp, Seatbelt, bubblewrap).

## Tool tiers

- **read** — `read`, `grep`, `glob`, listing
- **write** — `edit`, `write`
- **exec** — `bash` and other command execution

## Modes

Set with `tools.approvalMode`, or per run with `--approval-mode` / `--yolo` / `--plan-yolo`.

| Mode | Auto-approves | Prompts for |
| --- | --- | --- |
| `plan` | read | write, exec |
| `ask` | read | write, exec |
| `auto-edit` | read + write | exec |
| `yolo` | all tiers | nothing (unless per-tool override or bash safety rule) |

Schema default: **`yolo`**. Aliases: `always-ask` → `ask`, `write` → `auto-edit`.

## Per-tool overrides

`tools.approval` maps tool name → `allow` | `deny` | `prompt` and wins for that tool.

```yaml
# ~/.veyyon/profiles/default/agent/config.yml
tools:
  approvalMode: auto-edit
  approval:
    bash: prompt
    read: allow
```

## Execpolicy

User and project `.rules` files refine which shell commands auto-run. Untrusted project directories disable project-local rules, config, and hooks until the directory is trusted.

## On deny

Denied or failed policy checks return an error to the model. Permissions are not escalated on error.

## Related

- [Approvals](../features/sandbox.md)
- [Permissions UX](../features/permissions-explainer.md)
- [Safety](../using/safety.md)
- [CLI](../reference/cli.md)

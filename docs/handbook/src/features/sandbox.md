# Approvals

Control surface: **`tools.approvalMode`**. There is no OS-level command sandbox (no Landlock, seccomp, Seatbelt, or bubblewrap). Shell and writes run as the process user subject to this policy and execpolicy rules.

Concepts: [Permission model](../concepts/permission-model.md). UX: [Permissions and approvals](./permissions-explainer.md). [Safety](../using/safety.md).

## Tool tiers

| Tier | Examples |
| --- | --- |
| **read** | `read`, `grep`, `glob`, listing |
| **write** | `edit`, `write` |
| **exec** | `bash` and other command execution |

## Modes

| Mode | read | write | exec |
| --- | --- | --- | --- |
| `plan` | auto | ask | ask |
| `ask` | auto | ask | ask |
| `auto-edit` | auto | auto | ask |
| `yolo` | auto | auto | auto |

Schema default: **`yolo`**. Legacy aliases: `always-ask` → `ask`, `write` → `auto-edit`.

```console
$ veyyon --approval-mode auto-edit
$ veyyon --yolo                    # same as --auto-approve → yolo
$ veyyon --plan-yolo               # plan now; yolo after leaving plan mode
```

```yaml
tools:
  approvalMode: ask
```

## Prompt keys

When a mode requires approval:

```text
[y] yes   [n] no   [a] always for this session   [p] show policy
```

Denied actions return an error to the model; permissions are not widened.

## Headless

`veyyon --print` has no TTY. A mode that would prompt stops the turn unless you use `--yolo` or a non-prompting mode. Process exit status follows the run.

## Execpolicy

User and project `.rules` files further restrict which commands auto-run. Untrusted project directories disable project-local rules, config, and hooks until the directory is trusted.

## Related

- [Permissions and approvals](./permissions-explainer.md)
- [Non-interactive mode](./exec.md)
- [Safety](../using/safety.md)

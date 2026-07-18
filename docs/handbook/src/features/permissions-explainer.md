# Permissions and approvals

Reference: [Approvals](./sandbox.md). No OS command sandbox (Landlock, seccomp, Seatbelt, bubblewrap).

## Prompt flow

When the active mode requires approval for a tool call, the TUI shows the action and waits:

```text
Veyyon would like to run a shell command

Command:   cargo test
Directory: /home/user/my-project

[y] yes   [n] no   [a] always for this session   [p] show policy
```

```text
Veyyon would like to edit a file

File:   src/main.rs
Change: update the function signature and add a null check

[y] yes   [n] no   [a] always for this session   [p] show policy
```

| Key | Effect |
| --- | --- |
| `y` | Allow once |
| `a` | Allow this kind of action for the rest of the session |
| `n` | Deny; model receives the denial |
| `p` | Show active policy |

## Modes

| Mode | read | write | exec |
| --- | --- | --- | --- |
| `plan` | auto | ask | ask |
| `ask` | auto | ask | ask |
| `auto-edit` | auto | auto | ask |
| `yolo` | auto | auto | auto |

Schema default: **`yolo`**. Aliases: `always-ask` → `ask`, `write` → `auto-edit`.

CLI: `--approval-mode <mode>`, `--yolo` / `--auto-approve`, `--plan-yolo`.

## Headless

`veyyon --print` has no TTY. Modes that would prompt stop the turn; use `--yolo` or a non-prompting mode for unattended runs.

## Execpolicy

`.rules` files (user and project) refine command auto-approval. Untrusted project directories disable project-local rules, config, and hooks until trusted.

## Related

- [Approvals](./sandbox.md)
- [Permission model](../concepts/permission-model.md)
- [Safety](../using/safety.md)

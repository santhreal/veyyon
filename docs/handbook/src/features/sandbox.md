# Approvals

Approvals are how you decide which tools run without asking. One setting drives them:
`tools.approvalMode`. There is no operating-system sandbox behind it (no Landlock, seccomp,
Seatbelt, or bubblewrap). Shell commands and file writes run as your user, bounded only by
this policy and the execpolicy rules below.

This page is the operator reference. For the model behind it, see
[Permission model](../concepts/permission-model.md). For the wider boundary, see
[Safety](../using/safety.md).

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

## The approval prompt

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
| `n` | Deny; the model receives the denial |
| `p` | Show the active policy |

Denied actions return an error to the model, and permissions are never widened.

## Headless

`veyyon --print` has no terminal to prompt in. If the mode would ask for approval, the turn
stops instead. To run unattended, pass `--yolo` or pick a mode that does not prompt for the
tiers you need. The process exit status follows the run.

## Execpolicy

User and project `.rules` files further restrict which commands auto-run. Untrusted project directories disable project-local rules, config, and hooks until the directory is trusted.

## Related

- [Permission model](../concepts/permission-model.md)
- [Non-interactive mode](./exec.md)
- [Safety](../using/safety.md)

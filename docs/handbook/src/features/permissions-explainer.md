# Permissions and approvals

Veyyon can run commands and edit files on your behalf. One control shapes that power: the **approval
mode**, which decides when Veyyon acts on its own and when it pauses to ask you first. This page
explains the flow and the choices. For the full reference, see [Approvals and autonomy](./sandbox.md).

Veyyon does not add an OS-level command sandbox — it does not confine shell commands with Landlock,
seccomp, Seatbelt, or bubblewrap. The approval mode is the boundary, so run write-capable modes only
where you trust the repository and the machine.

## The approval flow

When Veyyon wants to run a command or edit a file, it shows a short prompt. The prompt tells you what
is about to happen and where; you choose whether to allow it once, allow it for the session, or deny it.

A command prompt looks like this:

```text
Veyyon would like to run a shell command

Command:   cargo test
Directory: /home/user/my-project

[y] yes   [n] no   [a] always for this session   [p] show policy
```

A file-edit prompt looks like this:

```text
Veyyon would like to edit a file

File:   src/main.rs
Change: update the function signature and add a null check

[y] yes   [n] no   [a] always for this session   [p] show policy
```

`y` runs the action once. `a` lets the same kind of action run without asking for the rest of the
session. `n` cancels it and tells the model so it can try another approach. `p` shows the active policy.

## Tool tiers

The mode grants autonomy per tier: **read** tools (`read`, `grep`, `glob`) never change anything,
**write** tools (`edit`, `write`) modify workspace files, and **exec** tools (`bash`) run programs.

## Approval modes

| Mode | read | write | exec | Best for |
| --- | --- | --- | --- | --- |
| `plan` | auto | ask | ask | Read-only exploration and planning. |
| `ask` | auto | ask | ask | Everyday work; approve each change and command. |
| `auto-edit` | auto | auto | ask | Edit freely, confirm before running commands. |
| `yolo` | auto | auto | auto | Fully hands-off; trusted / externally isolated environments only. |

The legacy names `always-ask` (= `ask`) and `write` (= `auto-edit`) are still accepted. Set the mode
with `--approval-mode <mode>`, `--auto-approve` / `--yolo`, `--plan-yolo`, or `tools.approvalMode` in
`config.yml`.

## Headless runs

`veyyon --print` has no TTY to answer prompts. Pick the mode for the job: `--approval-mode ask` stops
the turn rather than hanging on anything that would prompt, and `--yolo` runs the whole task
unattended. Use `--yolo` only when the runner is disposable or externally isolated, because Veyyon does
not contain the commands it runs.

## Execution policy rules

Beyond the mode, **execpolicy** `.rules` files (user and project) refine which specific commands
auto-run. Untrusted project directories disable project-local rules, config, and hooks until you trust
the directory.

## Tuning for a session

- Change the mode mid-session from `/settings` (Advanced → Safety).
- `/reload-plugins` re-reads `config.yml` after you edit it, so policy changes apply without restarting.
- Use [profiles](../using/configuration.md#use-profiles-for-different-kinds-of-work) for repeatable setups — for example a `reviewer`
  profile pinned to `plan`.

## What to verify

After changing settings, confirm the active `tools.approvalMode` in `/settings` (Advanced → Safety). A
silent fallback to a less restrictive state is treated as a bug. See [Safety](../using/safety.md) for
the broader guarantees and how to inspect what Veyyon has done.

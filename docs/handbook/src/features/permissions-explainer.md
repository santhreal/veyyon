# Permissions and approvals

> **Spec — not shipped:** the named **sandbox-policy** vocabulary on this page (`read-only` /
> `workspace-write` / `danger-full-access` / `external-sandbox`) and the `-s` / `--sandbox` and
> `-a` / `--ask-for-approval` flags. The shipped control is the **`tools.approvalMode`** autonomy
> ladder — `plan`, `ask`, `auto-edit`, `yolo` — set with `--approval-mode <mode>`,
> `--auto-approve` / `--yolo`, or `tools.approvalMode` in `config.yml`. The approval-flow UX below is
> accurate; the sandbox-policy tables are the target shape. See
> [Sandbox and approvals](./sandbox.md) for the same distinction.

Veyyon can run commands and edit files on your behalf. Two controls shape that power: the
**sandbox** (spec) decides what a command is allowed to touch, and the **approval policy** decides when
Veyyon pauses to ask you first. This page explains the user-facing flow, the choices, and how to
combine them. For the complete reference, see [Sandbox and approvals](./sandbox.md).

## Why two controls?

The sandbox is a hard boundary. It says "this command may read here, write there, and reach the
network, and nothing else." The approval policy is an interaction choice. It says "this kind of
action should stop for a yes before it runs." A command that the sandbox forbids never runs, even if
the approval policy would allow it. A command that the sandbox allows may still ask you, depending on
the policy.

Separating the two lets you pick the right trade-off for the task. You can be strict on both,
permissive on one but strict on the other, or fully hands-off for trusted automation.

## The approval flow

When Veyyon wants to run a command or edit a file, it shows a short prompt. The prompt tells you what
is about to happen, where, and under which policy. You choose whether to allow it once, allow it for the
session, or deny it.

A typical command prompt looks like this:

```text
Veyyon would like to run a shell command

Command:  cargo test
Directory: /home/user/my-project
Sandbox:   workspace-write

[y] yes   [n] no   [a] always for this session   [p] show policy
```

A file-edit prompt looks like this:

```text
Veyyon would like to edit a file

File:      src/main.rs
Sandbox:   workspace-write
Change:    update the function signature and add a null check

[y] yes   [n] no   [a] always for this session   [p] show policy
```

If you choose `y`, the action runs once. If you choose `a`, the same kind of action in the same
session runs without asking again. If you choose `n`, the action is cancelled and Veyyon tells the
model so it can try a different approach. `p` shows the active policy details.

## Sandbox backends

The sandbox bounds filesystem and network access. There are four backends.

| Policy | What it can touch | Best for |
| --- | --- | --- |
| `read-only` | Read anywhere; write nothing. Network off by default. | Exploring code you do not fully trust. |
| `workspace-write` | Read anywhere; write within the workspace and configured roots. Network off by default. | Everyday coding in a trusted project. |
| `danger-full-access` | No filesystem or network restrictions. | Disposable environments or tasks that truly need full access. |
| `external-sandbox` | Full disk access, because the process is already contained by an outer sandbox. Network follows the provided setting. | Running inside Docker, a VM, or another sandbox you trust. |

On Linux, `read-only` and `workspace-write` are enforced with Landlock and seccomp. On macOS, they use
the Seatbelt profile. Where the system sandbox is unavailable, Veyyon uses a bundled `bwrap` mount
namespace. If enforcement cannot be established, Veyyon fails closed rather than running unsandboxed.

## Approval policies

The approval policy decides when Veyyon stops for permission. Set it in
[configuration](../using/configuration.md) or per run with `-a, --ask-for-approval <policy>`.

| Policy | Behavior | Best for |
| --- | --- | --- |
| `untrusted` | Known-safe, read-only actions run automatically; everything else asks. | Unfamiliar repositories or high-risk work. |
| `on-request` | The model requests approval for anything it considers risky. | Everyday coding where you want the model to judge. |
| `granular` | Fine-grained per-category control: shell commands, execpolicy prompts, skill scripts, `request_permissions`, and MCP elicitations can be allowed or auto-rejected independently. | Teams that want explicit rules for each tool class. |
| `never` | Never ask. Denied or failed actions return to the model. | Trusted automation only. |

The `granular` policy is useful when you want one behavior for some tools and another for others. For
example, you can let tests run automatically while still requiring approval for file edits or network
calls.

## How the two combine

The sandbox is the last line of defense; the approval policy is the speed bump. Choose a permissive
approval policy only when the sandbox already limits damage.

- **Exploring an unfamiliar repo:** `read-only` + `untrusted`. Veyyon can read and search, but cannot
  write or run anything risky without asking.
- **Everyday coding:** `workspace-write` + `on-request`. Veyyon can edit files in the project and
  run commands, but it asks for anything risky.
- **Trusted CI automation:** `workspace-write` or `read-only` with headless `never` ask (the
  default for `veyyon --print`). The run completes without interruption, and the sandbox still limits
  what can be touched.
- **Dangerous work:** `danger-full-access` + `untrusted`. The sandbox is gone, so every risky action
  must be approved by you.

Never pair `danger-full-access` with `never` unless the environment is disposable and the inputs are
fully trusted. That combination removes both containment and human review.

## Tuning trust for a session

You can change the boundary without editing a file.

- `-c sandbox_policy=read-only` or `-a untrusted` overrides the policy for a single run.
- `veyyon --print` defaults to `never` ask in headless mode with the active sandbox, so automation runs
  unattended but still bounded. `--full-auto` is deprecated; prefer explicit `--sandbox`.
- `/sandbox-add-read-dir <absolute_path>` grants read access to a directory for the current session.
- `/elevate-sandbox` walks you through setting up the elevated sandbox when a task needs more than the
  default.
- `/reload` re-reads the configuration file after you edit it, so you can update policies without
  restarting Veyyon.

Use [profiles](../using/configuration.md#profiles) for repeatable combinations. For example, a
`reviewer` profile can use `read-only` + `untrusted`, while a `deploy` profile uses `workspace-write` +
`never` inside a CI runner that already has an external sandbox.

## What to verify

After changing approval settings, confirm the active `tools.approvalMode` in `/settings`
(Advanced → Safety). A silent fallback to a less restrictive state is treated as a bug. See
[Safety](../using/safety.md) for the broader guarantees and how to inspect what Veyyon has done.

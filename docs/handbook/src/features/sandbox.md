# Approvals and autonomy

Veyyon decides when the agent may act on its own and when it must pause for your yes through one
control: the **approval mode** (`tools.approvalMode`). There is no separate OS-level command sandbox —
Veyyon does not confine shell commands with Landlock, seccomp, Seatbelt, or bubblewrap. Autonomy is a
policy the agent follows, so run write-capable modes only in repositories and on machines you trust.

For the short mental model see [Permission model](../concepts/permission-model.md); for the approval
UX walkthrough see [Permissions and approvals](./permissions-explainer.md); for what to verify see
[Safety](../using/safety.md).

## Tool tiers

Every tool sits in one of three tiers, and the approval mode decides which tiers run without asking:

| Tier | Examples |
| --- | --- |
| **read** | `read`, `grep`, `glob`, listing — never modify anything. |
| **write** | `edit`, `write` — change files in the workspace. |
| **exec** | `bash` and other command execution — run arbitrary programs. |

## The approval ladder

| Mode | read | write | exec | Use for |
| --- | --- | --- | --- | --- |
| `plan` | auto | ask | ask | Read-only exploration; plan-mode session semantics. |
| `ask` | auto | ask | ask | Everyday work where you approve each change. |
| `auto-edit` | auto | auto | ask | Let the agent edit freely but confirm before it runs commands. |
| `yolo` | auto | auto | auto | Auto-approve everything — trusted, ideally externally isolated environments only. |

The legacy names `always-ask` (= `ask`) and `write` (= `auto-edit`) are still accepted.

Set the mode any of these ways (later wins):

```console
$ veyyon --approval-mode auto-edit            # per launch
$ veyyon --auto-approve                        # alias: --yolo (= yolo mode)
$ veyyon --plan-yolo                            # plan now, auto-approve once you leave plan mode
```

Or persist it in `config.yml`:

```yaml
tools:
  approvalMode: ask
```

## The approval prompt

When a mode requires it, Veyyon shows the action before it runs:

```text
Veyyon would like to run a shell command

Command:   npm test
Directory: /home/you/proj

[y] yes   [n] no   [a] always for this session   [p] show policy
```

- `y` — run once.
- `a` — allow this kind of action for the rest of the session.
- `n` — deny; the model is told so it can try another approach.
- `p` — show the active policy.

## Headless runs

`veyyon --print` has no TTY to answer prompts, so choose the mode explicitly for the job: `--approval-mode
ask` blocks on anything that would prompt (so the turn stops rather than hangs), while `--yolo` runs the
whole task unattended. Use `--yolo` only when the runner is disposable or externally isolated (Docker, a
VM, a locked-down CI job), because Veyyon itself does not contain the commands it runs.

## Execution policy rules

Command allowlists and prompts also come from **execpolicy** `.rules` files (user and project). They
refine which specific commands auto-run within the active mode. Untrusted project directories disable
project-local rules, config, and hooks until you trust them.

## Fail-closed for security controls

Approval decisions fail closed: a denied or errored command returns to the model rather than escalating
to a wider permission, and hooks that reject a `PermissionRequest` block the action. After changing the
mode, confirm the active `tools.approvalMode` in `/settings` (Advanced → Safety).

## See also

- [Permissions and approvals](./permissions-explainer.md) — the approval UX in depth.
- [Permission model](../concepts/permission-model.md) — the one-paragraph model.
- [Non-interactive mode](./exec.md) — choosing a mode for CI.
- [Safety](../using/safety.md) — what surfaces and what to verify.

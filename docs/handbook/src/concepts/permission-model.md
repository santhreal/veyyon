# Permission model

Veyyon controls what the agent may do on its own with one mechanism: the **approval mode**. It decides
which tool tiers run automatically and which pause for your yes. There is no separate OS sandbox —
Veyyon does not confine shell commands with Landlock, seccomp, Seatbelt, or bubblewrap — so the mode is
the boundary.

## Tool tiers

- **read** — `read`, `grep`, `glob`, listing. Never modify anything.
- **write** — `edit`, `write`. Change workspace files.
- **exec** — `bash` and other command execution. Run programs.

## Approval modes

The approval mode is an autonomy ladder set with `tools.approvalMode`, overridable per run with
`--approval-mode <mode>` (and `--auto-approve` / `--yolo` / `--plan-yolo`).

| Mode | Auto-approves | Prompts for |
| --- | --- | --- |
| `plan` | Read-only; proposes changes without writing | Everything that writes or runs |
| `ask` | Read-only tools | `write`, `exec` |
| `auto-edit` | Read + workspace write | `exec` |
| `yolo` | All tiers | Nothing (unless a per-tool override or bash-safety override applies) |

The legacy names `always-ask` (→ `ask`) and `write` (→ `auto-edit`) are still accepted.

## Per-tool overrides

Per-tool policy is a second layer: `tools.approval` maps a tool name to `allow`, `deny`, or `prompt`
and wins over the mode for that tool. For example `veyyon config set tools.approval '{"bash":"prompt"}'`
always prompts for `bash` even in `yolo`.

```yaml
# ~/.veyyon/agent/config.yml
tools:
  approvalMode: auto-edit
  approval:
    bash: prompt
    read: allow
```

## Execution policy rules

Beyond the mode and per-tool policy, **execpolicy** `.rules` files (user and project) refine which
specific commands auto-run. Untrusted project directories disable project-local rules, config, and
hooks until you trust the directory.

## Fail-closed behavior

Approval decisions fail closed: a denied or errored command returns to the model rather than
escalating to a wider permission. Silent widening of permissions is treated as a bug. After changing
approval settings, confirm the active `tools.approvalMode` in `/settings` (Advanced → Safety).

## Where the details live

- [Approvals and autonomy](../features/sandbox.md) — the deep reference.
- [Permissions and approvals](../features/permissions-explainer.md) — the approval UX.
- [Using Veyyon safely](../using/safety.md) — what surfaces and the checks to run.
- [CLI reference](../reference/cli.md) — launch flags.

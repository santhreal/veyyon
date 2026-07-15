# Permission model

Veyyon separates two questions when a tool wants to act:

- When must Veyyon ask you first? That is the **approval mode**.
- What may a shell command actually touch? That is the **OS sandbox**.

Together they decide whether a call runs, runs restricted, or pauses for your yes.

## Approval modes

The approval mode is an autonomy ladder set with `tools.approvalMode`, overridable per run with
`--approval-mode <mode>` (and `--auto-approve` / `--yolo`).

| Mode | Auto-approves | Prompts for |
| --- | --- | --- |
| `plan` | Read-only; proposes changes without writing | Everything that writes or runs |
| `ask` | Read-only tools | `write`, `exec` |
| `auto-edit` | Read + workspace write | `exec` |
| `yolo` (default) | All tiers | Nothing (unless a per-tool override or bash-safety override applies) |

The legacy names `always-ask` (→ `ask`) and `write` (→ `auto-edit`) are still accepted.

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

## OS sandbox for shell commands

When Veyyon runs a shell command it can confine that process at the OS level so it can only touch what
the task needs. Enforcement is platform-native:

- **Linux** — Landlock and seccomp, with **bubblewrap** providing the mount (and, when needed, network)
  namespace. A bundled `bwrap` is used when the system one is missing; Veyyon warns so you can install
  the OS package. User namespaces are required — **WSL1** cannot create them, so use **WSL2**.
- **macOS** — a Seatbelt profile.

OS-level isolation is enforced by native code. If enforcement cannot be established, Veyyon **fails
closed** — that is an error, not a silent run without confinement.

## How they combine

The sandbox is the hard boundary; the approval mode is the interaction. A command the sandbox forbids
does not run regardless of approvals. A command the sandbox permits may still pause for your approval,
depending on the mode. Choose a permissive approval mode only alongside a sandbox you trust for the task.

## Fail-closed behavior

When enforcement cannot be established, Veyyon fails closed rather than silently running unsandboxed.
Silent fallback to a weaker boundary is treated as a bug. After changing approval or sandbox settings,
verify enforcement with `veyyon plugin doctor`.

> **Spec — not shipped:** the named **sandbox policies** (`read-only`, `workspace-write`,
> `danger-full-access`, `external-sandbox`) and the `-a` / `--ask-for-approval` policy names
> (`untrusted`, `on-request`, `granular`, `never`). Veyyon ships approval **modes**
> (`tools.approvalMode`) plus OS-level shell isolation, not a `sandbox_policy` config key.

## Where the details live

- [Sandbox and approvals](../features/sandbox.md) for the deep reference and runtime commands.
- [Using Veyyon safely](../using/safety.md) for the honesty guarantees and the checks to run.
- [CLI reference](../reference/cli.md) for the launch flags.

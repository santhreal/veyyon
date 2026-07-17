# Sandbox

The sandbox bounds what tool and shell commands may read, write, and reach on the host. When Veyyon
is unsure whether an action is safe, it asks the user instead of assuming.

## Responsibility

- Map approval mode and sandbox policy to concrete restrictions for `bash`, `edit`, `write`, and
  related tools.
- Enforce workspace roots and network policy per session settings.
- Surface permission prompts in the TUI before mutating or risky commands run.

## Public boundary

Settings keys such as `approvalMode`, sandbox-related enums in `config.yml`, and CLI flags on launch
(`--approval-mode` and sandbox overrides) resolve into concrete restrictions applied to the `bash`,
`edit`, and `write` tools, with plan-mode guards on top.

There is **no** standalone exec-server process in the shipped product; commands run in-process after
policy resolution.

## Key concepts

| Concept | Meaning |
| --- | --- |
| Approval mode | When to prompt before tool execution (`on-request`, `never`, …) |
| Sandbox policy | Filesystem/network posture for command tools |
| Plan mode | Restricts mutating tools until plan is approved (`/plan`) |

User-facing guide: [Sandbox and approvals](../features/sandbox.md).

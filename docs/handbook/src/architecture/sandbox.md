# Approvals

Approvals decide when a tool or shell command runs on its own and when Veyyon pauses for the user.
There is no OS-level command sandbox: Veyyon does not confine commands with Landlock, seccomp,
Seatbelt, or bubblewrap. The boundary is policy the agent loop enforces before dispatch.

## Responsibility

- Map the **approval mode** (`tools.approvalMode`) to a per-tier decision (read / write / exec) for
  `bash`, `edit`, `write`, and related tools.
- Apply per-tool overrides (`tools.approval` → `allow` / `deny` / `prompt`) on top of the mode.
- Apply execpolicy `.rules` (user and project) that allowlist or require prompts for command classes.
- Surface the approval prompt in the TUI before a gated command or edit runs.

## Public boundary

`tools.approvalMode` in `config.yml` and the launch flags (`--approval-mode`, `--auto-approve` /
`--yolo`, `--plan-yolo`) resolve to a decision applied to the `bash`, `edit`, and `write` tools, with
plan-mode guards on top. Commands run **in-process** after policy resolution — there is no standalone
exec-server process in the shipped product.

## Key concepts

| Concept | Meaning |
| --- | --- |
| Approval mode | Which tool tiers run without asking (`plan`, `ask`, `auto-edit`, `yolo`). |
| Per-tool policy | `tools.approval` overrides the mode for a named tool. |
| Execpolicy rules | `.rules` files that refine which specific commands auto-run. |
| Plan mode | Restricts mutating tools until the plan is approved (`/plan`). |

User-facing guide: [Approvals and autonomy](../features/sandbox.md).

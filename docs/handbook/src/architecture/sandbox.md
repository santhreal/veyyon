# Approvals

Approvals decide when a tool or shell command runs on its own and when Veyyon pauses for the user.
There is no OS-level command sandbox: Veyyon does not confine commands with Landlock, seccomp,
Seatbelt, or bubblewrap. The boundary is policy the agent loop enforces before dispatch.

## Responsibility

- Map the **approval mode** (`tools.approvalMode`) to a per-tier decision (read / write / exec) for
  `bash`, `edit`, `write`, and related tools.
- Apply per-tool overrides (`tools.approval` → `allow` / `deny` / `prompt`) on top of the mode.
- Force a prompt for hard-coded critical bash patterns (recursive deletion rooted at `/`, fork bombs, `curl | sh`, disk destruction) in `plan`, `ask`, and `auto-edit`; `yolo` auto-approves them unless `tools.approval.bash` is `prompt` or `deny`.
- Surface the approval prompt in the TUI before a gated command or edit runs.

## Public boundary

`tools.approvalMode` in `config.yml` and the launch flags (`--approval-mode`, `--auto-approve` /
`--yolo`, `--plan-yolo`) resolve to a decision applied to the `bash`, `edit`, and `write` tools, with
plan-mode guards on top. Commands run **in-process** after policy resolution, there is no standalone
exec-server process in the shipped product.

## Key concepts

| Concept | Meaning |
| --- | --- |
| Approval mode | Which tool tiers run without asking (`plan`, `ask`, `auto-edit`, `yolo`). |
| Per-tool policy | `tools.approval` overrides the mode for a named tool. |
| Critical bash patterns | Hard-coded destructive-command shapes that prompt in non-yolo modes, even over a per-tool `allow`. |
| Plan mode | Restricts mutating tools until the plan is approved (`/plan`). |

User-facing guide: [Approvals](../features/sandbox.md).

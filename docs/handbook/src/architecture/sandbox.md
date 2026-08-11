# Approvals

Approvals decide when a tool or shell command runs on its own and when Veyyon pauses for the user.
There is no OS-level command sandbox: Veyyon does not confine commands with Landlock, seccomp,
Seatbelt, or bubblewrap. The boundary is policy the agent loop enforces before dispatch.

## Responsibility

- Map the **approval mode** (`tools.approvalMode`) to a per-tier decision (read / write / exec) for
  `bash`, `edit`, `write`, and related tools.
- Apply per-tool overrides (`tools.approval` → `allow` / `deny` / `prompt`) on top of the mode.
- Apply the two argument-level boundaries the tier cannot see: a filesystem target outside the session working directory, and a call whose arguments carry a stored credential. Both prompt on every rung except `yolo`, the shipped `auto` included.
- Force a prompt for hard-coded flagged bash patterns. The destructive ones (recursive deletion of the home directory or a system directory, fork bombs, disk destruction, writes to the system account files) prompt on every rung, `yolo` included: that is a floor rather than an ordinary prompt, and only an explicit `tools.approval.bash: allow` lifts it, while `deny` remains a hard block. The merely dangerous ones (`curl | sh`, `reboot`, `nc -e`) prompt on every rung below `yolo`.
- Surface the approval prompt in the TUI before a gated command or edit runs.

## Public boundary

`tools.approvalMode` in `config.yml` and the launch flags (`--approval-mode`, `--auto-approve` /
`--yolo`, `--plan-yolo`) resolve to a decision applied to the `bash`, `edit`, and `write` tools, with
plan-mode guards on top. Commands run **in-process** after policy resolution, there is no standalone
exec-server process in the shipped product.

## Key concepts

| Concept | Meaning |
| --- | --- |
| Approval mode | Which tool tiers run without asking (`plan`, `ask`, `ask-command`, `auto` (default), `yolo`; legacy `always-ask` → `ask`, `write` and `auto-edit` → `ask-command`). |
| Per-tool policy | `tools.approval` overrides the mode for a named tool. |
| Flagged bash patterns | Hard-coded command shapes recorded as destructive or dangerous. The destructive ones prompt on every rung including `yolo`, and below `yolo` a per-tool `allow` does not lift them. The dangerous ones prompt on every rung below `yolo`. |
| Plan mode | Restricts mutating tools until the plan is approved (`/plan`). |

User-facing guide: [Approvals](../features/sandbox.md).

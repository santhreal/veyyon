# Safety

Commands and file writes go through **approval mode** (`tools.approvalMode`). There is no OS command sandbox (Landlock, seccomp, Seatbelt, bubblewrap). Policy details: [Approvals](../features/sandbox.md). Concepts: [Permission model](../concepts/permission-model.md). Summary: [Approvals and errors](../benefits/safety-errors.md).

Task subagents can use **filesystem isolation** (CoW worktree backends via `task.isolation.*`) so their edits land in a private tree until merged. That is change-control for subagents, not an OS process sandbox. See task tool docs / `task.isolation` in settings.

## Operator-visible cases

| Situation | Result |
| --- | --- |
| Command or edit needs permission | Approval prompt with command/path and cwd |
| Approval denied | Denial / tool failure; no partial escalation of rights |
| Tool JSON malformed but unambiguous | Schema repair, then validation/dispatch |
| Tool JSON ambiguous or unrepairable | Error tool result to the model; no dispatch |
| Tool output truncated | Truncation recorded in the tool result |
| Config / provider data invalid | Load fails with path and context |

## Headless

`veyyon --print` has no TTY for prompts. Set `--approval-mode` / `--yolo` explicitly for the job. Reserve full auto-approve for disposable runners. See [Non-interactive mode](../features/exec.md).

## Related

- [Approvals](../features/sandbox.md)
- [Configuration](./configuration.md)
- [Repair](../repair/overview.md)

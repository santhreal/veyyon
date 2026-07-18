# Code review

Review surfaces:

1. **`/review`** — bundled interactive review command (branch, commits, or uncommitted work).
2. **Advisor** — optional second model that comments on main-agent turns.
3. **Plan review** — `/plan-review` while plan mode is active.
4. **Non-interactive** — free-form review prompts under `veyyon -p`.

## `/review`

Bundled custom command (`packages/coding-agent/src/extensibility/custom-commands/bundled/review`).
Launches a review flow over a chosen target and uses the review tool surface (`report_finding`, …).
See the command help in-session and `docs/handbook` task guides for example prompts.

## Advisor

The advisor is a second model role that reads each main-agent turn and can inject notes
(aside, concern, or blocker). Enable with `--advisor` or the advisor settings/role.
Uses its own context and model assignment when configured.

## Plan review

Inside plan mode, `/plan-review` reopens review of the current plan file. See [Plan mode](./plan-mode.md).

## Non-interactive

```console
$ veyyon -p "review the uncommitted diff for correctness and missing tests"
$ veyyon -p --yolo "review this branch against main; list P0/P1 findings only"
```

Typical targets: uncommitted work, a branch delta, or paths named in the prompt. Exit status
follows the print-mode run (`veyyon --help`).

## Approvals

Tool approvals use `tools.approvalMode` and per-tool policy. See [Approvals](./sandbox.md) and
[Safety](../using/safety.md).

## Related

- [Approvals](./sandbox.md)
- [Non-interactive mode](./exec.md)
- [Roles and profiles](../using/roles-and-profiles.md)

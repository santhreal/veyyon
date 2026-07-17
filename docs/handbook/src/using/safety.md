# Safety

Veyyon is allowed to act on your machine, so the boundary has to be explicit — and visible.

Commands and file writes run through the **approval mode** (`tools.approvalMode`), which decides when
Veyyon acts on its own and when it pauses for your permission. Veyyon does not add an OS command
sandbox, so the mode is the boundary — and its decisions are visible. If Veyyon cannot prove a tool
call fits the advertised schema it fails closed or asks; silent degradation is treated as a product
bug.

Deep policy reference: [Approvals and autonomy](../features/sandbox.md). Mental model:
[Permission model](../concepts/permission-model.md). Product framing:
[Safety you can see](../benefits/safety-honesty.md).

## What you see

An agent that silently weakens its boundary is hard to trust. Veyyon is designed so you can see:

| Situation | What you should see |
| --- | --- |
| Command or edit needs permission | An approval prompt with command/path and cwd. |
| Approval is denied | A clear denial / tool failure — not a partial side effect. |
| Tool call is malformed but repairable | The call is repaired; the model gets coaching on the correct shape. |
| Tool call is ambiguous or unrepairable | Refusal + coaching; **no** guessed dispatch. |
| Output was truncated | Truncation is recorded, not hidden. |
| Config / provider data is bad | Load fails with file and value context — no silent empty catalog. |

Tool calls follow the same rule as shell. A recoverable malformed call can be repaired against the
advertised schema; an unrepairable call is reported back to the model with coaching and is not
dispatched as garbage. Output truncation, disabled safety nets, bad configuration, and missing
provider data are operator-visible conditions.

## What Veyyon refuses

Veyyon would rather miss a fix than invent one:

- **Ambiguous argument repair** — if two repairs are plausible, the call fails instead of guessing.
- **Stale patch hunks** — update context that no longer matches the file is rejected before write.
- **Non-unique exact edits** — `oldText` that matches many places is rejected with a count and coaching.
- **Weakening its own boundary** — no “approve this one silently” fallback; a denied action returns to the model.
- **Destructive Git as a way to “clean uncertainty”** — treat a dirty worktree as normal active
  context; inspect with `git status --short`, `git diff`, and `git diff --cached`. Do not ask Veyyon
  to clear uncertainty with `git reset --hard`, `git checkout --`, `git restore`, or `git clean`.

## Approvals you can see

When a command or edit needs approval, the prompt shows what is about to run and where. You can allow
once, allow for the session, deny, or inspect the policy. Denied actions return to the model so it can
change approach — they do not silently become success.

In headless `veyyon --print` there is no interactive prompt, so choose the approval mode for the job:
`--approval-mode ask` stops the turn rather than hanging, and `--yolo` runs unattended. Veyyon does not
sandbox the commands it runs, so reserve `--yolo` for disposable or externally isolated runners. See
[Non-interactive mode](../features/exec.md).

## Trust, allowlists, and rules

If you decline directory trust during onboarding, Veyyon exits with next-step advice instead of a silent quit: project-local config, hooks, and exec policies stay unloaded until you trust the workspace. You can re-run and accept trust, or explore in a read-only posture with `veyyon --approval-mode plan`.

On first-run welcome, if a newer install is already known from the update cache, Veyyon shows an **Update available** badge while the background version probe refreshes.

- Keep approvals enabled when working in repositories you do not fully trust.
- Prefer exact workspace roots and explicit provider config over ambient shell state.
- Execpolicy `.rules` files (user and project) can allowlist or require prompts for command classes.
  Use `--no-rules` to skip loading them for a hermetic run.

## What to check

- Run `veyyon plugin doctor` after install and after changing provider or approval configuration. It
  exits non-zero when a check fails — treat that as a real setup problem.
- Confirm the active `tools.approvalMode` (`/settings` → Advanced → Safety, approval `p`, or the exec
  startup line).
- Reserve `--yolo` for disposable or externally isolated machines, since Veyyon does not contain the
  commands it runs.
- Treat a silent fallback as a bug: if an approval gate or credentials disappeared without a message,
  that is not “working as intended.”

## Risk surfaced in the loop

Risk is not only a startup checkbox:

1. **Before** — policy + sandbox chosen; doctor can verify readiness.
2. **During** — approvals, sandbox denials, repair refusals, and truncated outputs appear in the turn.
3. **After** — turn diffs and (for `veyyon --print --json`) structured events record what ran, what failed,
   and what the final message was.

## Next

- [Configuration](./configuration.md) — set the policies Veyyon will enforce.
- [Sandbox and approvals](../features/sandbox.md) — OS backends, egress, recipes.
- [Editing and repair](./editing.md) — why refused repairs protect your tree.
- [Diagnostics](../features/doctor.md) — diagnostics options and exit status.

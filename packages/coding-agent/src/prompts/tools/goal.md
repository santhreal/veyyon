Create and manage the session's long-running goal.

Use a single `op` field:
- `create` starts a goal from the user's objective. Requires `objective`. Use only when the user asks for persistent goal-mode work and no goal exists.
- `get` returns the current goal (active or paused).
- `resume` re-activates a paused goal so work can continue.
- `complete` marks the goal complete after you have verified every deliverable against current evidence.
- `drop` discards the current goal without completing it.

Call `complete` only when the goal is actually done and verified.
If `get` shows a paused goal, call `resume` before continuing work on it.

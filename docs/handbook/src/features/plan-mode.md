# Plan mode and goals

Plan mode and goal mode are separate engine modes with different tools and continuation behavior. They cannot be active together (and each conflicts with vibe mode).

## Plan mode

Read-focused exploration that drafts a **plan file** before implementation.

### Enabling

- Setting: `plan.enabled` (default `true`; `/settings` Advanced → Plan)
- Slash: `/plan` toggles plan mode; `/plan <prompt>` enters plan mode and submits the prompt
- `/plan-review` reopens plan review while plan mode is active

### Behavior

1. Session selects a plan file path and records plan-mode state.
2. Tool surface adjusts: `resolve` is available for plan approval; plan-file `write`/`edit` may be enabled for drafting.
3. The agent explores and writes the plan (read-oriented work plus plan-file edits).
4. Finalization uses the **`resolve`** tool with plan-approval semantics (`plan_approval`).
5. Exit: `/plan` again (confirmation if a draft exists). Session records `mode` entries in the session file.

When configured, plan mode uses the **`plan` model role**.

## Goal mode

A **persistent objective** on a saved session, with optional auto-continuation when idle.

### Enabling

- Setting: `goal.enabled` (default `true`)
- `/goal set <objective>`: create or replace
- `/goal show`: status, tokens, budget
- `/goal pause` / `/goal resume`
- `/goal drop`: remove
- `/goal budget <N|off>`: token budget
- `/guided-goal`: interview flow before enabling

### Goal state

Stored on the session. Fields include:

```text
id, objective, status, tokenBudget?, tokensUsed, timeUsedSeconds, createdAt, updatedAt
```

Statuses: `active`, `paused`, `budget-limited`, `complete`, `dropped`.

### Goal tool

When goal mode is active, the agent can call the `goal` tool with ops: `create`, `get`, `complete`, `resume`, `drop`. Continuation prompts inject on idle turns per `goal.continuationModes`.

### Example

```console
$ veyyon
```

```text
/goal set Add a --max-time flag to the print-mode runner and document it
```

Use `/goal show` for progress. Pause with `/goal pause`. Complete via the goal tool or `/goal drop`.

Architecture notes: [Goal state](../context/goal-state.md). Sessions: [Sessions](../using/sessions.md).

## Vibe mode

`/vibe` toggles **vibe mode**. The main agent becomes a director with a reduced tool set
(`read`, `vibe_spawn`, `vibe_send`, `vibe_wait`, `vibe_kill`, `vibe_list`) and drives worker CLIs
(`fast` / `good` model lanes) instead of editing files itself.

Mutual exclusion: plan mode, goal mode, and vibe mode cannot run together; the TUI warns if you try
to enter one while another is active.

Permissions: `vibe_spawn` and `vibe_send` are `exec`-level tool calls, so starting a worker or handing
it a new instruction is gated by the session approval mode exactly like running a command (`vibe_wait`,
`vibe_kill`, and `vibe_list` are read-level). Each worker then runs headless with the full tool set
(edit, write, bash, ...) and executes autonomously, a detached subagent has no UI to confirm prompts
against, so approving the spawn is the authorization boundary. Your `tools.approval` allow/deny policies
still apply inside every worker, so path and command denials you have configured are enforced there too.
Workers are killed when you leave vibe mode, so none outlive the director that drives them.

# Plan mode and goals

Veyyon ships **plan mode** and **goal mode** as engine features. They are separate modes with different
tools and continuation behavior.

> **Spec — not shipped:** three enforced chat phases, `<proposed_plan>` cards, `Shift+Tab` collaboration
> cycling, and a `plan_mode_reasoning_effort` config key. Veyyon's plan mode works as described below.

---

## Plan mode (shipped)

Plan mode is read-focused exploration that drafts a **plan file** before you approve implementation.

### Enabling

- Setting: `plan.enabled` (default `true`; toggle in `/settings` Advanced → Plan).
- Slash: `/plan` toggles plan mode; `/plan <prompt>` enters plan mode and submits the prompt.
- Related: `/plan-review` reopens plan review while plan mode is active.

Plan mode blocks **goal mode** and **vibe mode** (and vice versa).

### Behavior

When plan mode is on:

1. Veyyon selects a plan file path (per-session) and sets mode state on the session.
2. Active tools are adjusted: `resolve` is added for plan approval; built-in `write` may be activated so the agent can draft the plan file.
3. The agent explores and writes the plan using read-oriented work plus plan-file `write`/`edit` as configured.
4. Finalization uses the **`resolve`** tool with plan approval semantics (`plan_approval`), not a `<proposed_plan>` XML tag.
5. Exiting: `/plan` again (with confirmation if a draft exists) pauses or disables plan mode; session records `mode` entries in the session file.

Plan mode uses the **`plan` model role** when configured.

---

## Goals (shipped)

Goal mode tracks a **persistent objective** on a saved session and can auto-continue when idle.

### Enabling

- Setting: `goal.enabled` (default `true`).
- Slash commands:
  - `/goal set <objective>` — create or replace goal
  - `/goal show` — status, tokens, budget
  - `/goal pause` / `/goal resume`
  - `/goal drop` — remove goal
  - `/goal budget <N|off>` — token budget
- `/guided-goal` — interview flow before enabling goal mode

Goal mode blocks plan mode and vibe mode.

### Goal state

Stored on the session. Fields include:

```text
id, objective, status, tokenBudget?, tokensUsed, timeUsedSeconds, createdAt, updatedAt
```

Statuses: `active`, `paused`, `budget-limited`, `complete`, `dropped`.

### Goal tool

When goal mode is active, the agent can call the `goal` tool with ops: `create`, `get`, `complete`, `resume`, `drop`. Continuation prompts inject on idle turns per `goal.continuationModes`.

### Walkthrough (real commands)

```console
$ veyyon
```

```text
/goal set Add a --max-time flag to the print-mode runner and document it in the handbook
```

Work in normal mode; use `/goal show` for progress. When blocked, `/goal pause`. When done, the agent should `complete` via the goal tool or you `/goal drop`.

---

## Spec — not shipped (goal card richness)

[Goal state and long sessions](../context/goal-state.md) describes a richer goal card (verification ledger, working-set fields, reviewer carry-forward) as a **future expansion layer**. The shipped card is the bounded objective + budget + status model above.

## See also

- [Sessions](../using/sessions.md) — goals require a persisted session
- [Context: goal state](../context/goal-state.md) — architecture notes

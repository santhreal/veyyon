# Retained coordination and prompt patterns

Product decision. Do not "clean up" the coordination + prompt keepers below. Do not confuse them with
settings UX that was cut (model-selection matrix, role-based routing popups — replaced by the shipped
model-slots-plus-3-knob-compaction design, see [Compaction & project memory](../handbook/src/context/compaction-memory.md)
and [Models, roles, and profiles](../handbook/src/using/roles-and-profiles.md)).

This page is a keep/cut ledger carried forward from the pre-fork planning notes. The keep/cut
*decisions* are sound; the module pointers below have been re-grounded on the real TypeScript tree —
the original notes pointed at an archived Rust/codex layout (`crates/core/src/...`,
`multi_agents_v2`, `RoleModelSetting`) that was never the shipped engine for this product.

## KEEP — coordination + prompts

These are genuinely good patterns. Refactors must preserve behavior.

1. **Handoff / compaction prompt** — `packages/agent/src/compaction/compaction.ts`
   (`renderHandoffPrompt`, `generateHandoffFromContext`), called from
   `packages/coding-agent/src/session/agent-session.ts`. Preserves task continuity across compaction
   when `compaction.type` is `handoff` (the other user-facing type is `snap`; see
   [Compaction & project memory](../handbook/src/context/compaction-memory.md)). Engineering detail:
   [`docs/internal/handoff-generation-pipeline.md`](./handoff-generation-pipeline.md).
2. **Subagent spawn model** — `packages/coding-agent/src/task/executor.ts` (spawn, per-model
   concurrency semaphore, soft output-budget steering notice, background output capture) plus
   `packages/coding-agent/src/task/agents.ts` (bundled subagent definitions) and the `task` tool
   registered in `packages/coding-agent/src/tools/index.ts`.
3. **Addressed inter-agent messaging** — the `irc` tool (`packages/coding-agent/src/tools/irc.ts`,
   bus in `packages/coding-agent/src/irc/bus.ts`): `send`/`wait`/`inbox`/`list` ops, delivery receipts,
   reply-to threading. This is the shipped equivalent of the old point-to-point
   `InterAgentCommunication`/`send_message`/`wait` model — `send` wakes an idle recipient with a real
   turn, revives a parked one via the lifecycle manager, or injects a non-interrupting aside into a
   busy one (the wake-now-vs-defer split the old notes called `steeringQueue`/`followUpQueue`). Parent
   steering-hint prompt text lives in
   `packages/coding-agent/src/prompts/steering/{parent-irc,user-interjection}.md`. A richer IRC-style,
   full multi-agent **dashboard** (channels, not just the message bus) remains **Spec — not shipped**
   (BACKLOG `U4-10`, beyond the `/cockpit` MVP) — the messaging primitive itself is built; the
   dashboard UI around it is not.
4. **Subagent + todo-list interaction model** — the `todo` tool
   (`packages/coding-agent/src/tools/todo.ts`) plus plan-mode guardrails
   (`packages/coding-agent/src/tools/plan-mode-guard.ts`). Agents maintain a checklist across
   multi-step work; this model is frozen and any TUI presentation work extends it without replacing it.

## CUT — confusing settings / model-selection UX

These are **not** keepers. Do not preserve them when condensing settings; they were already replaced by
the shipped model-slots-plus-3-knob-compaction design (see [Compaction & project memory](../handbook/src/context/compaction-memory.md)).

1. **Role-based model-selection matrix and per-role popups.** Superseded by the shipped design: the
   interactive model via `/model`, plain `subagent.model` and `compaction.model` fields in settings.
   `default` is not a model or a role — see `packages/coding-agent/src/config/model-roles.ts` and
   `packages/coding-agent/src/config/model-resolver.ts`.
2. **Silent per-role heuristic routing.** The primary model drives everything unless the plain
   subagent/compaction fields say otherwise; there is no hidden per-role auto-pick behind the scenes.
3. **Overlapping compaction settings UX.** Condensed to three fields: threshold, type
   (`handoff`/`snap`), model — see `packages/coding-agent/src/config/compaction-strategy.ts` and the
   `compaction.*` group in `packages/coding-agent/src/config/settings-schema.ts`. Not a parallel
   model-picker maze.
4. **Hosted Cloud/Ultra task-list backend types.** Out of scope for this product; do not conflate with
   the `todo` tool above.

## Coordination vs settings — the confusion line

| Layer | KEEP or CUT | Where it lives |
| --- | --- | --- |
| How agents are spawned and report back | **KEEP** | `task/executor.ts`, `task` tool |
| How agents message each other directly (send/wait/inbox) | **KEEP** | `tools/irc.ts`, `irc/bus.ts` |
| How agents track work (todo/checklist discipline) | **KEEP** | `tools/todo.ts` + prompt guidance |
| How compaction hands off context | **KEEP** | `packages/agent/src/compaction/compaction.ts` |
| Which model runs for which role (matrix + popups) | **CUT** | Replaced by plain `subagent.model` / `compaction.model` fields |
| Forced role reassignment on model change | **CUT** | `/model` only changes the interactive model |
| Compaction/subagent model popups | **CUT** | Plain settings fields (model tab) |
| Full IRC-style multi-agent dashboard (channels) | **Spec — not shipped** | Tracked as BACKLOG `U4-10`; the messaging tool itself is built |

**Rule for future refactors:** if a change touches subagent spawning, `irc` messaging, or the compaction
handoff prompt, preserve behavior. If it touches model-routing *settings knobs*, follow the shipped
model-slots design above — do not resurrect a role→model matrix because an old fork had one.

*Verified against `7ca44d3` on 2026-07-17.*

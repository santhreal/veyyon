/**
 * The hidden messages a session steers into the model's context, and the gates
 * that decide when each one fires.
 *
 * A hidden nudge is a `CustomMessage` with `display: false`: the model reads it,
 * the TUI and the transcript never show it. Each kind is told apart by its
 * `customType` string alone, and some are scrubbed from the context later by
 * matching that string, so two kinds sharing one value means a scrub aimed at
 * the first deletes the second. {@link HIDDEN_MESSAGE_TYPES} is what makes the
 * set checkable rather than a scatter of literals down a 20,000-line file.
 */

import { TOOL } from "../tools/core/builtin-names";

/** Hidden mid-run reconciliation hint, sent when landed work outruns the todo list. */
export const MID_RUN_TODO_NUDGE_MESSAGE_TYPE = "mid-run-todo-nudge";

/**
 * Carries the memory backend's volatile context (recalled memories, mental
 * models) at the TAIL of the conversation rather than in the system prompt,
 * which is the provider's cache prefix: a recall or a mental-model reload there
 * makes the next request re-read the whole conversation as uncached input.
 */
export const MEMORY_CONTEXT_MESSAGE_TYPE = "memory-context";

/**
 * Carries the two facts that describe now rather than the project: the calendar
 * date and the working directory.
 *
 * Both used to sit in the project block of the system prompt, and the working
 * directory is the one value in that cache prefix a session routinely changes.
 * Measured on this repository, a re-root from the root to `packages/utils`
 * altered exactly one line of a 92,921-character prompt — that sentence — and
 * discarded the cached prefix for the whole conversation behind it; across 19
 * local log files, 210 of 232 recorded prefix invalidations were a
 * `cwd-change`, averaging about 85,000 characters re-read for a path that had
 * moved a directory down. The rebuild on re-root stays, because rules, skills
 * and the workspace tree really are cwd-derived; a move that alters nothing but
 * the path now rebuilds to byte-identical bytes, so there is no invalidation to
 * record.
 */
export const SESSION_STATE_MESSAGE_TYPE = "session-state";

/** Hidden plan nudge injected by prewalk; scrubbed from the context at the switch. */
export const PREWALK_PLAN_MESSAGE_TYPE = "prewalk-plan";

/**
 * Hidden safety net forcing one more turn after a text-only reply to the plan
 * nudge, which would otherwise end the run with no code written.
 */
export const PREWALK_CONTINUE_MESSAGE_TYPE = "prewalk-continue";

/**
 * Hidden verify-before-finishing checklist steered in at the switch, aimed at
 * the fast model's failure patterns: partial multi-site fixes, unnecessarily
 * broad rewrites, and reported-test-only verification.
 */
export const PREWALK_CHECKLIST_MESSAGE_TYPE = "prewalk-checklist";

/**
 * Hidden hand-off steered to the target model once PlanYolo auto-approves the
 * plan. Unlike prewalk's plan nudge it is never scrubbed: it is the instruction
 * the target model acts on.
 */
export const PLAN_YOLO_HANDOFF_MESSAGE_TYPE = "plan-yolo-handoff";

/** Hidden tool-call reminder injected after the Gemini reasoning-header interrupt. */
export const GEMINI_TOOL_REMINDER_TYPE = "gemini-tool-call-reminder";

/**
 * Hidden redirect injected into a turn retried after a thinking/response loop,
 * steering the model off the repeated content.
 */
export const THINKING_LOOP_REDIRECT_TYPE = "thinking-loop-redirect";

/** Hidden redirect injected into a turn retried after a repeated tool call. */
export const TOOL_CALL_LOOP_REDIRECT_TYPE = "tool-call-loop-redirect";

/**
 * Every hidden `customType` this module declares.
 *
 * A new hidden kind is added here as well as above. The registry is what a test
 * sweeps to prove the values are distinct, and a kind left out of it is a kind
 * no collision check covers.
 */
export const HIDDEN_MESSAGE_TYPES: readonly string[] = Object.freeze([
	MID_RUN_TODO_NUDGE_MESSAGE_TYPE,
	MEMORY_CONTEXT_MESSAGE_TYPE,
	SESSION_STATE_MESSAGE_TYPE,
	PREWALK_PLAN_MESSAGE_TYPE,
	PREWALK_CONTINUE_MESSAGE_TYPE,
	PREWALK_CHECKLIST_MESSAGE_TYPE,
	PLAN_YOLO_HANDOFF_MESSAGE_TYPE,
	GEMINI_TOOL_REMINDER_TYPE,
	THINKING_LOOP_REDIRECT_TYPE,
	TOOL_CALL_LOOP_REDIRECT_TYPE,
]);

/** Consecutive automatic continuations one prompt may schedule before the session stops. */
export const SESSION_STOP_CONTINUATION_CAP = 8;

/** Plan-mode reminders one prompt cycle may send. */
export const PLAN_MODE_REMINDER_MAX = 3;

/** Tools whose call ends plan mode by deciding it, rather than continuing to plan. */
export const PLAN_DECISION_TOOLS: ReadonlySet<string> = new Set<string>([TOOL.ask, TOOL.resolve]);

/**
 * Mutating tool results without the model touching `todo` that trip the mid-run
 * reconciliation nudge. Read-only exploration never ticks this: a long research
 * stretch has nothing to flip. Set so a normal fix-verify loop of three to six
 * mutations never sees the nudge, but a sustained run of landed work with no
 * todo flipped does, rather than driving the live todo HUD to `0/N` until the
 * final stop and then batch-flipping to `N/N` (#3651).
 */
export const MID_RUN_TODO_NUDGE_MUTATION_THRESHOLD = 12;

/**
 * Mid-run nudges per prompt cycle. Tighter than `todo.reminders.max`, the
 * stop-time budget: this is a hidden hint, not an escalation ladder.
 */
export const MID_RUN_TODO_NUDGE_MAX_PER_CYCLE = 2;

/** Tool results that count as landed work for the mid-run todo nudge. */
export const MID_RUN_TODO_NUDGE_MUTATING_TOOLS: Readonly<Record<string, true>> = {
	[TOOL.bash]: true,
	[TOOL.eval]: true,
	[TOOL.edit]: true,
	[TOOL.write]: true,
	[TOOL.ast_edit]: true,
};

/**
 * Tools whose first successful call triggers the prewalk switch, once the todo
 * gate is open. `bash` is excluded because it doubles as exploration and fired
 * turn-1 switches in practice; `todo` is excluded because firing at todo init
 * handed the fast model the whole implementation with no work started, and
 * measurably lowered pass rates.
 */
export const PREWALK_ACTION_TOOLS: Readonly<Record<string, true>> = {
	[TOOL.edit]: true,
	[TOOL.write]: true,
};

/**
 * The todo board and the three pressures that keep it honest.
 *
 * This is a session collaborator. It owns the recorded phases and every counter
 * and latch that decides whether the model is nudged about them, and reaches the
 * session only through {@link TodoRuntimeHost}. The nine state fields used to sit
 * among two hundred others on `AgentSession`, where nothing said they moved
 * together — and they very much do: {@link setPhases} clears two of them,
 * {@link resetForNewContext} clears seven, and the failure latch silences all
 * three pressures at once.
 *
 * Three distinct mechanisms, deliberately not folded into one:
 *
 * - **The eager prelude** ({@link eagerPrelude}) runs once, on the first user
 *   message, and asks for a list to exist at all.
 * - **The mid-run nudge** ({@link takeMidRunNudge}) is a hidden model-only hint
 *   fired mid-turn after enough landed work with no `todo` call, so the live HUD
 *   tracks progress instead of flipping `0/N -> N/N` at the very end (issue #3651).
 * - **The stop-time reminder** ({@link checkCompletionAtSettle}) is the
 *   user-visible escalation ladder, with its own budget, its own event and its own
 *   fingerprint suppression.
 *
 * One rule binds all three: the board is only as trustworthy as the last write
 * that landed. While {@link #lastFailureText} is set, none of them may assert a
 * count off the recorded phases.
 */
import type { AgentMessage } from "@veyyon/agent-core";
import type { Api, Message, Model, ToolChoice } from "@veyyon/ai";
import type { SessionEntry } from "@veyyon/kernel/session/session-entries";
import { mayContinueAtSettle, type SettleContinuationState } from "@veyyon/kernel/session/settle-continuation";
import { logger, prompt } from "@veyyon/utils";
import { turnControlPrompts } from "../../prompts/turn-control/rows";
import { TOOL } from "../../tools/builtin-names";
import { getLatestTodoPhasesFromEntries, type TodoPhase } from "../../tools/todo";
import { buildNamedToolChoice } from "../../utils/tool-choice";
import { MID_RUN_TODO_NUDGE_MESSAGE_TYPE, toolCallOpFromMessage } from "../agent-session-message-shapes";
import { getStringProperty } from "../agent-session-permissions";
import type { AgentSessionEvent, ScheduledAgentContinueOptions } from "../agent-session-types";
import { getLatestCompactionEntry } from "../session-context";
import { incompleteTodoItems, renderTodoContinuationReminder, todoReminderFingerprint } from "../todo-reminder";

/**
 * Mutating tool results (`bash`/`eval`/`edit`/`write`/`ast_edit`) without the
 * agent touching the `todo` tool that trip the mid-run reconciliation nudge.
 * Read-only exploration (search/read/lsp) never ticks this: an agent
 * researching for a long stretch has nothing to flip. Picked so a normal
 * fix-verify loop (~3-6 mutations) never sees the nudge, but a sustained run
 * of landed work without flipping any todos does. Without this nudge, long
 * runs drive the live todo HUD to `0/N` until the final stop, then batch-flip
 * to `N/N` (issue #3651).
 */
const MID_RUN_TODO_NUDGE_MUTATION_THRESHOLD = 12;
/** Mid-run nudges per prompt cycle. Deliberately tighter than
 *  `todo.reminders.max` (the stop-time budget): this is a gentle hidden hint,
 *  not an escalation ladder. */
const MID_RUN_TODO_NUDGE_MAX_PER_CYCLE = 2;
/** Tool results that count as landed work for the mid-run todo nudge. */
const MID_RUN_TODO_NUDGE_MUTATING_TOOLS: Record<string, true> = {
	bash: true,
	eval: true,
	edit: true,
	write: true,
	ast_edit: true,
};

/**
 * The slice of the agent loop the todo pressures drive. `Agent` satisfies this
 * structurally.
 *
 * Two names, because that is all this subsystem does to the loop: read the
 * transcript back to recover a `todo` call's `op`, and append the stop-time
 * reminder. Naming `Agent` instead would make the collaborator unconstructible
 * without the whole loop behind it.
 */
export interface TodoAgent {
	readonly state: {
		readonly messages: readonly AgentMessage[];
	};
	appendMessage(message: AgentMessage): void;
}

/** The slice of the session log the todo pressures read and append to.
 *  `SessionManager` satisfies this. */
export interface TodoSessionStore {
	getBranch(): SessionEntry[];
	appendMessage(message: Message): void;
}

/**
 * The four `todo.*` settings, read together.
 *
 * A snapshot rather than a `Settings` handle: the whole configuration surface is
 * far wider than this subsystem, and the four values are read at four different
 * points in one decision, so a test that wants "reminders on, eager off" says so
 * in one literal.
 */
export interface TodoSettingsSnapshot {
	/** `todo.enabled` — the master switch for the whole subsystem. */
	enabled: boolean;
	/** `todo.reminders` — the stop-time ladder and the mid-run nudge. */
	reminders: boolean;
	/** `todo.reminders.max` — the stop-time escalation budget. */
	remindersMax: number;
	/** `todo.eager` — whether a first-turn list is suggested, forced, or neither. */
	eager: "default" | "preferred" | "always";
}

/**
 * What {@link TodoRuntime} needs from the session that owns it.
 *
 * Thirteen names, none of them a class the session happens to hold. Three of the
 * predicates exist because a pressure must stand down for another continuation
 * owner: plan mode runs its own remind/cap/yield ladder, goal mode is the sole
 * autonomous continuation owner while active, and a pending async wake means the
 * loop is already coming back.
 */
export interface TodoRuntimeHost {
	readonly agent: TodoAgent;
	readonly sessionStore: TodoSessionStore;
	/** The four `todo.*` settings as of now. Read at call time: a setting written
	 *  mid-session must take effect on the next decision, not the next session. */
	todoSettings(): TodoSettingsSnapshot;
	/** Current model, which decides whether a named `tool_choice` can be forced. */
	model(): Model<Api> | undefined;
	/** Plan mode owns convergence; todo pressures stand down while it is on. */
	planModeEnabled(): boolean;
	/** Goal mode is the sole autonomous continuation owner while a goal is active. */
	goalModeActive(): boolean;
	/** Tools actually exposed to the model this turn. Wider than the registry:
	 *  discovery can register `todo` while hiding it, and forcing an inactive tool
	 *  makes the provider reject the request. */
	activeToolNames(): string[];
	/** Wire names and task-batch flag shared by every prelude prompt. */
	eagerPreludeContext(): { toolRefs: Record<string, string>; taskBatch: boolean };
	/** Consume the tool-choice label served to the turn that just ended. Consumed
	 *  even when the reminder is skipped, or it leaks onto the next turn. */
	consumeLastServedToolChoiceLabel(): string | undefined;
	/** Whether a background job will re-wake the loop, making this stop a pause. */
	hasPendingAsyncWake(): boolean;
	emitSessionEvent(event: AgentSessionEvent): Promise<void>;
	scheduleAgentContinue(options: ScheduledAgentContinueOptions): void;
	/** Prompt generation a scheduled continuation must still match to be valid. */
	promptGeneration(): number;
}

export class TodoRuntime {
	readonly #host: TodoRuntimeHost;
	/** True once any successful `todo` call landed — opens the prewalk
	 *  trigger gate: the switch fires at the first edit/write AFTER the todo
	 *  list exists (sessions without a todo tool skip the gate). */
	#prewalkSeen = false;
	#reminderCount = 0;
	/**
	 * Set after a reminder is appended and cleared only by tool-level progress or
	 * a changed todo snapshot. A user correction does not clear it: otherwise
	 * repeated "continue" prompts replay the same reminder payload.
	 */
	#awaitingProgress = false;
	/** Fingerprint of the last rendered incomplete state; unchanged retries omit the list. */
	#lastFingerprint: string | undefined = undefined;
	/**
	 * Error text of the most recent `todo` result that failed, cleared by the
	 * next one that succeeds. While it is set the board write never landed, so
	 * the recorded phases describe a state the session cannot vouch for and no
	 * reminder may assert a count from them.
	 *
	 * Cleared with the reminder counters at every lifecycle boundary that starts
	 * a new context (new session, `/clear`, resume, handoff): the latch names one
	 * specific write against one specific board, and those boundaries replace the
	 * board, so carrying it across is a claim about a transcript that is gone.
	 * Without that reset one failure disabled todo continuation pressure for the
	 * rest of the process, and the repeated-failure instruction tells the model to
	 * stop calling `todo`, so no later success would ever clear it.
	 *
	 * Deliberately NOT expired on a turn count or a timer. The latch is not a
	 * cooldown; it records that the board is unverified, and nothing but a landed
	 * write or a discarded board makes it verified again. Ageing it out would just
	 * resume asserting "you stopped with N incomplete items" from the same stale
	 * phases, which is the false statement the suppression exists to prevent.
	 */
	#lastFailureText: string | undefined = undefined;
	/**
	 * Id of the newest `compaction` entry ON THE ACTIVE BRANCH at the moment a
	 * stop-time reminder last echoed the full todo list, `null` when the branch
	 * held none, and `undefined` before the first echo of this session.
	 *
	 * The compaction entry is the boundary of the model's current context
	 * window, and every path that compacts (manual `/compact`, and idle,
	 * threshold, overflow and incomplete auto-compaction, which all funnel
	 * through one `appendCompaction` call) persists one, so this is the signal a
	 * per-window latch should key off rather than a turn count. A differing id
	 * means the previous echo scrolled out of context and the next reminder may
	 * spend a fresh echo. Cleared with the reminder counters at every lifecycle
	 * boundary that starts a new window (new session, handoff, reminders
	 * re-enabled), since the latch describes one window only.
	 */
	#echoCompactionId: string | null | undefined = undefined;
	/**
	 * Successful mutating tool results (bash/eval/edit/write/ast_edit) since the
	 * agent last touched the `todo` tool. Drives {@link takeMidRunNudge} so
	 * the live HUD stays in sync with actual progress instead of flipping
	 * `0/N -> N/N` only at the very end of a long run (issue #3651). Read-only
	 * tools and errored results never tick it. Reset to 0 on any `todo` tool
	 * result, on a nudge fire (cooldown), on a stop-time reminder, and at every
	 * new-prompt / clear / handoff lifecycle boundary.
	 */
	#mutationsSinceTouch = 0;
	/** Mid-run nudges fired this prompt cycle; capped by
	 *  {@link MID_RUN_TODO_NUDGE_MAX_PER_CYCLE}, reset with the counter above. */
	#midRunNudgeCount = 0;
	#phases: TodoPhase[] = [];

	constructor(host: TodoRuntimeHost) {
		this.#host = host;
	}

	// ---------------------------------------------------------------- the board

	phases(): TodoPhase[] {
		return this.clonePhases(this.#phases);
	}

	setPhases(phases: TodoPhase[]): void {
		const nextPhases = this.clonePhases(phases);
		const previous = todoReminderFingerprint(incompleteTodoItems(this.#phases));
		const next = todoReminderFingerprint(incompleteTodoItems(nextPhases));
		this.#phases = nextPhases;
		if (previous !== next) {
			if (previous === "[]" || next === "[]") this.#reminderCount = 0;
			this.#awaitingProgress = false;
			this.#lastFingerprint = undefined;
		}
	}

	/** Adopt the board recorded on the active branch, which is authoritative after
	 *  any move that changes which entries the model sees (resume, rewind, branch
	 *  switch, compaction). */
	syncFromBranch(): void {
		this.setPhases(getLatestTodoPhasesFromEntries(this.#host.sessionStore.getBranch()));
	}

	clonePhases(phases: TodoPhase[]): TodoPhase[] {
		return phases.map(phase => ({
			name: phase.name,
			tasks: phase.tasks.map(task => ({ content: task.content, status: task.status })),
		}));
	}

	// ------------------------------------------------------------- state pokes

	/**
	 * Drop every piece of todo-reminder state that describes the context being
	 * left. Called from each boundary that starts a new one: `newSession`
	 * (`/new` and `/clear` both route through it), handoff, and resume.
	 *
	 * One function rather than four copies of the same five assignments, because
	 * the copies were what let {@link #lastFailureText} survive a `/new`: it
	 * was added later and never appeared in any of them, so a single failed todo
	 * write silenced every reminder for the rest of the process.
	 */
	resetForNewContext(): void {
		this.#reminderCount = 0;
		this.#awaitingProgress = false;
		this.#lastFingerprint = undefined;
		this.#echoCompactionId = undefined;
		this.#lastFailureText = undefined;
		this.#mutationsSinceTouch = 0;
		this.#midRunNudgeCount = 0;
	}

	/**
	 * Disabling either half of the todo-reminder feature is an explicit lifecycle
	 * boundary. Reset synchronously with the effective setting write rather than
	 * waiting for a later `agent_end`: there may be no stop while disabled, and a
	 * stale self-continuation latch would otherwise survive disable/re-enable and
	 * silence the fresh runway.
	 */
	onRemindersDisabled(): void {
		this.#reminderCount = 0;
		this.#awaitingProgress = false;
		this.#lastFingerprint = undefined;
		this.#echoCompactionId = undefined;
	}

	/** A new user prompt starts a fresh mid-run runway. It deliberately does NOT
	 *  reset stop-time suppression: replaying the same unfinished list after each
	 *  "continue" correction floods context. */
	onNewPrompt(): void {
		this.#mutationsSinceTouch = 0;
		this.#midRunNudgeCount = 0;
	}

	/** Tool-level action counts as progress, clearing the self-continuation latch. */
	noteToolProgress(): void {
		this.#awaitingProgress = false;
	}

	/**
	 * Count landed work toward the mid-run nudge. Keyed on the tool RESULT (not the
	 * assistant `toolCall` turn) so planned-but-aborted or permission-denied calls
	 * never count, and only successful mutating tools tick — read-only exploration
	 * is not progress an agent could mark done.
	 */
	onToolResultLanded(toolName: string, isError: boolean | undefined): void {
		if (toolName === TOOL.todo) {
			this.#mutationsSinceTouch = 0;
		} else if (!isError && MID_RUN_TODO_NUDGE_MUTATING_TOOLS[toolName]) {
			this.#mutationsSinceTouch++;
		}
	}

	/** True once a `todo` result landed this session. Gates the prewalk trigger:
	 *  the model-switch fires at the first edit/write AFTER a list exists. */
	get sawTodoTool(): boolean {
		return this.#prewalkSeen;
	}

	noteTodoToolResult(): void {
		this.#prewalkSeen = true;
	}

	/** Whether the `todo` call identified by `details`/`toolCallId` was an `init`,
	 *  recovered from the transcript when the result did not carry the op. */
	isInitResult(details: Record<string, unknown>, toolCallId: string | undefined): boolean {
		const detailOp = getStringProperty(details, "op");
		if (detailOp) return detailOp === "init";
		if (!toolCallId) return false;
		for (let i = this.#host.agent.state.messages.length - 1; i >= 0; i--) {
			const message = this.#host.agent.state.messages[i];
			if (!message) continue;
			const op = toolCallOpFromMessage(message, toolCallId);
			if (op) return op === "init";
		}
		return false;
	}

	/**
	 * Record whether a `todo` write landed, and return the `<system-reminder>` the
	 * model should be told when it did not. `undefined` for a landed write, which
	 * also makes the board authoritative again.
	 *
	 * Returns the text rather than sending it: delivery is a session concern (it
	 * rides `sendCustomMessage` with `deliverAs: "nextTurn"`), while the latch and
	 * the repeated-failure wording are this subsystem's.
	 */
	recordWriteOutcome(errorText: string | undefined): string | undefined {
		if (errorText === undefined) {
			this.#lastFailureText = undefined;
			return undefined;
		}
		const repeated = errorText === this.#lastFailureText;
		this.#lastFailureText = errorText;
		return [
			"<system-reminder>",
			"todo failed, so todo progress is not visible to the user and the recorded board may be stale.",
			errorText ? `Failure: ${errorText}` : "Failure: todo returned an error.",
			// Repeating "call todo again" after an identical failure asks for a
			// call that already proved impossible, and each attempt costs a turn.
			repeated
				? "This is the same failure as the previous todo call, so retrying that payload cannot succeed. Treat todo as unusable for the rest of this turn and continue the work without it."
				: "Fix the todo payload and call todo again before continuing.",
			"</system-reminder>",
		].join("\n");
	}

	// -------------------------------------------------------------- the eager prelude

	eagerPrelude(promptText: string | undefined): { message: AgentMessage; toolChoice?: ToolChoice } | undefined {
		const { eager: mode, enabled: todosEnabled } = this.#host.todoSettings();
		if (mode === "default" || !todosEnabled) {
			return undefined;
		}

		if (this.#host.planModeEnabled()) {
			return undefined;
		}
		if (this.#phases.length > 0) {
			return undefined;
		}

		// Only inject on the first user message of the conversation. Subsequent user
		// turns must not receive the eager todo reminder — they often correct, clarify,
		// or redirect the prior task, and forcing a brand-new todo list there is wrong.
		// When `promptText` is undefined (post-compaction re-injection) there is no fresh
		// user message to gate on, so skip the first-message and prompt-suffix checks.
		if (promptText !== undefined) {
			const hasPriorUserMessage = this.#host.agent.state.messages.some(m => m.role === "user");
			if (hasPriorUserMessage) {
				return undefined;
			}

			const trimmedPromptText = promptText.trimEnd();
			if (trimmedPromptText.endsWith("?") || trimmedPromptText.endsWith("!")) {
				return undefined;
			}
		}

		// Must check the active tool set, not just the registry: tool discovery
		// (tools.discoveryMode === "all") can register `todo` while hiding it from
		// the exposed tools. Forcing a named tool_choice for an inactive tool makes
		// the provider reject the request (HTTP 400).
		const activeToolNames = this.#host.activeToolNames();
		if (!activeToolNames.includes(TOOL.todo)) {
			logger.warn("Eager todo enforcement skipped because todo is not active", { activeToolNames });
			return undefined;
		}

		const message: AgentMessage = {
			role: "custom",
			customType: "eager-todo-prelude",
			content: prompt.render(turnControlPrompts["turn-control/eager-todo"].text, {
				...this.#host.eagerPreludeContext(),
				forced: mode === "always",
			}),
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
		// `preferred` suggests a todo list (reminder only); `always` also forces the
		// `todo` tool on the first turn — the previous boolean-on behavior. Post-compaction
		// re-injection (`promptText === undefined`) is always reminder-only: forcing a tool
		// onto the auto-resumed turn would override the agent's in-flight action.
		if (promptText === undefined || mode === "preferred") {
			return { message };
		}
		const model = this.#host.model();
		const todoToolChoice = buildNamedToolChoice(TOOL.todo, model);
		if (!todoToolChoice) {
			// `always` on a model that can't be forced degrades to reminder-only (no
			// tool_choice). For `todo.eager: true` users migrated to `always`, such
			// models now receive the first-turn reminder where they previously got
			// nothing (see the CHANGELOG entry); `always ⊇ preferred` is preserved.
			logger.warn(
				"Eager todo proceeding with the reminder only because the current model does not support a forced todo tool_choice",
				{ modelApi: model?.api, modelId: model?.id },
			);
			return { message };
		}
		return { message, toolChoice: todoToolChoice };
	}

	// ------------------------------------------------------- the stop-time reminder

	/**
	 * Check if agent stopped with incomplete todos and prompt to continue.
	 *
	 * `settleState` carries the tail's single reading of "waiting on the user".
	 * This runs even when that hold is set, because the first statement consumes
	 * the served tool-choice label and skipping the call would leak it onto the
	 * next turn.
	 */
	async checkCompletionAtSettle(settleState: SettleContinuationState): Promise<boolean> {
		// Skip todo reminders when the most recent turn was driven by an explicit user force —
		// the user wanted exactly that tool, not a follow-up nag about incomplete todos.
		const lastServedLabel = this.#host.consumeLastServedToolChoiceLabel();
		if (lastServedLabel === "user-force") {
			return false;
		}

		const { reminders: remindersEnabled, enabled: todosEnabled, remindersMax } = this.#host.todoSettings();
		if (!remindersEnabled || !todosEnabled) {
			this.onRemindersDisabled();
			return false;
		}

		// Plan mode owns convergence via #enforcePlanModeDecisionAtSettle (remind →
		// cap → yield). Todo reminders must not re-wake a turn the cap intends to
		// yield to the user. The label is already consumed above, so no leak.
		if (this.#host.planModeEnabled()) {
			return false;
		}

		// Goal mode is the sole autonomous continuation owner while active. A
		// stop-time todo reminder would append a second continuation prompt and
		// race the goal continuation scheduled by the interactive mode.
		if (this.#host.goalModeActive()) {
			return false;
		}

		// Suppress within a self-continuation chain: if the agent's last turn was driven by a
		// prior reminder (and the agent took no tool-level action since), do not re-ping.
		// The agent has already acknowledged; further escalation just wastes context and
		// pressures the agent into busy-work or destructive ops (issue #2590).
		if (this.#awaitingProgress) {
			logger.debug("Todo completion: prior reminder still awaiting agent action; staying silent", {
				attempt: this.#reminderCount,
			});
			return false;
		}

		if (this.#reminderCount >= remindersMax) {
			logger.debug("Todo completion: max reminders reached", { count: this.#reminderCount });
			return false;
		}

		// The board is only as trustworthy as the last write that landed. After a
		// failed `todo` call the recorded phases are whatever survived from before
		// it, so "you stopped with N incomplete todo item(s)" would assert a count
		// the session never recorded. The todo-error reminder already told the
		// model the board may be stale; say nothing further.
		if (this.#lastFailureText !== undefined) {
			logger.debug("Todo completion: last todo write failed, board state unknown; staying silent");
			return false;
		}

		const incomplete = incompleteTodoItems(this.#phases);
		if (incomplete.length === 0) {
			this.#reminderCount = 0;
			this.#awaitingProgress = false;
			this.#lastFingerprint = undefined;
			return false;
		}

		if (!mayContinueAtSettle("todo-reminder", settleState)) {
			logger.debug("Todo completion: assistant is waiting for user input; skipping reminder", {
				incomplete: incomplete.length,
			});
			return false;
		}

		// Background async jobs (bash/task) owned by this agent re-wake the loop
		// when they complete: the result delivery enqueues an async-result
		// follow-up that continues the run, and todos are re-evaluated at that
		// settle. A stop with such a job in flight is a scheduling pause, not
		// abandonment, so stay silent instead of injecting duplicate context.
		if (this.#host.hasPendingAsyncWake()) {
			logger.debug("Todo completion: async jobs in flight will re-wake the loop; skipping reminder", {
				incomplete: incomplete.length,
			});
			return false;
		}

		const fingerprint = todoReminderFingerprint(incomplete);
		if (fingerprint === this.#lastFingerprint) {
			this.#awaitingProgress = true;
			logger.debug("Todo completion: unchanged todo state already reminded; staying silent", {
				incomplete: incomplete.length,
				attempt: this.#reminderCount,
			});
			return false;
		}

		this.#reminderCount++;
		// One full-list echo per context window. The list is worth repeating once
		// after a compaction boundary, because the model may no longer see it;
		// repeating it on every escalation inside one window is pure duplication.
		//
		// Read off the ACTIVE BRANCH, not every persisted entry: a rewind leaves
		// the abandoned path's compaction entry in the file while the model's
		// context is rebuilt without it. Keying on the file would hold the latch
		// at an id that is no longer in the window, and the echo would never come
		// back for the rest of the session.
		const compactionBoundary = getLatestCompactionEntry(this.#host.sessionStore.getBranch())?.id ?? null;
		const echoFullList = this.#echoCompactionId !== compactionBoundary;
		const reminder = renderTodoContinuationReminder({
			items: incomplete,
			attempt: this.#reminderCount,
			maxAttempts: remindersMax,
			echoFullList,
		});
		// Spent only when a list actually goes out, so a suppressed reminder
		// leaves the allowance intact.
		if (echoFullList) this.#echoCompactionId = compactionBoundary;
		// Reserve before awaiting event subscribers so overlapping agent_end events
		// cannot both emit the same reminder.
		this.#lastFingerprint = fingerprint;
		this.#awaitingProgress = true;

		logger.debug("Todo completion: sending reminder", {
			incomplete: incomplete.length,
			attempt: this.#reminderCount,
		});

		// Emit event for UI to render notification
		await this.#host.emitSessionEvent({
			type: "todo_reminder",
			todos: incomplete.map(({ content, status }) => ({ content, status })),
			attempt: this.#reminderCount,
			maxAttempts: remindersMax,
		});

		const reminderMessage: Message = {
			role: "developer",
			content: [{ type: "text", text: reminder }],
			attribution: "agent",
			timestamp: Date.now(),
		};

		// A stop-time reminder starts a fresh reminder runway. Without resetting
		// the mid-run counter here, a run that stopped just below the threshold
		// would spend its stale pre-reminder count and fire "Mid-run reminder 2/3"
		// after only a little post-reminder work.
		this.#mutationsSinceTouch = 0;
		// Inject reminder and persist it so the JSONL transcript matches model context.
		this.#host.agent.appendMessage(reminderMessage);
		this.#host.sessionStore.appendMessage(reminderMessage);
		this.#host.scheduleAgentContinue({ generation: this.#host.promptGeneration() });
		return true;
	}

	// ----------------------------------------------------------- the mid-run nudge

	/**
	 * Build the next mid-run todo reconciliation nudge when the agent has landed
	 * {@link MID_RUN_TODO_NUDGE_MUTATION_THRESHOLD} mutating tool results without
	 * invoking the `todo` tool and incomplete items remain. Returns the hidden
	 * (`display: false`) custom message when it should fire, or `null` to skip.
	 * Called once per turn via the aside provider; mutates internal counters when
	 * it fires so the caller does not need to track delivery state.
	 *
	 * Deliberately a SEPARATE concept from {@link checkCompletionAtSettle}'s
	 * stop-time reminder: this is a gentle model-only hint (no `todo_reminder`
	 * event, no TUI render, no escalation counter, own per-cycle budget), while
	 * the stop-time reminder is the user-visible escalation ladder. Without this
	 * nudge, long runs drive the live HUD to `0/N` until the final stop, then
	 * batch-flip to `N/N` (issue #3651).
	 */
	takeMidRunNudge(): AgentMessage | null {
		if (this.#mutationsSinceTouch < MID_RUN_TODO_NUDGE_MUTATION_THRESHOLD) return null;
		if (this.#midRunNudgeCount >= MID_RUN_TODO_NUDGE_MAX_PER_CYCLE) return null;
		const { enabled, reminders } = this.#host.todoSettings();
		if (!enabled) return null;
		if (!reminders) return null;
		// Plan-mode runs are authoring a plan file, not implementing it; todos
		// don't apply, mirroring {@link eagerPrelude}.
		if (this.#host.planModeEnabled()) return null;
		// Tool discovery / explicit active-tool lists can hide `todo` from this
		// run while `todo.enabled` remains true (e.g. `setActiveToolsByName`
		// restricting the slate). Mirror {@link eagerPrelude}'s guard so we
		// never ask the model to call a tool that is not in its schema — the
		// request would fabricate an unknown tool call.
		if (!this.#host.activeToolNames().includes(TOOL.todo)) return null;
		// A failed `todo` write leaves the recorded board unverified, so counting
		// "incomplete items" off it would nudge about work the session cannot
		// confirm is outstanding. Same honesty rule as the stop-time reminder.
		if (this.#lastFailureText !== undefined) return null;

		const incomplete = this.#phases
			.flatMap(phase => phase.tasks)
			.filter(task => task.status === "pending" || task.status === "in_progress");
		if (incomplete.length === 0) return null;

		// Reset the mutation counter so the nudge has another full runway before
		// the next fire; #midRunNudgeCount caps total nudges per prompt cycle.
		this.#mutationsSinceTouch = 0;
		this.#midRunNudgeCount++;

		const { toolRefs } = this.#host.eagerPreludeContext();
		const reminder = prompt.render(turnControlPrompts["turn-control/mid-run-todo-nudge"].text, {
			toolRefs,
			incompleteCount: incomplete.length,
			plural: incomplete.length !== 1,
		});

		logger.debug("Mid-run todo nudge fired", {
			incomplete: incomplete.length,
			nudge: this.#midRunNudgeCount,
		});

		return {
			role: "custom",
			customType: MID_RUN_TODO_NUDGE_MESSAGE_TYPE,
			content: reminder,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
	}
}

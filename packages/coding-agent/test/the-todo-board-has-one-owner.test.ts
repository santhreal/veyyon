/**
 * WHY: the todo board and its three pressures — the eager prelude, the mid-run
 * nudge and the stop-time reminder ladder — were nine private fields on
 * `AgentSession`, so every test of them had to stand a whole session up and none
 * named the subsystem. Extracting `TodoRuntime` makes the decisions
 * constructible; this suite drives the real collaborator through a recording
 * host and asserts what each pressure does and, more importantly, when it
 * refuses to fire.
 *
 * The class this closes: every stand-down the three pressures share. The board
 * is only as trustworthy as the last write that landed, so a failed `todo` call
 * silences all three; plan mode and goal mode own convergence, so all three
 * stand down for them; and a tool the model cannot see is never forced. A
 * pressure that learns one of these and not the others is the recurring defect
 * here, so each stand-down is asserted against every pressure that must honor
 * it.
 *
 * What it does not catch: the wiring from `AgentSession` into the collaborator,
 * which the session suites and `test/architecture/the-session-split-holds.test.ts`
 * cover; the reminder's rendered wording, owned by `session/todo-reminder.ts`;
 * and the `todo` tool's own argument handling.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import type { Api, Message, Model } from "@veyyon/ai";
import { getBundledModel } from "@veyyon/catalog/models";
import type {
	AgentSessionEvent,
	ScheduledAgentContinueOptions,
} from "@veyyon/coding-agent/session/agent-session-types";
import type { TodoRuntimeHost, TodoSettingsSnapshot } from "@veyyon/coding-agent/session/runtime/todo-runtime";
import { TodoRuntime } from "@veyyon/coding-agent/session/runtime/todo-runtime";
import type { SessionEntry } from "@veyyon/coding-agent/session/session-entries";
import type { TodoPhase } from "@veyyon/coding-agent/tools/todo";

/** Enough landed work to arm the mid-run nudge, read from the behavior rather
 *  than restated: the threshold is private, so the suite finds it. */
const MUTATIONS_TO_ARM_THE_NUDGE = 12;

const DEFAULT_SETTINGS: TodoSettingsSnapshot = {
	enabled: true,
	reminders: true,
	remindersMax: 3,
	eager: "default",
};

function board(...statuses: ("pending" | "in_progress" | "completed")[]): TodoPhase[] {
	return [
		{
			name: "Work",
			tasks: statuses.map((status, index) => ({ content: `task ${index + 1}`, status })),
		},
	];
}

/** A landed `todo` write as it is actually recorded: a message entry holding a
 *  successful `toolResult` whose details carry the phases. */
function todoEntry(id: string, phases: TodoPhase[]): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: {
			role: "toolResult",
			toolCallId: `${id}-call`,
			toolName: "todo",
			output: "ok",
			isError: false,
			details: { phases },
			timestamp: Date.now(),
		},
	} as SessionEntry;
}

function compactionEntry(id: string): SessionEntry {
	return {
		type: "compaction",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		summary: "earlier work",
		firstKeptEntryId: "kept-1",
		tokensBefore: 1000,
	} as SessionEntry;
}

class RecordingHost implements TodoRuntimeHost {
	readonly appendedToAgent: AgentMessage[] = [];
	readonly appendedToStore: Message[] = [];
	readonly events: AgentSessionEvent[] = [];
	readonly continuations: ScheduledAgentContinueOptions[] = [];

	settings: TodoSettingsSnapshot = { ...DEFAULT_SETTINGS };
	planMode = false;
	goalMode = false;
	pendingAsyncWake = false;
	activeTools = ["todo", "bash", "edit"];
	servedToolChoiceLabel: string | undefined;
	branch: SessionEntry[] = [];
	activeModel: Model<Api> | undefined;
	generation = 7;

	readonly agent = {
		state: { messages: [] as AgentMessage[] },
		appendMessage: (message: AgentMessage): void => {
			this.appendedToAgent.push(message);
			this.agent.state.messages.push(message);
		},
	};

	readonly sessionStore = {
		getBranch: (): SessionEntry[] => this.branch,
		appendMessage: (message: Message): void => {
			this.appendedToStore.push(message);
		},
	};

	constructor(model: Model<Api> | undefined) {
		this.activeModel = model;
	}

	todoSettings(): TodoSettingsSnapshot {
		return this.settings;
	}

	model(): Model<Api> | undefined {
		return this.activeModel;
	}

	planModeEnabled(): boolean {
		return this.planMode;
	}

	goalModeActive(): boolean {
		return this.goalMode;
	}

	activeToolNames(): string[] {
		return this.activeTools;
	}

	eagerPreludeContext(): { toolRefs: Record<string, string>; taskBatch: boolean } {
		return { toolRefs: { todo: "todo" }, taskBatch: false };
	}

	consumeLastServedToolChoiceLabel(): string | undefined {
		const label = this.servedToolChoiceLabel;
		this.servedToolChoiceLabel = undefined;
		return label;
	}

	hasPendingAsyncWake(): boolean {
		return this.pendingAsyncWake;
	}

	async emitSessionEvent(event: AgentSessionEvent): Promise<void> {
		this.events.push(event);
	}

	scheduleAgentContinue(options: ScheduledAgentContinueOptions): void {
		this.continuations.push(options);
	}

	promptGeneration(): number {
		return this.generation;
	}
}

describe("the todo board has one owner", () => {
	let host: RecordingHost;
	let todo: TodoRuntime;

	beforeEach(() => {
		host = new RecordingHost(getBundledModel("anthropic", "claude-sonnet-4-6"));
		todo = new TodoRuntime(host);
	});

	/** Land enough mutating results to arm the nudge. */
	function landMutations(count: number = MUTATIONS_TO_ARM_THE_NUDGE): void {
		for (let i = 0; i < count; i++) todo.onToolResultLanded("edit", false);
	}

	describe("the board is a value, not a shared reference", () => {
		it("hands out a copy a caller cannot mutate back into the owner", () => {
			todo.setPhases(board("pending"));
			const copy = todo.phases();
			const task = copy[0]?.tasks[0];
			if (!task) throw new Error("Expected the seeded task");
			task.status = "completed";

			expect(todo.phases()[0]?.tasks[0]?.status).toBe("pending");
		});

		it("adopts the board recorded on the active branch", () => {
			host.branch = [todoEntry("todo-1", board("in_progress"))];

			todo.syncFromBranch();

			expect(todo.phases()).toEqual(board("in_progress"));
		});
	});

	describe("a failed write silences every pressure", () => {
		beforeEach(() => {
			todo.setPhases(board("pending"));
		});

		it("tells the model the board may be stale", () => {
			const reminder = todo.recordWriteOutcome("phase not found");

			expect(reminder).toContain("todo failed");
			expect(reminder).toContain("phase not found");
			expect(reminder).toContain("Fix the todo payload and call todo again");
		});

		it("stops asking for a retry that already proved impossible", () => {
			todo.recordWriteOutcome("phase not found");
			const repeated = todo.recordWriteOutcome("phase not found");

			expect(repeated).toContain("cannot succeed");
			expect(repeated).not.toContain("Fix the todo payload and call todo again");
		});

		it("suppresses the stop-time reminder while the board is unverified", async () => {
			todo.recordWriteOutcome("phase not found");

			expect(await todo.checkCompletionAtSettle({ awaitingUserAnswer: false })).toBe(false);
			expect(host.appendedToAgent).toEqual([]);
		});

		it("suppresses the mid-run nudge while the board is unverified", () => {
			todo.recordWriteOutcome("phase not found");
			landMutations();

			expect(todo.takeMidRunNudge()).toBeNull();
		});
		it("drops the latch at a lifecycle boundary, because the board it described is gone", async () => {
			todo.recordWriteOutcome("phase not found");
			todo.resetForNewContext();
			todo.setPhases(board("pending"));

			// Carrying it across a `/new` silenced every reminder for the rest of
			// the process, and the repeated-failure wording tells the model to stop
			// calling `todo`, so no later success would ever clear it.
			expect(await todo.checkCompletionAtSettle({ awaitingUserAnswer: false })).toBe(true);
		});

		it("lifts the suppression once a write lands", async () => {
			todo.recordWriteOutcome("phase not found");
			expect(todo.recordWriteOutcome(undefined)).toBeUndefined();

			expect(await todo.checkCompletionAtSettle({ awaitingUserAnswer: false })).toBe(true);
		});
	});

	describe("another continuation owner takes precedence", () => {
		beforeEach(() => {
			todo.setPhases(board("pending"));
		});

		it("stands the stop-time reminder down for plan mode", async () => {
			host.planMode = true;

			expect(await todo.checkCompletionAtSettle({ awaitingUserAnswer: false })).toBe(false);
			expect(host.continuations).toEqual([]);
		});

		it("stands the stop-time reminder down for goal mode", async () => {
			host.goalMode = true;

			expect(await todo.checkCompletionAtSettle({ awaitingUserAnswer: false })).toBe(false);
			expect(host.continuations).toEqual([]);
		});

		it("stands the mid-run nudge down for plan mode", () => {
			host.planMode = true;
			landMutations();

			expect(todo.takeMidRunNudge()).toBeNull();
		});

		it("stands the eager prelude down for plan mode", () => {
			host.settings = { ...DEFAULT_SETTINGS, eager: "always" };
			host.planMode = true;
			todo.setPhases([]);

			expect(todo.eagerPrelude("build the thing")).toBeUndefined();
		});

		it("stays silent while a background job will re-wake the loop", async () => {
			host.pendingAsyncWake = true;

			expect(await todo.checkCompletionAtSettle({ awaitingUserAnswer: false })).toBe(false);
		});

		it("stays silent when the reply hands the turn back to the user", async () => {
			expect(await todo.checkCompletionAtSettle({ awaitingUserAnswer: true })).toBe(false);
		});

		it("consumes the served tool-choice label even when it refuses", async () => {
			host.servedToolChoiceLabel = "user-force";

			expect(await todo.checkCompletionAtSettle({ awaitingUserAnswer: false })).toBe(false);
			// Leaving it set would suppress the next turn's reminder too.
			expect(host.servedToolChoiceLabel).toBeUndefined();
		});
	});

	describe("the stop-time ladder escalates, then stops", () => {
		beforeEach(() => {
			todo.setPhases(board("pending", "pending"));
		});

		it("appends the reminder to the model and the transcript, and continues the run", async () => {
			expect(await todo.checkCompletionAtSettle({ awaitingUserAnswer: false })).toBe(true);

			expect(host.appendedToAgent).toHaveLength(1);
			expect(host.appendedToStore).toHaveLength(1);
			expect(host.continuations).toEqual([{ generation: host.generation }]);
			expect(host.events).toEqual([
				{
					type: "todo_reminder",
					todos: [
						{ content: "task 1", status: "pending" },
						{ content: "task 2", status: "pending" },
					],
					attempt: 1,
					maxAttempts: 3,
				},
			]);
		});

		it("says nothing again until the agent does something", async () => {
			expect(await todo.checkCompletionAtSettle({ awaitingUserAnswer: false })).toBe(true);

			// The agent has acknowledged and taken no action: escalating here is the
			// busy-work loop the latch exists to stop.
			expect(await todo.checkCompletionAtSettle({ awaitingUserAnswer: false })).toBe(false);
			expect(host.appendedToAgent).toHaveLength(1);
		});

		it("reminds again once the agent acts and the board still has work", async () => {
			await todo.checkCompletionAtSettle({ awaitingUserAnswer: false });
			todo.noteToolProgress();
			todo.setPhases(board("completed", "pending"));

			expect(await todo.checkCompletionAtSettle({ awaitingUserAnswer: false })).toBe(true);
			expect(host.appendedToAgent).toHaveLength(2);
		});
		it("forgets the escalation when the board empties, with no settle in between", async () => {
			await todo.checkCompletionAtSettle({ awaitingUserAnswer: false });

			// Finished and re-opened inside one turn. Nothing settles on the empty
			// board, so the emptying itself has to reset the ladder.
			todo.setPhases(board("completed", "completed"));
			todo.setPhases(board("pending", "pending"));

			expect(await todo.checkCompletionAtSettle({ awaitingUserAnswer: false })).toBe(true);
			expect(host.events.at(-1)).toMatchObject({ type: "todo_reminder", attempt: 1 });
		});

		it("stops at the configured budget", async () => {
			host.settings = { ...DEFAULT_SETTINGS, remindersMax: 1 };

			expect(await todo.checkCompletionAtSettle({ awaitingUserAnswer: false })).toBe(true);
			todo.noteToolProgress();
			todo.setPhases(board("completed", "pending"));

			expect(await todo.checkCompletionAtSettle({ awaitingUserAnswer: false })).toBe(false);
			expect(host.appendedToAgent).toHaveLength(1);
		});

		it("says nothing when the board is finished, and forgets the escalation", async () => {
			await todo.checkCompletionAtSettle({ awaitingUserAnswer: false });
			todo.setPhases(board("completed", "completed"));

			expect(await todo.checkCompletionAtSettle({ awaitingUserAnswer: false })).toBe(false);

			// A finished board resets the ladder: the next unfinished one starts at 1.
			todo.setPhases(board("pending"));
			expect(await todo.checkCompletionAtSettle({ awaitingUserAnswer: false })).toBe(true);
			const latest = host.events.at(-1);
			expect(latest).toMatchObject({ type: "todo_reminder", attempt: 1 });
		});

		it("resets the ladder at a lifecycle boundary", async () => {
			await todo.checkCompletionAtSettle({ awaitingUserAnswer: false });
			todo.resetForNewContext();

			// Same board, new context: the suppression latch and the fingerprint
			// both described the transcript that was just discarded.
			expect(await todo.checkCompletionAtSettle({ awaitingUserAnswer: false })).toBe(true);
			expect(host.appendedToAgent).toHaveLength(2);
		});

		it("resets the ladder when reminders are switched off", async () => {
			await todo.checkCompletionAtSettle({ awaitingUserAnswer: false });
			host.settings = { ...DEFAULT_SETTINGS, reminders: false };

			expect(await todo.checkCompletionAtSettle({ awaitingUserAnswer: false })).toBe(false);

			host.settings = { ...DEFAULT_SETTINGS };
			// A stale latch surviving disable/re-enable would silence the fresh runway.
			expect(await todo.checkCompletionAtSettle({ awaitingUserAnswer: false })).toBe(true);
		});

		it("says nothing at all when the subsystem is off", async () => {
			host.settings = { ...DEFAULT_SETTINGS, enabled: false };

			expect(await todo.checkCompletionAtSettle({ awaitingUserAnswer: false })).toBe(false);
		});
	});

	describe("the mid-run nudge tracks landed work", () => {
		beforeEach(() => {
			todo.setPhases(board("pending"));
		});

		it("stays quiet until enough mutating work has landed", () => {
			landMutations(MUTATIONS_TO_ARM_THE_NUDGE - 1);
			expect(todo.takeMidRunNudge()).toBeNull();

			landMutations(1);
			expect(todo.takeMidRunNudge()).not.toBeNull();
		});

		it("counts neither read-only tools nor failed ones", () => {
			for (let i = 0; i < MUTATIONS_TO_ARM_THE_NUDGE; i++) todo.onToolResultLanded("read", false);
			for (let i = 0; i < MUTATIONS_TO_ARM_THE_NUDGE; i++) todo.onToolResultLanded("edit", true);

			expect(todo.takeMidRunNudge()).toBeNull();
		});

		it("starts the runway over when the agent touches the board", () => {
			landMutations();
			todo.onToolResultLanded("todo", false);

			expect(todo.takeMidRunNudge()).toBeNull();
		});

		it("fires hidden, so it never reaches the transcript or the UI", () => {
			landMutations();
			const nudge = todo.takeMidRunNudge();
			if (nudge?.role !== "custom") throw new Error("Expected a hidden custom nudge message");

			expect(nudge.display).toBe(false);
			// No `todo_reminder` event and no escalation: this is a model-only hint.
			expect(host.events).toEqual([]);
			expect(host.appendedToStore).toEqual([]);
		});

		it("spends a bounded budget per prompt cycle", () => {
			landMutations();
			expect(todo.takeMidRunNudge()).not.toBeNull();
			landMutations();
			expect(todo.takeMidRunNudge()).not.toBeNull();

			landMutations();
			expect(todo.takeMidRunNudge()).toBeNull();

			// A new prompt is a fresh runway.
			todo.onNewPrompt();
			landMutations();
			expect(todo.takeMidRunNudge()).not.toBeNull();
		});

		it("says nothing when the board has no outstanding work", () => {
			todo.setPhases(board("completed"));
			landMutations();

			expect(todo.takeMidRunNudge()).toBeNull();
		});

		it("never asks for a tool the model cannot see", () => {
			host.activeTools = ["bash", "edit"];
			landMutations();

			expect(todo.takeMidRunNudge()).toBeNull();
		});
	});

	describe("the eager prelude asks for a list to exist", () => {
		it("stays out of the way at the default setting", () => {
			expect(todo.eagerPrelude("build the thing")).toBeUndefined();
		});

		it("suggests a list without forcing the tool when preferred", () => {
			host.settings = { ...DEFAULT_SETTINGS, eager: "preferred" };

			const prelude = todo.eagerPrelude("build the thing");
			if (prelude?.message.role !== "custom") throw new Error("Expected a custom prelude message");

			expect(prelude.message.customType).toBe("eager-todo-prelude");
			expect(prelude.message.display).toBe(false);
			expect(prelude?.toolChoice).toBeUndefined();
		});

		it("forces the tool when always", () => {
			host.settings = { ...DEFAULT_SETTINGS, eager: "always" };

			const prelude = todo.eagerPrelude("build the thing");

			expect(prelude?.toolChoice).toBeDefined();
		});

		it("degrades to the reminder alone on a model that cannot be forced", () => {
			host.settings = { ...DEFAULT_SETTINGS, eager: "always" };
			host.activeModel = undefined;

			const prelude = todo.eagerPrelude("build the thing");

			expect(prelude?.message).toBeDefined();
			expect(prelude?.toolChoice).toBeUndefined();
		});

		it("never forces a tool the model cannot see", () => {
			host.settings = { ...DEFAULT_SETTINGS, eager: "always" };
			host.activeTools = ["bash"];

			expect(todo.eagerPrelude("build the thing")).toBeUndefined();
		});

		it("only fires on the first user message", () => {
			host.settings = { ...DEFAULT_SETTINGS, eager: "always" };
			host.agent.state.messages.push({ role: "user", content: "earlier", timestamp: 1 } as AgentMessage);

			// A later turn corrects or redirects; forcing a brand-new list there is wrong.
			expect(todo.eagerPrelude("build the thing")).toBeUndefined();
		});

		it("leaves a question alone", () => {
			host.settings = { ...DEFAULT_SETTINGS, eager: "always" };

			expect(todo.eagerPrelude("what does this do?")).toBeUndefined();
			expect(todo.eagerPrelude("stop!")).toBeUndefined();
		});

		it("says nothing once a board already exists", () => {
			host.settings = { ...DEFAULT_SETTINGS, eager: "always" };
			todo.setPhases(board("pending"));

			expect(todo.eagerPrelude("build the thing")).toBeUndefined();
		});

		it("re-injects after compaction as a reminder only", () => {
			host.settings = { ...DEFAULT_SETTINGS, eager: "always" };

			// No fresh user message: forcing a tool onto the auto-resumed turn would
			// override the agent's in-flight action.
			const prelude = todo.eagerPrelude(undefined);

			expect(prelude?.message).toBeDefined();
			expect(prelude?.toolChoice).toBeUndefined();
		});

		it("says nothing when the subsystem is off", () => {
			host.settings = { ...DEFAULT_SETTINGS, enabled: false, eager: "always" };

			expect(todo.eagerPrelude("build the thing")).toBeUndefined();
		});
	});

	describe("the prewalk gate opens only once a list exists", () => {
		it("is shut until a todo result lands", () => {
			expect(todo.sawTodoTool).toBe(false);

			todo.noteTodoToolResult();

			expect(todo.sawTodoTool).toBe(true);
		});
	});

	describe("an init call is recognised from the result or the transcript", () => {
		it("reads the op off the result when it carries one", () => {
			expect(todo.isInitResult({ op: "init" }, undefined)).toBe(true);
			expect(todo.isInitResult({ op: "done" }, undefined)).toBe(false);
		});

		it("recovers the op from the transcript when the result omits it", () => {
			host.agent.state.messages.push({
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1", name: "todo", arguments: { op: "init" } }],
				timestamp: 2,
			} as unknown as AgentMessage);

			expect(todo.isInitResult({}, "call-1")).toBe(true);
			expect(todo.isInitResult({}, "call-missing")).toBe(false);
		});

		it("answers no when there is nothing to read", () => {
			expect(todo.isInitResult({}, undefined)).toBe(false);
		});
	});

	describe("the full-list echo is spent once per context window", () => {
		it("echoes once, then names only the active item until a compaction boundary moves", async () => {
			todo.setPhases(board("pending", "pending", "pending"));

			// The echo restores the board: every open item, under its phase heading.
			await todo.checkCompletionAtSettle({ awaitingUserAnswer: false });
			const echoed = textOf(host.appendedToAgent[0]);
			expect(echoed).toContain("task 1");
			expect(echoed).toContain("task 3");
			expect(echoed).not.toContain("Active/next:");

			// Same window: re-pasting a list already in context buys nothing.
			todo.noteToolProgress();
			todo.setPhases(board("completed", "pending", "pending"));
			await todo.checkCompletionAtSettle({ awaitingUserAnswer: false });
			const terse = textOf(host.appendedToAgent[1]);
			expect(terse).toContain("Active/next: task 2");
			expect(terse).not.toContain("task 3");

			// A compaction means the earlier echo scrolled out of the window.
			host.branch = [compactionEntry("compaction-1")];
			todo.noteToolProgress();
			todo.setPhases(board("completed", "in_progress", "pending"));
			await todo.checkCompletionAtSettle({ awaitingUserAnswer: false });
			const reEchoed = textOf(host.appendedToAgent[2]);
			expect(reEchoed).toContain("task 3");
			expect(reEchoed).not.toContain("Active/next:");
		});
	});
});

function textOf(message: AgentMessage | undefined): string {
	if (!message || !("content" in message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	return content.map(part => ("text" in part && part.type === "text" ? part.text : "")).join("\n");
}

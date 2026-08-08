/**
 * WHY: the "ghost question".
 *
 * A user answers an `ask` card, the turn ends, and some time later the very
 * same question re-appears in the transcript — interactive-looking, wired to
 * nothing, produced by no model call. Answering it does nothing because there
 * is no promise behind it.
 *
 * THE CLASS (not the incident): every render path decided whether to build a
 * tool card with `!ctx.pendingTools.has(id)`. `pendingTools` is a PENDING map —
 * the entry is deleted the instant a result lands — so that predicate reads
 * false both BEFORE a card exists and AFTER it finished. The two states were
 * indistinguishable, and any event that named a finished call again built a
 * second card in the CALL/pending shape. For `ask` the pending shape IS the
 * question with its option list, which is why this defect is visible and
 * infuriating there; for every other tool it is a duplicate spinner nobody
 * reported. Same bug, one class.
 *
 * Re-announcing a finished call is not exotic: `tool_execution_start` has eight
 * independent producers reaching one UI (agent-loop's `emitToolResult`
 * `!record.started` branch and `createAbortedToolResult`, Cursor's three
 * exec-channel emitters, the ACP replay, the collab relay, the RPC forwarder),
 * plus `message_start`+`message_update` resynthesis on collab resync and
 * subagent focus re-attach. The UI is the single consumer of all of them, so
 * idempotence is the UI's job.
 *
 * THE INVARIANT THESE TESTS DEFEND, at the choke point every case crosses:
 *
 *   Once a tool call's transcript card is FINAL — a result landed, or the card
 *   was sealed at turn end — no render path may ever create another card for
 *   that toolCallId.
 *
 * Two axes are enumerated from source so a NEW member turns this suite red
 * rather than sliding through:
 *  - TOOLS: `Object.keys(toolRenderers)` at run time. Register a renderer,
 *    inherit the coverage.
 *  - EVENTS: `MOUNT_RISK` is `satisfies Record<AgentSessionEvent["type"], …>`,
 *    so a new session event type fails `bun run check:ts` until someone records
 *    whether it can mount a card, and every type marked `can-mount` must supply
 *    a replay or the run-time check below throws.
 *
 * WHAT THIS DOES NOT CATCH: a card duplicated by a component that never routes
 * through `ctx.pendingTools`/`ctx.settledToolCalls` at all (the standalone
 * `ChatTranscriptBuilder` used by the agent-transcript viewer keeps its own
 * private map and is covered by its own tests), and a card whose *content* is
 * wrong while its count is right — except for `ask`, whose exact answered bytes
 * are pinned below.
 */
import { beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { ReadToolGroupComponent } from "@veyyon/coding-agent/modes/components/read-tool-group";
import { ToolExecutionComponent } from "@veyyon/coding-agent/modes/components/tool-execution";
import { TranscriptContainer } from "@veyyon/coding-agent/modes/components/transcript-container";
import { EventController } from "@veyyon/coding-agent/modes/controllers/event-controller";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/types";
import { UiHelpers } from "@veyyon/coding-agent/modes/utils/ui-helpers";
import type { AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session";
import type { SessionContext } from "@veyyon/coding-agent/session/session-context";
import { toolRenderers } from "@veyyon/coding-agent/tools/renderers";
import { stripAnsi } from "@veyyon/utils";

const CALL_ID = "call-ghost";

const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * `path` routes `read` into its group component; every other renderer ignores
 * the extra keys. `questions` is what `ask` renders as the interactive card.
 */
const TOOL_ARGS = {
	path: "README.md",
	command: "true",
	questions: [
		{ id: "auth", question: "Which auth method?", options: [{ label: "JWT" }, { label: "Session cookies" }] },
	],
};

const TOOL_RESULT = {
	content: [{ type: "text", text: "Selected: JWT" }],
	details: {
		question: "Which auth method?",
		options: ["JWT", "Session cookies"],
		multi: false,
		selectedOptions: ["JWT"],
	},
};

function assistantCalling(toolName: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: CALL_ID, name: toolName, arguments: TOOL_ARGS }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "toolUse",
		usage,
		timestamp: Date.now(),
	} as unknown as AgentMessage;
}

function toolResultMessage(toolName: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: CALL_ID,
		toolName,
		content: TOOL_RESULT.content,
		details: TOOL_RESULT.details,
		isError: false,
		timestamp: Date.now(),
	} as unknown as AgentMessage;
}

/**
 * Every session event type, and whether it can reach a code path that CREATES a
 * tool card. Exhaustive by `satisfies`: a new `AgentSessionEvent` member fails
 * the type gate here until its risk is recorded, which is what keeps the event
 * axis from going stale in silence.
 */
const MOUNT_RISK = {
	message_start: "can-mount",
	message_update: "can-mount",
	message_end: "can-mount",
	tool_execution_start: "can-mount",
	tool_execution_update: "can-mount",
	tool_execution_end: "can-mount",
	agent_start: "inert",
	agent_end: "inert",
	turn_start: "inert",
	turn_end: "inert",
	auto_compaction_start: "inert",
	auto_compaction_end: "inert",
	auto_retry_start: "inert",
	auto_retry_end: "inert",
	retry_fallback_applied: "inert",
	retry_fallback_succeeded: "inert",
	cwd_changed: "inert",
	goal_updated: "inert",
	irc_message: "inert",
	notice: "inert",
	thinking_level_changed: "inert",
	todo_auto_clear: "inert",
	todo_reminder: "inert",
	ttsr_triggered: "inert",
} satisfies Record<AgentSessionEvent["type"], "can-mount" | "inert">;

/**
 * The replay each `can-mount` event needs to actually reach its mount site.
 * `message_update` is preceded by `message_start` because that is exactly how a
 * collab resync and a subagent focus re-attach resynthesize an orphaned delta —
 * without the re-opened stream the controller has no `streamingMessage` to walk.
 */
function replayFor(kind: keyof typeof MOUNT_RISK, toolName: string): AgentSessionEvent[] {
	const message = assistantCalling(toolName);
	switch (kind) {
		case "message_start":
			return [{ type: "message_start", message }] as unknown as AgentSessionEvent[];
		case "message_update":
			return [
				{ type: "message_start", message },
				{ type: "message_update", message, assistantMessageEvent: { type: "toolcall_end", partial: message } },
			] as unknown as AgentSessionEvent[];
		case "message_end":
			return [{ type: "message_end", message }] as unknown as AgentSessionEvent[];
		case "tool_execution_start":
			return [
				{ type: "tool_execution_start", toolCallId: CALL_ID, toolName, args: TOOL_ARGS },
			] as unknown as AgentSessionEvent[];
		case "tool_execution_update":
			return [
				{ type: "tool_execution_update", toolCallId: CALL_ID, toolName, partialResult: TOOL_RESULT },
			] as unknown as AgentSessionEvent[];
		case "tool_execution_end":
			return [
				{ type: "tool_execution_end", toolCallId: CALL_ID, toolName, result: TOOL_RESULT, isError: false },
			] as unknown as AgentSessionEvent[];
		default:
			throw new Error(`${kind} is marked can-mount but has no replay; add one or mark it inert`);
	}
}

const REPLAYABLE = Object.entries(MOUNT_RISK)
	.filter(([, risk]) => risk === "can-mount")
	.map(([kind]) => kind as keyof typeof MOUNT_RISK);
/**
 * The second axis: RENDER PATHS, enumerated from source at run time.
 *
 * `pendingTools` and `settledToolCalls` are consulted by exactly two classes,
 * and every way a tool card can reach the transcript starts at a public method
 * of one of them. Those method names are read off the prototypes below, so a new
 * public entry point — a collab resync handler, a replay method, a second
 * rebuild — turns this suite RED until somebody records whether it can mount a
 * card, and if it can, supplies a driver that the settled-inertness sweep runs.
 *
 * The classification is pinned by exact set equality, never by a count and never
 * by a loose match: renaming a method fails just as loudly as adding one.
 */
const CONTROLLER_ENTRY_POINTS = {
	constructor: "not-an-entry-point",
	handleEvent: "mounts-tool-cards",
	// Wires `session.subscribe` straight to `handleEvent`; it reaches no mount
	// site of its own, and driving it would only re-test `handleEvent`.
	subscribeToAgent: "inert",
	dispose: "inert",
	resetTranscriptAnchors: "inert",
	inheritDisplaceableTodo: "inert",
	sendCompletionNotification: "inert",
} as const;

const HELPER_ENTRY_POINTS = {
	constructor: "not-an-entry-point",
	renderSessionContext: "mounts-tool-cards",
	renderInitialMessages: "mounts-tool-cards",
	// Asserted inert below rather than assumed: its `toolResult` case is a
	// deliberate no-op and its `assistant` case renders prose only.
	addMessageToChat: "inert",
	getUserMessageText: "inert",
	showStatus: "inert",
	clearEditor: "inert",
	showError: "inert",
	showWarning: "inert",
	showUpdateReadyNotification: "inert",
	showUpdateFailedNotification: "inert",
	showUnparseableSettingsNotification: "inert",
	showSettingsSaveFailureNotification: "inert",
	showNewVersionNotification: "inert",
	showPluginUpdatesNotification: "inert",
	showPluginUpdatesInstalledNotification: "inert",
	updatePendingMessagesDisplay: "inert",
	queueCompactionMessage: "inert",
	isKnownSlashCommand: "inert",
	flushCompactionQueue: "inert",
	flushPendingBashComponents: "inert",
	findLastAssistantMessage: "inert",
	extractAssistantText: "inert",
} as const;

/**
 * Which mounting entry point each driver in the sweep exercises. Every
 * `mounts-tool-cards` name above must appear here, or the run-time check throws:
 * a new render path cannot be classified as dangerous and then left undriven.
 */
const DRIVEN_ENTRY_POINTS: readonly string[] = [
	"EventController.handleEvent",
	"UiHelpers.renderSessionContext",
	"UiHelpers.renderInitialMessages",
];

function createFixture(opts: { isStreaming?: boolean; messages?: AgentMessage[] } = {}) {
	const chatContainer = new TranscriptContainer();
	const session = {
		retryAttempt: 0,
		getToolByName: () => undefined,
		getArgotSession: () => undefined,
		sessionManager: { getCwd: () => process.cwd(), getSessionName: () => "test-session", getEntries: () => [] },
		isStreaming: opts.isStreaming ?? true,
		systemPromptInvalidations: () => [],
		// What `renderInitialMessages` replays. Same messages the direct
		// `renderSessionContext` driver uses, reached through the production
		// caller instead of by hand.
		buildTranscriptSessionContext: () => ({ messages: opts.messages ?? [] }) as SessionContext,
	};
	let helpers!: UiHelpers;
	const ctx = {
		isInitialized: true,
		init: vi.fn(async () => {}),
		chatContainer,
		pendingTools: new Map(),
		settledToolCalls: new Set<string>(),
		ui: { requestRender: vi.fn(), requestComponentRender: vi.fn() },
		statusLine: { invalidate: vi.fn(), markActivityStart: vi.fn(), markActivityEnd: vi.fn() },
		statusContainer: { disposeChildren: vi.fn(), addChild: vi.fn() },
		updateEditorBorderColor: vi.fn(),
		settings: { get: () => false },
		addMessageToChat: (message: AgentMessage) => helpers.addMessageToChat(message),
		renderSessionContext: (
			context: SessionContext,
			options?: { updateFooter?: boolean; populateHistory?: boolean },
		) => helpers.renderSessionContext(context, options),
		resetTranscript: () => chatContainer.clear(),
		initialChatRendered: false,
		pendingMessagesContainer: { disposeChildren: vi.fn(), removeChild: vi.fn(), addChild: vi.fn() },
		pendingBashComponents: [],
		pendingPythonComponents: [],
		focusedAgentId: undefined,
		session,
		viewSession: session,
		sessionManager: { getCwd: () => process.cwd(), getSessionName: () => "test-session" },
		toolOutputExpanded: false,
		hideThinkingBlock: false,
		lastAssistantUsage: undefined,
		streamingComponent: undefined,
		streamingMessage: undefined,
		noteDisplayableThinkingContent: () => false,
		effectiveHideThinkingBlock: false,
		clearTransientSessionUi: () => {},
		ensureLoadingAnimation: vi.fn(),
		clearWorkingLoader: vi.fn(() => false),
		flushPendingModelSwitch: vi.fn(async () => {}),
		loadingAnimation: undefined,
		autoCompactionLoader: undefined,
		retryLoader: undefined,
		setTodos: vi.fn(),
		showWarning: vi.fn(),
		refreshComposerShortcuts: vi.fn(),
		dismissWelcome: vi.fn(),
		clearPinnedError: vi.fn(),
		setWorkingMessage: vi.fn(),
		updatePendingMessagesDisplay: vi.fn(),
		editor: { setText: vi.fn(), getText: () => "" },
		getUserMessageText: () => "",
		locallySubmittedUserSignatures: new Set<string>(),
		optimisticUserMessageSignature: undefined,
	} as unknown as InteractiveModeContext;
	helpers = new UiHelpers(ctx);
	return { ctx, helpers, chatContainer, session, controller: new EventController(ctx) };
}

function toolCards(chatContainer: TranscriptContainer) {
	return chatContainer.children.filter(
		child => child instanceof ToolExecutionComponent || child instanceof ReadToolGroupComponent,
	);
}

/**
 * The bytes of every tool card, isolated from the surrounding transcript. A
 * count alone is blind to the grouped tools: `read` accretes its calls into one
 * shared `ReadToolGroupComponent`, so a re-announced read duplicates a ROW
 * inside an existing card and the child count never moves. Comparing rendered
 * bytes is the assertion that holds for both shapes.
 */
function toolCardBytes(chatContainer: TranscriptContainer): string[] {
	return toolCards(chatContainer).map(card => stripAnsi(card.render(100).join("\n")));
}

/** Drive a tool call all the way to a delivered result through the real controller. */
async function runToCompletion(controller: EventController, toolName: string): Promise<void> {
	const message = assistantCalling(toolName);
	await controller.handleEvent({ type: "agent_start" } as unknown as AgentSessionEvent);
	await controller.handleEvent({ type: "message_start", message } as unknown as AgentSessionEvent);
	await controller.handleEvent({
		type: "message_update",
		message,
		assistantMessageEvent: { type: "toolcall_end", partial: message },
	} as unknown as AgentSessionEvent);
	await controller.handleEvent({ type: "message_end", message } as unknown as AgentSessionEvent);
	await controller.handleEvent({
		type: "tool_execution_start",
		toolCallId: CALL_ID,
		toolName,
		args: TOOL_ARGS,
	} as unknown as AgentSessionEvent);
	await controller.handleEvent({
		type: "tool_execution_end",
		toolCallId: CALL_ID,
		toolName,
		result: TOOL_RESULT,
		isError: false,
	} as unknown as AgentSessionEvent);
}

describe("a settled tool call can never re-mount as a live card", () => {
	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	it("covers a variant space derived from source, not a hardcoded list", () => {
		// Guards the guards: if either enumeration silently collapses to nothing,
		// every parameterized assertion below would vacuously pass.
		expect(Object.keys(toolRenderers).length).toBeGreaterThan(10);
		expect(REPLAYABLE).toContain("tool_execution_start");
		expect(REPLAYABLE).toContain("message_update");
		expect(REPLAYABLE.length).toBe(6);
	});

	/**
	 * The render-path axis, read off the prototypes at run time. Exact set
	 * equality both ways: a new public method on either class fails here, and so
	 * does a rename or a removal, which is what keeps this list from going stale
	 * in silence the way a hardcoded roster does.
	 */
	it("classifies every public entry point of the two classes that mount tool cards", () => {
		expect(Object.getOwnPropertyNames(EventController.prototype).sort()).toEqual(
			Object.keys(CONTROLLER_ENTRY_POINTS).sort(),
		);
		expect(Object.getOwnPropertyNames(UiHelpers.prototype).sort()).toEqual(Object.keys(HELPER_ENTRY_POINTS).sort());

		const mounting = [
			...Object.entries(CONTROLLER_ENTRY_POINTS)
				.filter(([, role]) => role === "mounts-tool-cards")
				.map(([name]) => `EventController.${name}`),
			...Object.entries(HELPER_ENTRY_POINTS)
				.filter(([, role]) => role === "mounts-tool-cards")
				.map(([name]) => `UiHelpers.${name}`),
		];
		// A path classified as dangerous and then left undriven is a hole, not a
		// pass. Exact equality, so a driver for a path nobody classified fails too.
		expect(mounting.sort()).toEqual([...DRIVEN_ENTRY_POINTS].sort());
	});

	/**
	 * The one classification above that is an assertion rather than a reading:
	 * `addMessageToChat` sees the assistant message that CARRIES the tool call and
	 * the toolResult that answers it, and must build a card from neither. If it
	 * ever does, it becomes a mount site with no ledger consult.
	 */
	it("mounts no tool card from a message handed straight to addMessageToChat", () => {
		const { helpers, chatContainer } = createFixture({ isStreaming: false });

		helpers.addMessageToChat(assistantCalling("ask"));
		helpers.addMessageToChat(toolResultMessage("ask"));

		expect(toolCards(chatContainer).length).toBe(0);
		expect(stripAnsi(chatContainer.render(100).join("\n"))).not.toContain("Which auth method?");
	});

	// Three phases, because WHEN the stray event lands decides which state has
	// already been torn down, and each teardown used to reopen the hole:
	//  - mid-turn: the plain duplicate.
	//  - after-turn-end: the reported symptom ("it'll finish the turn then it'll
	//    randomly render the question again"). Turn teardown runs
	//    `#resetReadGroup()`, without which a re-announced `read` quietly reuses
	//    the old group and the duplicate hides.
	//  - next-turn: events genuinely cross turn boundaries in this controller —
	//    it carries explicit handling for an `agent_end` that lands after the
	//    NEXT turn's `agent_start`. Any ledger scoped to the turn rather than to
	//    the transcript looks correct until this phase.
	for (const phase of ["mid-turn", "after-turn-end", "next-turn"] as const) {
		for (const toolName of Object.keys(toolRenderers)) {
			for (const kind of REPLAYABLE) {
				it(`freezes the '${toolName}' card when a settled call is re-announced by ${kind} (${phase})`, async () => {
					const { chatContainer, controller, session } = createFixture();
					await runToCompletion(controller, toolName);
					if (phase !== "mid-turn") {
						session.isStreaming = false;
						await controller.handleEvent({ type: "agent_end" } as unknown as AgentSessionEvent);
					}
					if (phase === "next-turn") {
						session.isStreaming = true;
						await controller.handleEvent({ type: "agent_start" } as unknown as AgentSessionEvent);
					}
					const before = toolCardBytes(chatContainer);
					expect(before.length).toBe(1);

					for (const event of replayFor(kind, toolName)) await controller.handleEvent(event);

					expect(toolCardBytes(chatContainer)).toEqual(before);
				});
			}
		}
	}

	// A result can paint a card on its own: the `read` branch BUILDS its group
	// component when no pending one is found. That card is final the moment it
	// exists, so the call event arriving afterwards must change nothing — the
	// variant where "settled" is recorded only for calls that happened to still
	// be in `pendingTools` leaves exactly this door open.
	//
	// Where a result paints nothing, a later call event paints nothing either:
	// settled means inert, without exception. Tool start/end never actually
	// arrive out of order in production (they cross the extension hop in order),
	// and a transcript rebuild repaints the truth from the recorded messages, so
	// inertness is the safe reading — the alternative is a spinner wired to a
	// call that already finished.
	for (const toolName of Object.keys(toolRenderers)) {
		it(`ignores a late call event for '${toolName}' after its result already painted`, async () => {
			const { chatContainer, controller } = createFixture();
			await controller.handleEvent({ type: "agent_start" } as unknown as AgentSessionEvent);
			await controller.handleEvent({
				type: "tool_execution_end",
				toolCallId: CALL_ID,
				toolName,
				result: TOOL_RESULT,
				isError: false,
			} as unknown as AgentSessionEvent);
			const painted = toolCardBytes(chatContainer);

			await controller.handleEvent({
				type: "tool_execution_start",
				toolCallId: CALL_ID,
				toolName,
				args: TOOL_ARGS,
			} as unknown as AgentSessionEvent);

			expect(toolCardBytes(chatContainer)).toEqual(painted);
		});
	}

	it("keeps the ANSWERED ask bytes and never re-renders the question as interactive", async () => {
		const { chatContainer, controller } = createFixture();
		await runToCompletion(controller, "ask");

		const answered = stripAnsi(chatContainer.render(100).join("\n"));
		// The answered card marks the chosen option; the pending card is a
		// distinct frame titled with the question count and all-empty markers.
		expect(answered).toContain("▣ JWT");
		expect(answered).not.toContain("Ask 1 questions");

		for (const kind of REPLAYABLE) {
			for (const event of replayFor(kind, "ask")) await controller.handleEvent(event);
		}

		const after = stripAnsi(chatContainer.render(100).join("\n"));
		expect(after).toBe(answered);
		expect(after).not.toContain("Ask 1 questions");
		// One question, rendered once. Two occurrences is the ghost.
		expect(after.split("Which auth method?").length - 1).toBe(1);
	});

	it("re-derives settled state from the messages on a transcript rebuild", async () => {
		// The rebuild tears the ledger down with the transcript, so resolution has
		// to come back out of the recorded toolResult — otherwise every rebuild
		// (idle auto-compaction, overlay close, focus attach) reopens the hole.
		const { helpers, chatContainer, controller } = createFixture({ isStreaming: false });

		helpers.renderSessionContext({
			messages: [assistantCalling("ask"), toolResultMessage("ask")],
		} as SessionContext);

		// The rebuilt card is the ANSWERED card, byte for byte, and stays that way.
		// Asserting the ledger here instead would pass while the transcript showed
		// a fresh question beside it.
		const rebuilt = stripAnsi(chatContainer.render(100).join("\n"));
		expect(toolCards(chatContainer).length).toBe(1);
		expect(rebuilt).toContain("▣ JWT");
		expect(rebuilt).not.toContain("Ask 1 questions");

		for (const kind of REPLAYABLE) {
			for (const event of replayFor(kind, "ask")) await controller.handleEvent(event);
		}

		expect(stripAnsi(chatContainer.render(100).join("\n"))).toBe(rebuilt);
		expect(rebuilt.split("Which auth method?").length - 1).toBe(1);
	});

	/**
	 * The same rebuild reached through the caller production actually uses.
	 * `renderInitialMessages` is what a focus attach, an overlay close and a
	 * resume run; it clears the transcript and replays the session's own context.
	 * Driving only the inner method would leave this path's clear-and-re-derive
	 * untested, which is exactly the shape of gap that shipped the defect.
	 */
	for (const toolName of ["ask", "read", "bash"]) {
		it(`freezes a rebuilt '${toolName}' card when the rebuild ran through renderInitialMessages`, async () => {
			const { helpers, chatContainer, controller } = createFixture({
				isStreaming: false,
				messages: [assistantCalling(toolName), toolResultMessage(toolName)],
			});

			helpers.renderInitialMessages();

			const rebuilt = toolCardBytes(chatContainer);
			expect(rebuilt.length).toBe(1);

			for (const kind of REPLAYABLE) {
				for (const event of replayFor(kind, toolName)) await controller.handleEvent(event);
			}

			expect(toolCardBytes(chatContainer)).toEqual(rebuilt);
		});
	}

	/**
	 * The turn that ended in an error stop. The rebuild paints the error INTO the
	 * tool card and never puts it in `pendingTools`, because no result is coming —
	 * the card is final the moment it is drawn. Two branches do this, one for
	 * grouped reads and one for every other tool, and both were left out of the
	 * ledger by the original fix: the settle was written next to the recorded
	 * `toolResult` and next to the trailing seal, and this third way of producing
	 * a final card was not either of those. A `tool_execution_start` replay for
	 * the same call then built a live card beside the errored one, which for `ask`
	 * is the ghost question with the error still on screen above it.
	 */
	// What the errored card shows, per tool, so the test proves the ERROR branch
	// ran rather than some other branch that also happens to leave one card. The
	// grouped read collapses to a failed row instead of printing the message;
	// without the error branch it would leave no card at all, which the count
	// below catches.
	const ERRORED_CARD_MARK: Record<string, string> = {
		ask: "provider closed the stream",
		read: "✗ Read README.md",
		bash: "provider closed the stream",
	};
	for (const toolName of ["ask", "read", "bash"]) {
		it(`freezes a '${toolName}' card the rebuild painted with a turn-ending error`, async () => {
			const { helpers, chatContainer, controller } = createFixture({ isStreaming: false });
			const failed = {
				...assistantCalling(toolName),
				stopReason: "error",
				errorMessage: "provider closed the stream",
			} as unknown as AgentMessage;

			helpers.renderSessionContext({ messages: [failed] } as SessionContext);

			const painted = toolCardBytes(chatContainer);
			expect(painted.length).toBe(1);
			expect(painted[0]).toContain(ERRORED_CARD_MARK[toolName]);

			for (const kind of REPLAYABLE) {
				for (const event of replayFor(kind, toolName)) await controller.handleEvent(event);
			}

			expect(toolCardBytes(chatContainer)).toEqual(painted);
			expect(stripAnsi(chatContainer.render(100).join("\n"))).not.toContain("Ask 1 questions");
		});
	}

	it("cannot resurrect a call an idle rebuild sealed with no result on record", async () => {
		// The other half of the rebuild: a toolCall whose result was never
		// persisted (the user escaped the question, the turn died). An idle
		// rebuild freezes it as history and drops it from live tracking, so it is
		// just as final as an answered one and just as un-remountable.
		const { ctx, helpers, chatContainer, controller } = createFixture({ isStreaming: false });

		helpers.renderSessionContext({ messages: [assistantCalling("ask")] } as SessionContext);

		const frozen = toolCardBytes(chatContainer);
		expect(frozen.length).toBe(1);
		expect(ctx.pendingTools.size).toBe(0);
		expect(ctx.settledToolCalls.has(CALL_ID)).toBe(true);

		for (const kind of REPLAYABLE) {
			for (const event of replayFor(kind, "ask")) await controller.handleEvent(event);
		}

		expect(toolCardBytes(chatContainer)).toEqual(frozen);
	});

	it("cannot resurrect a call that was sealed unanswered at turn end", async () => {
		// The user escaped the question, or the turn aborted. The frozen card is
		// history; a late replay must not hand back a live one beside it.
		const { ctx, chatContainer, controller, session } = createFixture();
		const message = assistantCalling("ask");
		await controller.handleEvent({ type: "agent_start" } as unknown as AgentSessionEvent);
		await controller.handleEvent({ type: "message_start", message } as unknown as AgentSessionEvent);
		await controller.handleEvent({
			type: "message_update",
			message,
			assistantMessageEvent: { type: "toolcall_end", partial: message },
		} as unknown as AgentSessionEvent);
		await controller.handleEvent({ type: "message_end", message } as unknown as AgentSessionEvent);
		// The turn is genuinely over by the time agent_end lands; a still-streaming
		// session means a superseded event and the controller skips teardown.
		session.isStreaming = false;
		await controller.handleEvent({ type: "agent_end" } as unknown as AgentSessionEvent);

		expect(toolCards(chatContainer).length).toBe(1);
		expect(ctx.settledToolCalls.has(CALL_ID)).toBe(true);

		for (const kind of REPLAYABLE) {
			for (const event of replayFor(kind, "ask")) await controller.handleEvent(event);
		}

		expect(toolCards(chatContainer).length).toBe(1);
	});

	/**
	 * The other direction of the same invariant, and the one a reader is most
	 * tempted to break: the ledger describes the transcript that is on screen, so
	 * a rebuild that tears the transcript down re-derives it and holds nothing
	 * from the transcript it replaced.
	 *
	 * Dropping the clear looks harmless because ids from one provider stream do
	 * not repeat. They repeat across streams: the ACP and Cursor exec channels
	 * number their calls per session, and a focus attach rebuilds the transcript
	 * of a different agent into the same context. A stale entry then makes the
	 * NEW agent's genuinely live card deaf: `#handleToolExecutionEnd` sees the id
	 * already settled and returns, so the spinner never resolves. Never mounting
	 * a second card must not decay into never finishing the first one.
	 */
	it("re-derives the ledger from the rebuilt transcript and holds nothing from the old one", async () => {
		const { ctx, helpers, chatContainer, controller } = createFixture({
			isStreaming: true,
			messages: [assistantCalling("ask")],
		});

		// A previous transcript settled this id.
		await runToCompletion(controller, "ask");
		expect(ctx.settledToolCalls.has(CALL_ID)).toBe(true);

		// Focus attach: the transcript is replaced while the viewed session is
		// still streaming, and the same id now names an in-flight call.
		helpers.renderInitialMessages();

		expect([...ctx.settledToolCalls]).toEqual([]);
		expect(ctx.pendingTools.has(CALL_ID)).toBe(true);
		const live = toolCardBytes(chatContainer);
		expect(live.length).toBe(1);
		expect(live[0]).not.toContain("▣ JWT");

		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: CALL_ID,
			toolName: "ask",
			result: TOOL_RESULT,
			isError: false,
		} as unknown as AgentSessionEvent);

		// The result reached the card the rebuild drew, and did not open a second.
		const answered = toolCardBytes(chatContainer);
		expect(answered.length).toBe(1);
		expect(answered[0]).toContain("▣ JWT");
		expect(ctx.settledToolCalls.has(CALL_ID)).toBe(true);
	});

	it("still mounts a genuinely new call, and keeps a backgrounded task live", async () => {
		// Negative control. "Never mount anything twice" must not decay into
		// "never mount anything", and a `task` that reports async.state==="running"
		// has NOT settled — its card must keep taking updates after its end event.
		const { ctx, chatContainer, controller } = createFixture();
		await runToCompletion(controller, "bash");
		expect(toolCards(chatContainer).length).toBe(1);

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "call-second",
			toolName: "bash",
			args: { command: "echo hi" },
		} as unknown as AgentSessionEvent);
		expect(toolCards(chatContainer).length).toBe(2);

		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "call-task",
			toolName: "task",
			args: {},
		} as unknown as AgentSessionEvent);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "call-task",
			toolName: "task",
			result: { content: [{ type: "text", text: "spawned" }], details: { async: { state: "running" } } },
			isError: false,
		} as unknown as AgentSessionEvent);
		// Still live: not settled, still routable, and no duplicate card.
		expect(ctx.settledToolCalls.has("call-task")).toBe(false);
		expect(ctx.pendingTools.has("call-task")).toBe(true);
		expect(toolCards(chatContainer).length).toBe(3);
	});
});

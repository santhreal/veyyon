/**
 * The fake `AgentSession` a `runSubprocess` test spawns, in one place.
 *
 * WHAT IT IS FOR. `runSubprocess` runs an agent in-process: it calls `createAgentSession`, prompts
 * the session, and reads the session's EVENTS to decide what happened. A test therefore drives the
 * executor by deciding what the session emits per prompt, which is what {@link createMockSession}'s
 * one callback controls.
 *
 * WHY IT IS SHARED. Each executor suite grew its own copy of this object. They drifted in what they
 * stubbed, so a test could pass because its private mock happened to answer a method the real
 * session answers differently, and adding a member the executor started reading meant finding every
 * copy. One home also means one place to state the two non-obvious requirements below.
 *
 * A stalled session is NOT a different thing and does not need its own fake: `hangUntilAbort` makes
 * `prompt` and `waitForIdle` wait for an abort, which is what the wall-clock and hard-budget suites
 * need. Each option below says which executor read depends on it, so a suite that reaches for one is
 * choosing a documented behaviour rather than reinventing a session.
 */
import { vi } from "bun:test";
import type { Api, AssistantMessage, Model } from "@veyyon/ai";
import type { CreateAgentSessionResult } from "@veyyon/coding-agent/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "@veyyon/coding-agent/session/agent-session";
import { EventBus } from "@veyyon/coding-agent/utils/event-bus";

/** What the callback is handed on each `prompt` call. */
export interface MockPromptCall {
	readonly text: string;
	readonly options?: PromptOptions;
	/** 1 for the first prompt, so a callback can answer the reminder differently from the task. */
	readonly promptIndex: number;
	/** Emit a session event the executor will process, synchronously, inside this prompt. */
	readonly emit: (event: AgentSessionEvent) => void;
	/** The session's message list. Push here to make `getLastAssistantMessage` answer. */
	readonly state: { messages: AssistantMessage[] };
	/**
	 * Push a message AND emit its `message_end`, which is the pair the request accounting counts.
	 *
	 * The soft request budget counts assistant turns from `message_end` events, so a suite that
	 * pushes a message without emitting the event burns no budget and never reaches the stop
	 * threshold. Doing both here is what keeps that from being rediscovered per suite.
	 */
	readonly pushTurn: (message: AssistantMessage) => void;
}

/**
 * What the `waitForIdle` callback is handed, which is the OTHER point the executor drives events at.
 *
 * The executor prompts, then awaits idle, and some contracts depend on which of the two a turn's
 * events arrive during: the soft-budget guard aborts asynchronously, so a suite asserting how many
 * aborts had happened by the time a yield's `tool_execution_end` landed is asserting about ordering
 * inside one of those two windows. Keeping both windows available means such a suite can emit where
 * the real session would rather than where the fake happens to allow.
 */
export interface MockIdleCall {
	/** 1 for the first `waitForIdle`, so a callback can drive only the first turn. */
	readonly idleIndex: number;
	readonly emit: (event: AgentSessionEvent) => void;
	readonly state: { messages: AssistantMessage[] };
	readonly pushTurn: (message: AssistantMessage) => void;
}

/** What a suite may vary about the session itself, as opposed to what it emits. */
export interface MockSessionOptions {
	/**
	 * The value `session.model` reports.
	 *
	 * The executor reads it in exactly one place: `buildNamedToolChoice(YIELD_TOOL_NAME,
	 * session.model)`, which returns `undefined` without a model and an api-shaped choice with one.
	 * So a suite asserting a forced-yield reminder's `toolChoice` has to set this, and every other
	 * suite is right to leave it off.
	 */
	readonly model?: Partial<Model<Api>>;
	/**
	 * The tool names the session reports active, defaulting to `["read", "yield"]`.
	 *
	 * `yield` being present is load-bearing: the executor checks a subagent can answer before it
	 * starts reminding it to, so dropping it takes a different path.
	 */
	readonly activeToolNames?: readonly string[];
	/**
	 * Make `prompt` and `waitForIdle` hang until something aborts the session.
	 *
	 * This is how a stalled provider stream is modelled: the executor's own guards (the wall clock,
	 * the hard request budget) are the only things that can end the run, which is exactly what those
	 * suites assert. `abort` releases the hang, so the run then finalizes normally.
	 */
	readonly hangUntilAbort?: boolean;
	/**
	 * Run when the executor aborts the session, before the hang is released.
	 *
	 * One suite needs it: a late `yield` arriving during teardown, after the wall clock already
	 * aborted. The event has to be emitted from inside `abort` to land in that window, and the
	 * contract is that it must not flip a timed-out run to success.
	 */
	readonly onAbort?: (call: { readonly emit: (event: AgentSessionEvent) => void }) => void;
	/** Drive events from `waitForIdle` instead of from `prompt`. See {@link MockIdleCall}. */
	readonly onWaitForIdle?: (call: MockIdleCall) => void | Promise<void>;
	/**
	 * The child's loaded argot codec, answered from `getArgotSession()`.
	 *
	 * Load-bearing at the return boundary: handle-form text a child emits (a streamed delta, a
	 * salvaged last turn, a yielded result) is expanded through the CHILD's codec before it can become
	 * the parent's tool result, so a suite about that seam has to give the child one. Left undefined,
	 * the child has no shorthand and text passes through as written.
	 */
	readonly argotSession?: unknown;
}

/** The session plus what a suite needs to observe about how the executor drove it. */
export interface MockSessionHandle {
	readonly session: AgentSession;
	/** Every `prompt` call in order, which is how a suite reads the reminder text and its options. */
	readonly prompts: ReadonlyArray<{ readonly text: string; readonly options?: PromptOptions }>;
	/** How many times the executor aborted the session, which distinguishes a soft stop from a kill. */
	abortCalls(): number;
	/** How many times it disposed it: a resumable park leaves the session alive, a terminal abort does not. */
	disposeCalls(): number;
	/**
	 * Every `sendUserMessage` the executor made, which is how the soft-budget steering notice is read.
	 *
	 * The notice is delivered INTO the child session rather than returned, so a suite that asserted
	 * only on the run's result could not tell one notice from none or from three.
	 */
	readonly steerCalls: ReadonlyArray<{ readonly content: string; readonly options?: { deliverAs?: string } }>;
}

/**
 * An assistant message that stopped on its own.
 *
 * `stopReason` is load-bearing rather than decoration: the executor reads the LAST assistant
 * message's stop reason when classifying the run, and treats `aborted` and `error` differently from
 * a plain stop.
 */
export function createAssistantStopMessage(
	text: string,
	stopReason: AssistantMessage["stopReason"] = "stop",
	usage: Partial<AssistantMessage["usage"]> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		// Zero by default, overridable because the executor sums a run's tokens from these and reports
		// them on the result: a suite asserting "150 tok" or a context-token figure has to set them.
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			...usage,
		},
		stopReason,
		timestamp: Date.now(),
	};
}

/**
 * An assistant message whose only content is one tool call, which is how a subagent yields.
 *
 * The stop reason is `toolUse` rather than `stop`, because that is what the model reports when it
 * ended a turn to call a tool, and the executor classifies the two differently.
 */
export function createAssistantToolCallMessage(
	toolName: string,
	toolCallId: string,
	args: Record<string, unknown>,
): AssistantMessage {
	return {
		...createAssistantStopMessage("", "toolUse"),
		content: [{ type: "toolCall", id: toolCallId, name: toolName, arguments: args }],
	};
}

/**
 * A session that emits whatever `onPrompt` emits, plus what a suite can observe about it.
 *
 * Prefer {@link createMockSession} unless you need the handle: a suite that only decides what the
 * session emits should not have to name the counters it ignores.
 *
 * Details a caller relies on and would otherwise have to rediscover:
 *
 * - `subscribe` returns a real unsubscribe, because the executor unsubscribes when the run ends and a
 *   no-op there leaks the listener into the next test in the file.
 * - `getActiveToolNames` includes `yield`. The executor checks that a subagent can actually answer
 *   before it starts reminding it to; a session with no `yield` tool takes a different path.
 * - `prompt` resolves after the callback, so the executor sees a turn that ended. A fake whose
 *   `prompt` never resolves is a different subject on purpose (`executor-wall-clock.test.ts`).
 * - `deliverIrcMessage` answers `"woken"`, which is what makes a parked agent reachable: the irc bus
 *   asks the live session, so a session that cannot answer reads as a dead agent.
 */
export function createMockSessionHandle(
	onPrompt: (call: MockPromptCall) => void | Promise<void>,
	options: MockSessionOptions = {},
): MockSessionHandle {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const state = { messages: [] as AssistantMessage[] };
	const prompts: Array<{ text: string; options?: PromptOptions }> = [];
	const steerCalls: Array<{ content: string; options?: { deliverAs?: string } }> = [];
	let promptIndex = 0;
	let idleIndex = 0;
	let abortCount = 0;
	let disposeCount = 0;
	const { promise: hang, resolve: releaseHang } = Promise.withResolvers<void>();
	if (!options.hangUntilAbort) releaseHang();

	// A copy, because a listener that unsubscribes during dispatch would otherwise shift the array
	// under the loop and skip the next listener.
	const emit = (event: AgentSessionEvent) => {
		for (const listener of [...listeners]) listener(event);
	};

	const pushTurn = (message: AssistantMessage) => {
		state.messages.push(message);
		emit({ type: "message_end", message } as unknown as AgentSessionEvent);
	};

	const session = {
		state,
		agent: { state: { systemPrompt: ["test"] } },
		model: options.model,
		extensionRunner: undefined,
		sessionManager: {
			appendSessionInit: () => {},
		},
		getActiveToolNames: () => [...(options.activeToolNames ?? ["read", "yield"])],
		setActiveToolsByName: async (_toolNames: string[]) => {},
		getArgotSession: () => options.argotSession,
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (text: string, promptOptions?: PromptOptions) => {
			promptIndex += 1;
			prompts.push({ text, options: promptOptions });
			await onPrompt({ text, options: promptOptions, promptIndex, emit, state, pushTurn });
			await hang;
			return true;
		},
		waitForIdle: async () => {
			idleIndex += 1;
			await options.onWaitForIdle?.({ idleIndex, emit, state, pushTurn });
			await hang;
		},
		getLastAssistantMessage: () => state.messages[state.messages.length - 1],
		sendUserMessage: async (content: unknown, sendOptions?: { deliverAs?: string }) => {
			steerCalls.push({ content: String(content), options: sendOptions });
		},
		// A spy rather than a stub: autoloaded skills are injected through this BEFORE the task
		// prompt, so the suite that owns that contract asserts both the payloads and the ordering.
		sendCustomMessage: vi.fn(async () => {}),
		deliverIrcMessage: async () => "woken",
		abort: async () => {
			abortCount += 1;
			options.onAbort?.({ emit });
			releaseHang();
		},
		dispose: async () => {
			disposeCount += 1;
		},
	};

	return {
		session: session as unknown as AgentSession,
		prompts,
		steerCalls,
		abortCalls: () => abortCount,
		disposeCalls: () => disposeCount,
	};
}

/** {@link createMockSessionHandle} for the common case: a suite that only drives events. */
export function createMockSession(
	onPrompt: (call: MockPromptCall) => void | Promise<void>,
	options: MockSessionOptions = {},
): AgentSession {
	return createMockSessionHandle(onPrompt, options).session;
}

/**
 * The successful `yield` event, which is how a subagent says it is finished with a result.
 *
 * `extraDetails` carries the rest of the yield protocol: `type` labels an INCREMENTAL section, which
 * saves work without ending the run, so a suite about partial delivery passes it and a suite about
 * finishing does not.
 */
export function yieldSuccessEvent(
	data: unknown,
	toolCallId = "tool-yield",
	extraDetails: Record<string, unknown> = {},
): AgentSessionEvent {
	return {
		type: "tool_execution_end",
		toolCallId,
		toolName: "yield",
		result: {
			content: [{ type: "text", text: "Result submitted." }],
			details: { status: "success", data, ...extraDetails },
		},
		isError: false,
	} as AgentSessionEvent;
}

/**
 * A `yield` the tool REJECTED, which is not a result.
 *
 * The distinction is the whole contract: a rejected yield leaves the run unfinished, so the executor
 * must keep waiting instead of finalizing the arguments the child tried to submit.
 */
export function yieldRejectedEvent(data: unknown, toolCallId = "tool-yield-rejected"): AgentSessionEvent {
	return {
		type: "tool_execution_end",
		toolCallId,
		toolName: "yield",
		result: {
			content: [{ type: "text", text: "Yield rejected." }],
			details: { status: "error", data },
		},
		isError: true,
	} as AgentSessionEvent;
}

/** Wrap a session the way `createAgentSession` resolves it, for `vi.spyOn(...).mockResolvedValue`. */
export function createSessionResult(session: AgentSession): CreateAgentSessionResult {
	return {
		session,
		extensionsResult:
			{} as unknown as import("@veyyon/coding-agent/extensibility/extensions/types").LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	};
}

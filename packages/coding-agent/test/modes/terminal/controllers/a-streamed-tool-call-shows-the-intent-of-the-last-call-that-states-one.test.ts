/**
 * Contract: while an assistant message streams, the working message shows the intent of the last tool call that
 * states one, set at most once per update, and no call before that one is read.
 *
 * WHY. The working message used to be set from every tool call in turn on every provider delta: a message with
 * several calls stating different intents set the loader text once per call per delta, and asked each earlier
 * call's tool to derive an intent that the next call replaced. The text the loader settled on was the last call's,
 * so the earlier work changed nothing a person could see.
 *
 * THE CLASS. Every way a call can state an intent (its intent field, padded, blank or not a string, a tool resolver
 * deriving one, deriving a blank one or throwing, no intent at all) as the earlier and as the later of two calls,
 * with the session running and aborting. The expected text is the later call's intent when it states one, else the
 * earlier call's.
 *
 * WHAT THIS DOES NOT CATCH. A message of three or more calls is covered only through the rule the pairs pin: an
 * implementation that reads the last two calls and stops passes. A new way of stating an intent is not in the sweep
 * until it is added to STATEMENTS.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage, ToolCall } from "@veyyon/ai";
import { resetSettingsForTest, Settings, settings } from "@veyyon/coding-agent/config/settings";
import { EventController } from "@veyyon/coding-agent/modes/terminal/controllers/event-controller";
import { interruptHint } from "@veyyon/coding-agent/modes/terminal/shared";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/terminal/types";
import type { AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session-types";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { INTENT_FIELD } from "@veyyon/wire";

beforeAll(async () => {
	await initTheme();
});

beforeEach(async () => {
	await Settings.init({ inMemory: true, cwd: process.cwd() });
});

afterEach(() => {
	resetSettingsForTest();
	vi.restoreAllMocks();
});

/** Paths each resolver was asked to derive an intent for. */
const derivedFor: string[] = [];

const TOOLS: Record<string, { name: string; label: string; intent?: (args: { path?: string }) => string }> = {
	plain: { name: "plain", label: "plain" },
	derives: {
		name: "derives",
		label: "derives",
		intent: args => {
			derivedFor.push(args.path ?? "");
			return ` Derived ${args.path} `;
		},
	},
	"derives-blank": {
		name: "derives-blank",
		label: "derives-blank",
		intent: args => {
			derivedFor.push(args.path ?? "");
			return "   ";
		},
	},
	throws: {
		name: "throws",
		label: "throws",
		intent: args => {
			derivedFor.push(args.path ?? "");
			throw new Error("resolver failed");
		},
	},
};

interface Statement {
	tool: string;
	args: (path: string) => Record<string, unknown>;
	/** The working message text the call alone produces. */
	shows: (path: string) => string | undefined;
	/** The call's tool resolver runs when it is read. */
	derives: boolean;
}

/** Every way a streamed tool call can state, or fail to state, an intent. */
const STATEMENTS: Record<string, Statement> = {
	"intent field": {
		tool: "plain",
		args: path => ({ [INTENT_FIELD]: `Reading ${path}`, path }),
		shows: path => `Reading ${path}`,
		derives: false,
	},
	"padded intent field": {
		tool: "plain",
		args: path => ({ [INTENT_FIELD]: `  Writing ${path}  `, path }),
		shows: path => `Writing ${path}`,
		derives: false,
	},
	"blank intent field": {
		tool: "plain",
		args: path => ({ [INTENT_FIELD]: "   ", path }),
		shows: () => undefined,
		derives: false,
	},
	"numeric intent field": {
		tool: "plain",
		args: path => ({ [INTENT_FIELD]: 7, path }),
		shows: () => undefined,
		derives: false,
	},
	"object intent field": {
		tool: "plain",
		args: path => ({ [INTENT_FIELD]: { text: "nested" }, path }),
		shows: () => undefined,
		derives: false,
	},
	"invalid intent field on a deriving tool": {
		tool: "derives",
		args: path => ({ [INTENT_FIELD]: false, path }),
		shows: () => undefined,
		derives: false,
	},
	"derived intent": {
		tool: "derives",
		args: path => ({ path }),
		shows: path => `Derived ${path}`,
		derives: true,
	},
	"blank derived intent": {
		tool: "derives-blank",
		args: path => ({ path }),
		shows: () => undefined,
		derives: true,
	},
	"throwing resolver": {
		tool: "throws",
		args: path => ({ path }),
		shows: () => undefined,
		derives: true,
	},
	"no intent": {
		tool: "plain",
		args: path => ({ path }),
		shows: () => undefined,
		derives: false,
	},
};

function toolCall(id: string, statement: Statement, path: string): ToolCall {
	return { type: "toolCall", id, name: statement.tool, arguments: statement.args(path) };
}

function streamingMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "toolUse",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 0,
	};
}

function createFixture(isAborting: boolean) {
	const setWorkingMessage = vi.fn();
	const ctx = {
		isInitialized: true,
		init: vi.fn(async () => {}),
		ui: { requestRender: vi.fn(), requestComponentRender: vi.fn() },
		settings,
		statusLine: { invalidate: vi.fn() },
		streamingComponent: {
			updateContent: vi.fn(),
			markTranscriptBlockFinalized: vi.fn(),
			setHideThinkingBlock: vi.fn(),
		},
		streamingMessage: streamingMessage([]),
		pendingTools: new Map(),
		// Settled calls mount no tool card; the working message reads every streamed call regardless.
		settledToolCalls: new Set(["earlier", "later"]),
		noteDisplayableThinkingContent: vi.fn(() => false),
		chatContainer: { addChild: vi.fn() },
		toolOutputExpanded: false,
		session: { isAborting },
		viewSession: { getToolByName: (name: string) => TOOLS[name], isStreaming: true },
		sessionManager: { getCwd: () => "/repo" },
		ensureLoadingAnimation: vi.fn(),
		setWorkingMessage,
		refreshComposerShortcuts: vi.fn(),
		dismissWelcome: vi.fn(),
	} as unknown as InteractiveModeContext;
	return { controller: new EventController(ctx), setWorkingMessage };
}

async function dispatch(controller: EventController, message: AssistantMessage): Promise<void> {
	await controller.handleEvent({
		type: "message_update",
		message,
		assistantMessageEvent: undefined as never,
	} as Extract<AgentSessionEvent, { type: "message_update" }>);
}

const PAIRS = Object.keys(STATEMENTS).flatMap(earlier => Object.keys(STATEMENTS).map(later => [earlier, later]));

describe("a streamed tool call shows the intent of the last call that states one", () => {
	it.each(PAIRS)("%s, then %s", async (earlierName, laterName) => {
		const earlier = STATEMENTS[earlierName]!;
		const later = STATEMENTS[laterName]!;
		const expected = later.shows("b.ts") ?? earlier.shows("a.ts");
		const { controller, setWorkingMessage } = createFixture(false);
		derivedFor.length = 0;
		const message = streamingMessage([toolCall("earlier", earlier, "a.ts"), toolCall("later", later, "b.ts")]);

		await dispatch(controller, message);

		expect(setWorkingMessage.mock.calls).toEqual(expected === undefined ? [] : [[`${expected}${interruptHint()}`]]);
		// The earlier call is read only when the later one states nothing.
		const expectedDerivations = [
			...(later.derives ? ["b.ts"] : []),
			...(earlier.derives && later.shows("b.ts") === undefined ? ["a.ts"] : []),
		];
		expect(derivedFor).toEqual(expectedDerivations);

		// The same snapshot again changes nothing the loader shows.
		await dispatch(controller, message);
		expect(setWorkingMessage).toHaveBeenCalledTimes(expected === undefined ? 0 : 1);
	});

	it.each(PAIRS)("%s, then %s, while the session aborts", async (earlierName, laterName) => {
		const { controller, setWorkingMessage } = createFixture(true);
		const message = streamingMessage([
			toolCall("earlier", STATEMENTS[earlierName]!, "a.ts"),
			toolCall("later", STATEMENTS[laterName]!, "b.ts"),
		]);

		await dispatch(controller, message);

		expect(setWorkingMessage).not.toHaveBeenCalled();
	});

	it("follows the last call as a later call starts stating an intent", async () => {
		const { controller, setWorkingMessage } = createFixture(false);
		const first = toolCall("earlier", STATEMENTS["intent field"]!, "a.ts");

		await dispatch(controller, streamingMessage([first]));
		await dispatch(controller, streamingMessage([first, toolCall("later", STATEMENTS["no intent"]!, "b.ts")]));
		await dispatch(controller, streamingMessage([first, toolCall("later", STATEMENTS["intent field"]!, "b.ts")]));

		expect(setWorkingMessage.mock.calls).toEqual([
			[`Reading a.ts${interruptHint()}`],
			[`Reading b.ts${interruptHint()}`],
		]);
	});
});

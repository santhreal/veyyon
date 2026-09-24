/**
 * WHY: a screen that attaches to a conversation mid-answer (entering a room
 * member, `/resume` of a running hand-off, viewing an agent) rebuilds the
 * transcript from the finished messages, and the message being written is not
 * one of them. Before `EventController.resumeTurn`, the answer so far appeared
 * only when the next delta arrived; a conversation whose provider was slow to
 * send one showed its prompt and nothing under it, although the room view had
 * drawn the answer a moment earlier.
 *
 * The class: every attach path rebuilds, then resumes. This suite is the
 * contract of the one method those paths share: the answer so far is on screen
 * at once (not re-typed by the smooth reveal), the turn is armed, the next delta
 * extends the same block rather than opening a second, a session that is not
 * mid-answer gets nothing, the footline clock reads the turn's age rather than
 * the time since the screen arrived (re-anchoring one left open by an earlier
 * turn), and the answer so far is the display form the event stream shows: a
 * real session with an argot vocabulary, whose raw stream message still holds
 * the `§handle`, opens with the handle expanded.
 *
 * What it does NOT catch: a caller that forgets to call `resumeTurn` after its
 * rebuild. The room controller and live `/resume` paths call it; their own
 * suites drive them.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Agent } from "@veyyon/agent-core";
import type { AssistantMessage, AssistantMessageEvent, Usage } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings, settings } from "@veyyon/coding-agent/config/settings";
import { StatusLineComponent } from "@veyyon/coding-agent/modes/terminal/components/status-line/component";
import { AssistantMessageComponent } from "@veyyon/coding-agent/modes/terminal/components/transcript/assistant-message";
import { TranscriptContainer } from "@veyyon/coding-agent/modes/terminal/components/transcript/transcript-container";
import { EventController } from "@veyyon/coding-agent/modes/terminal/controllers/event-controller";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/terminal/types";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session-types";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import type { TUI } from "@veyyon/tui";
import { TempDir } from "@veyyon/utils";
import { ArgotSession, type Vocabulary } from "argot";
import {
	beginSettingsTest,
	restoreSettingsTestState,
	type SettingsTestState,
} from "../../../helpers/settings-test-state";
import { makeStatusLineProducer } from "../../../helpers/status-line-session";

const SO_FAR = "Here is the list so far: one, two, three";
const NEXT = " and four";
const DB = "src/db.ts";

function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function answer(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "cursor",
		provider: "cursor",
		model: "cursor-model",
		stopReason: "stop",
		usage: zeroUsage(),
		timestamp: 1,
	};
}

/** An anthropic assistant message holding `content`, for the real session's stream. */
function answerOf(content: AssistantMessage["content"], overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: zeroUsage(),
		timestamp: 2,
		...overrides,
	};
}

function codec(): ArgotSession {
	const vocab: Vocabulary = { version: 1, sigil: "§", handles: new Map([["db", DB]]), meta: new Map() };
	const session = new ArgotSession();
	session.loadVocab(vocab);
	return session;
}

let tempDir: TempDir;
const storages: AuthStorage[] = [];
const opened: AgentSession[] = [];

beforeAll(() => {
	tempDir = TempDir.createSync("@pi-mid-answer-");
});

afterAll(async () => {
	for (const session of opened.splice(0)) await session.dispose();
	for (const storage of storages.splice(0)) storage.close();
	tempDir.removeSync();
});

interface Running {
	session: AgentSession;
	/** Resolves once the provider has been asked for the running turn. */
	called: Promise<void>;
	/** Push a provider stream event into the turn in flight. */
	push(event: AssistantMessageEvent): void;
}

/** A real session with an argot vocabulary, whose provider stream the test drives. */
async function running(argot: ArgotSession): Promise<Running> {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected the bundled anthropic model to exist");
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), `auth-${storages.length}.db`));
	storages.push(authStorage);
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	const called = Promise.withResolvers<void>();
	let stream: AssistantMessageEventStream | undefined;
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		streamFn: (_model, _context, streamOptions) => {
			const current = new AssistantMessageEventStream();
			stream = current;
			streamOptions?.signal?.addEventListener(
				"abort",
				() => current.push({ type: "error", reason: "aborted", error: answerOf([], { stopReason: "aborted" }) }),
				{ once: true },
			);
			called.resolve();
			return current;
		},
	});
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(tempDir.path()),
		settings: Settings.isolated(),
		modelRegistry,
		argot,
	});
	opened.push(session);
	return {
		session,
		called: called.promise,
		push: event => {
			if (!stream) throw new Error("No turn is running");
			stream.push(event);
		},
	};
}

/** Wait, bounded, for `read` to hold. A hang is a failure, not a stall. */
async function until(read: () => boolean, what: string, ms = 3_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!read()) {
		if (Date.now() > deadline) throw new Error(`Timed out after ${ms}ms waiting for ${what}`);
		await sleep(2);
	}
}

interface Fixture {
	controller: EventController;
	chatContainer: TranscriptContainer;
	/** The footline the controller starts its clock on. */
	statusLine: StatusLineComponent;
	/** The turn events the controller armed itself with. */
	armed: string[];
}

interface StubSession {
	isStreaming: boolean;
	displayedStreamMessage: AssistantMessage | undefined;
	turnStartedAt: number | undefined;
	/** Deliver `event` to the attached controller as the session would. */
	emit(event: AgentSessionEvent): Promise<void>;
}

/** A session that is `streaming` and has `partial` in flight, in display form. */
function stubSession(options: {
	streaming: boolean;
	partial: AssistantMessage | undefined;
	turnStartedAt?: number;
}): StubSession {
	let listener: ((event: AgentSessionEvent) => Promise<void>) | undefined;
	return {
		isStreaming: options.streaming,
		displayedStreamMessage: options.partial,
		turnStartedAt: options.turnStartedAt,
		messages: [],
		subscribe: (next: (event: AgentSessionEvent) => Promise<void>) => {
			listener = next;
			return () => {};
		},
		getToolByName: () => undefined,
		extensionRunner: undefined,
		isTtsrAbortPending: false,
		retryAttempt: 0,
		emit: async event => {
			await listener?.(event);
		},
	} as StubSession;
}

/**
 * A real EventController over a real transcript container, attached to
 * `session`. `agent_start` is recorded rather than run: arming the loader is
 * the working-loader suites' contract, and here only whether the turn was
 * armed matters.
 */
function attached(session: StubSession | AgentSession): Fixture {
	const chatContainer = new TranscriptContainer();
	const statusLine = new StatusLineComponent(makeStatusLineProducer());
	const ctx = {
		isInitialized: true,
		init: vi.fn(async () => {}),
		ui: { requestRender: vi.fn(), requestComponentRender: vi.fn(), imageBudget: undefined } as unknown as TUI,
		settings,
		chatContainer,
		pendingTools: new Map(),
		settledToolCalls: new Set<string>(),
		toolOutputExpanded: false,
		effectiveHideThinkingBlock: false,
		proseOnlyThinking: true,
		statusLine,
		noteDisplayableThinkingContent: vi.fn(() => false),
		ensureLoadingAnimation: vi.fn(),
		session,
		viewSession: session,
		sessionManager: { getCwd: () => process.cwd() },
		showWarning: vi.fn(),
		showPinnedError: vi.fn(),
		clearTransientSessionUi: vi.fn(),
		lastAssistantUsage: zeroUsage(),
		refreshComposerShortcuts: vi.fn(),
		dismissWelcome: vi.fn(),
	} as unknown as InteractiveModeContext;
	const controller = new EventController(ctx);
	const armed: string[] = [];
	const handle = controller.handleEvent.bind(controller);
	controller.handleEvent = async (event: AgentSessionEvent) => {
		if (event.type === "agent_start") {
			armed.push(event.type);
			return;
		}
		await handle(event);
	};
	controller.attachTo(session as unknown as AgentSession);
	return { controller, chatContainer, statusLine, armed };
}

function assistantBlocks(chatContainer: TranscriptContainer): number {
	return chatContainer.children.filter(child => child instanceof AssistantMessageComponent).length;
}

function screen(chatContainer: TranscriptContainer): string {
	return chatContainer.render(100).join("\n");
}

describe("a conversation entered mid-answer", () => {
	let settingsState: SettingsTestState | undefined;
	let fixture: Fixture | undefined;

	beforeAll(async () => {
		await initTheme(false);
	});

	beforeEach(async () => {
		settingsState = beginSettingsTest();
		// Smooth streaming on: a resumed answer that re-typed itself from nothing
		// would show an empty block on the first frame.
		await Settings.init({ inMemory: true, overrides: { "display.smoothStreaming": true } });
	});

	afterEach(() => {
		fixture?.controller.resetTranscriptAnchors();
		fixture = undefined;
		vi.restoreAllMocks();
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
	});

	it("shows the answer so far at once and arms the turn", async () => {
		fixture = attached(stubSession({ streaming: true, partial: answer(SO_FAR) }));

		await fixture.controller.resumeTurn();

		expect(fixture.armed).toEqual(["agent_start"]);
		expect(assistantBlocks(fixture.chatContainer)).toBe(1);
		expect(screen(fixture.chatContainer)).toContain(SO_FAR);
	});

	/**
	 * The room window beside it said how long the turn had run; the footline
	 * after entering says the same, not the seconds since the screen arrived.
	 */
	it("starts the footline clock where the turn started, not where the screen arrived", async () => {
		vi.spyOn(Date, "now").mockReturnValue(100_000);
		fixture = attached(stubSession({ streaming: true, partial: answer(SO_FAR), turnStartedAt: 59_000 }));

		await fixture.controller.resumeTurn();

		expect(fixture.statusLine.getRunClock().runningMs).toBe(41_000);
	});

	it("re-anchors a clock left open by an earlier turn at the running one", async () => {
		vi.spyOn(Date, "now").mockReturnValue(10_000);
		fixture = attached(stubSession({ streaming: true, partial: answer(SO_FAR), turnStartedAt: 90_000 }));
		fixture.statusLine.markActivityStart();
		vi.spyOn(Date, "now").mockReturnValue(100_000);

		await fixture.controller.resumeTurn();

		expect(fixture.statusLine.getRunClock().runningMs).toBe(10_000);
	});

	it("starts the clock on arrival when the turn's start is unknown", async () => {
		vi.spyOn(Date, "now").mockReturnValue(100_000);
		fixture = attached(stubSession({ streaming: true, partial: undefined }));

		await fixture.controller.resumeTurn();

		expect(fixture.statusLine.getRunClock().runningMs).toBe(0);
	});

	it("extends that answer with the next delta instead of opening a second one", async () => {
		const session = stubSession({ streaming: true, partial: answer(SO_FAR) });
		fixture = attached(session);
		await fixture.controller.resumeTurn();

		await session.emit({
			type: "message_update",
			message: answer(SO_FAR + NEXT),
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: NEXT, partial: answer(SO_FAR + NEXT) },
		} as AgentSessionEvent);

		expect(assistantBlocks(fixture.chatContainer)).toBe(1);
	});

	it("arms the turn and opens nothing while the first token has not arrived", async () => {
		fixture = attached(stubSession({ streaming: true, partial: undefined }));

		await fixture.controller.resumeTurn();

		expect(fixture.armed).toEqual(["agent_start"]);
		expect(assistantBlocks(fixture.chatContainer)).toBe(0);
	});

	it("leaves a conversation that is not answering as the rebuild drew it", async () => {
		fixture = attached(stubSession({ streaming: false, partial: answer(SO_FAR) }));

		await fixture.controller.resumeTurn();

		expect(fixture.armed).toEqual([]);
		expect(assistantBlocks(fixture.chatContainer)).toBe(0);
	});

	/**
	 * The session stores and streams cheap `§handle`s; listeners receive the
	 * expansion. A screen entering mid-answer opens with the display form. The
	 * negative control reads the same session's model-form stream message and
	 * finds the handle, so the expansion on screen is the seam at work.
	 */
	it("opens the answer so far with argot handles expanded, not in the model's form", async () => {
		const live = await running(codec());
		const turn = live.session.prompt("check the schema");
		try {
			await Promise.race([live.called, turn]);
			live.push({ type: "start", partial: answerOf([]) });
			const writing = answerOf([{ type: "text", text: "Opening §db now." }]);
			live.push({ type: "text_delta", contentIndex: 0, delta: "Opening §db now.", partial: writing });
			await until(() => live.session.displayedStreamMessage?.content.length === 1, "the streamed text");

			fixture = attached(live.session);
			await fixture.controller.resumeTurn();

			const drawn = screen(fixture.chatContainer);
			expect(drawn).toContain(`Opening ${DB} now.`);
			expect(drawn).not.toContain("§");
			const raw = live.session.agent.state.streamMessage;
			if (raw?.role !== "assistant") throw new Error("Expected the raw stream message to be the assistant's");
			expect(raw.content).toEqual([{ type: "text", text: "Opening §db now." }]);
		} finally {
			if (live.session.isStreaming) await live.session.abort();
			await turn;
		}
	});

	it("a real session says when its running turn started, and nothing between turns", async () => {
		const live = await running(codec());
		expect(live.session.turnStartedAt).toBeUndefined();
		const before = Date.now();
		const turn = live.session.prompt("check the schema");
		try {
			await Promise.race([live.called, turn]);
			await until(() => live.session.turnStartedAt !== undefined, "the turn's start");
			expect(live.session.turnStartedAt).toBeGreaterThanOrEqual(before);
			expect(live.session.turnStartedAt).toBeLessThanOrEqual(Date.now());
		} finally {
			if (live.session.isStreaming) await live.session.abort();
			await turn;
		}
		await until(() => live.session.turnStartedAt === undefined, "the turn's start to clear");
	});
});

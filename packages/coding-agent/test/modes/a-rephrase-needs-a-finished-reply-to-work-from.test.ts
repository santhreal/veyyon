/**
 * WHY: `/rephrase` submits a fixed instruction asking for the reply just given again, in plainer
 * prose. A turn is the wrong thing to spend on a reply that is not there, and the model cannot
 * restate an answer it has not written, so the command has one precondition: the conversation is
 * resting on a finished reply.
 *
 * "Resting on a finished reply" is `AgentSession.hasTerminalTextAnswerWithoutQueuedWork` — the last
 * turn ended on its own with text for the user and nothing is queued behind it — plus the mode's
 * own busy check, which stays true through compaction and post-turn work. The two are separate
 * questions and both have to hold: the session predicate reads the transcript, which does not
 * change while compaction runs, so the transcript alone would say yes at a moment when the user is
 * looking at a screen that is about to be rewritten.
 *
 * The class this closes: every state that is not a finished reply refuses, and refusal is silent
 * about nothing — the user is told why. The states are enumerated from the shapes a turn can end
 * in rather than from the one that was reported: no turn at all, a turn still running, a turn that
 * ended without saying anything, and a turn whose answer is already superseded by queued work.
 *
 * What it does not catch: whether the model honors the instruction it receives (that is the
 * model's behavior, not the command's), and the registry-to-mode dispatch, which is a typed
 * one-line delegation the architecture suite already proves exists for every declared command.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTool } from "@veyyon/agent-core";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { submitInteractiveInput } from "@veyyon/coding-agent/main";
import { InteractiveMode } from "@veyyon/coding-agent/modes/terminal/interactive-mode";
import type { SubmittedUserInput } from "@veyyon/coding-agent/modes/terminal/types";
import { requestsPrompts } from "@veyyon/coding-agent/prompts/requests/rows";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { AuthStorage } from "@veyyon/kernel/session/auth-storage";
import { TempDir } from "@veyyon/utils";
import { type } from "arktype";

interface MockResponseScript {
	content?: ReadonlyArray<
		string | { type: "toolCall"; id?: string; name: string; arguments: Record<string, unknown> }
	>;
	stopReason?: "stop" | "toolUse";
	throw?: string;
}

async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

describe("/rephrase needs a finished reply to work from", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let warnings: string[];

	beforeAll(() => {
		initTheme();
	});

	const build = async (responses: MockResponseScript[] | AsyncGenerator<MockResponseScript>): Promise<void> => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-rephrase-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("openai", "openai-test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const model = getBundledModel("openai", "gpt-5");
		if (!model) throw new Error("Expected bundled openai/gpt-5 test model");

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"contextPromotion.enabled": false,
			"retry.maxRetries": 0,
			"todo.enabled": false,
			"todo.reminders": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		const noteTool: AgentTool = {
			name: "note",
			label: "Note",
			description: "Record a note",
			parameters: type({}),
			execute: async () => ({ content: [{ type: "text" as const, text: "noted" }] }),
		};

		const scripted = createMockModel({ responses });
		const agent = new Agent({
			getApiKey: () => "openai-test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [noteTool], messages: [] },
			streamFn: (requestedModel, context, options) => scripted.stream(requestedModel, context, options),
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map([[noteTool.name, noteTool]]),
			builtInToolNames: ["note"],
		});

		mode = new InteractiveMode(session, "test");
		vi.spyOn(mode, "addMessageToChat").mockReturnValue([]);
		vi.spyOn(mode, "ensureLoadingAnimation").mockImplementation(() => {});
		warnings = [];
		vi.spyOn(mode, "showWarning").mockImplementation(message => {
			warnings.push(message);
		});
		mode.ui.requestRender = vi.fn();
		await mode.init();
		await flushMicrotasks();
	};

	/** One completed user turn, driven through the interactive loop's own submit path. */
	const runTurn = async (text: string): Promise<void> => {
		await submitInteractiveInput(mode, session, mode.startPendingSubmission({ text }));
		await session.waitForIdle();
		await flushMicrotasks();
	};

	/**
	 * Arm the composer the way the interactive loop does, run the command, and report what it
	 * submitted — `undefined` when it submitted nothing, which is the refusal under test.
	 */
	const rephrase = async (): Promise<SubmittedUserInput | undefined> => {
		const submitted: SubmittedUserInput[] = [];
		void mode.getUserInput().then(input => submitted.push(input));
		await flushMicrotasks();
		mode.handleRephraseCommand();
		await flushMicrotasks();
		if (submitted.length === 0) mode.onInputCallback = undefined;
		return submitted.at(0);
	};

	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(async () => {
		mode?.stop();
		vi.useRealTimers();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("sends the registered instruction once the reply has landed", async () => {
		await build([{ content: ["Here is a long and involved answer."], stopReason: "stop" }]);
		await runTurn("explain the thing");

		const submitted = await rephrase();
		expect(submitted?.text).toBe(requestsPrompts["requests/rephrase"].text.trim());
		expect(submitted?.text.length).toBeGreaterThan(0);
		expect(warnings).toEqual([]);
	});

	it("refuses when the session has no reply at all", async () => {
		await build([{ content: ["unused"], stopReason: "stop" }]);

		expect(await rephrase()).toBeUndefined();
		expect(warnings).toEqual(["Nothing to rephrase yet — /rephrase needs a finished reply to work from."]);
	});

	it("refuses while the reply is still being written", async () => {
		// A real in-flight turn: the generator holds the second response until this test releases
		// it, so the session is genuinely streaming rather than reporting that it is.
		const secondTurn = Promise.withResolvers<void>();
		await build(
			(async function* () {
				yield { content: ["Here is a long and involved answer."], stopReason: "stop" as const };
				await secondTurn.promise;
				yield { content: ["And another."], stopReason: "stop" as const };
			})(),
		);
		await runTurn("explain the thing");

		const inFlight = submitInteractiveInput(mode, session, mode.startPendingSubmission({ text: "and again" }));
		await flushMicrotasks();
		expect(session.isStreaming).toBe(true);

		expect(await rephrase()).toBeUndefined();
		expect(warnings).toEqual(["Nothing to rephrase yet — /rephrase needs a finished reply to work from."]);

		secondTurn.resolve();
		await inFlight;
		await session.waitForIdle();
	});

	/**
	 * The case the mode's busy check exists for, and the only one where it decides alone. Every
	 * other busy state also disturbs the transcript, so the session predicate refuses first and
	 * would keep the command correct on its own; post-turn work leaves the transcript resting on
	 * the finished answer, and the assertion below pins that. The state is installed rather than
	 * induced because what drains after a turn — compaction, memory extraction, title generation —
	 * needs its own model traffic to start, which would make the moment being tested a race.
	 */
	it("refuses while post-turn work is still draining", async () => {
		await build([{ content: ["Here is a long and involved answer."], stopReason: "stop" }]);
		await runTurn("explain the thing");
		expect(session.hasTerminalTextAnswerWithoutQueuedWork()).toBe(true);
		Object.defineProperty(session, "hasPostPromptWork", { get: () => true, configurable: true });

		expect(await rephrase()).toBeUndefined();
		expect(warnings).toEqual(["Nothing to rephrase yet — /rephrase needs a finished reply to work from."]);
	});

	it("refuses after a turn that ended without saying anything", async () => {
		await build([{ content: [], stopReason: "stop" }]);
		await runTurn("explain the thing");

		expect(await rephrase()).toBeUndefined();
		expect(warnings).toEqual(["Nothing to rephrase yet — /rephrase needs a finished reply to work from."]);
	});

	// A turn whose last act was a tool call has not answered yet, even though earlier text in the
	// same turn is sitting in the transcript. Scanning backwards for any assistant text would find
	// that earlier text and rephrase a sentence the model wrote on its way to the real answer.
	it("refuses after a turn whose last act was a tool call", async () => {
		await build([
			{ content: ["Let me check.", { type: "toolCall", name: "note", arguments: {} }], stopReason: "toolUse" },
			{ content: [], stopReason: "stop" },
		]);
		await runTurn("explain the thing");

		expect(await rephrase()).toBeUndefined();
		expect(warnings).toEqual(["Nothing to rephrase yet — /rephrase needs a finished reply to work from."]);
	});

	it("clears the composer whether it submits or refuses", async () => {
		await build([{ content: ["Here is a long and involved answer."], stopReason: "stop" }]);

		mode.editor.setText("/rephrase");
		expect(await rephrase()).toBeUndefined();
		expect(mode.editor.getText()).toBe("");

		await runTurn("explain the thing");
		mode.editor.setText("/rephrase");
		expect(await rephrase()).toBeDefined();
		expect(mode.editor.getText()).toBe("");
	});
});

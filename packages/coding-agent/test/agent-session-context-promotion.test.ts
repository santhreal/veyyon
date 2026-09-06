import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import * as compactionModule from "@veyyon/agent-core/compaction";
import type { AssistantMessage, Model, ProviderSessionState } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session-types";
import { TRUNCATION_MIN_TEXT_TOKENS } from "@veyyon/kernel/session/agent-session-compaction-policy";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";

describe("AgentSession context promotion", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let modelRegistry: ModelRegistry;
	let authStorage: AuthStorage;

	beforeAll(async () => {
		// ModelRegistry eagerly loads the immutable bundled model catalog in its
		// constructor (~100ms). The catalog and auth fixture never change between
		// tests here (tests only read models and add benign extra runtime keys),
		// so build them once instead of paying ~950ms across the 9 cases.
		tempDir = TempDir.createSync("@pi-context-promotion-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("openai-codex", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		vi.restoreAllMocks();
	});

	function createOverflowMessage(
		model: Model,
		errorMessage = "context_length_exceeded: Your input exceeds the context window of this model.",
	): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage,
			timestamp: Date.now(),
		};
	}

	function createIncompleteMessage(model: Model): AssistantMessage {
		// Mirrors what the codex/responses provider produces for `response.incomplete`:
		// stopReason "length", reasoning-only content, no actionable deliverable.
		return {
			role: "assistant",
			content: [{ type: "thinking", thinking: "" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "length",
			timestamp: Date.now(),
		};
	}

	function createUserMessage(content: string) {
		return {
			role: "user" as const,
			content,
			timestamp: Date.now(),
		};
	}

	function createAssistantMessage(model: Model, text = "ok"): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
	}

	async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (predicate()) return;
			await Bun.sleep(10);
		}
		throw new Error("Timed out waiting for condition");
	}

	// Deterministically drain the fire-and-forget `agent_end` handler that
	// `emitExternalEvent` dispatches. The handler's terminal maintenance work
	// (`#checkCompaction`) is microtask-based on the no-promotion paths, so a
	// single macrotask turn fully flushes it; `waitForIdle` then settles any
	// tracked continuation. Used by the negative tests, which assert that *no*
	// promotion happened and therefore need the handler to have actually run.
	async function settle(): Promise<void> {
		await new Promise(resolve => setTimeout(resolve, 0));
		await session.waitForIdle();
	}

	it("promotes to a larger-context model on overflow and clears codex websocket session state", async () => {
		const sparkModel = modelRegistry.find("openai-codex", "gpt-5.3-codex-spark");
		const codexModel = modelRegistry.find("openai-codex", "gpt-5.5");
		if (!sparkModel || !codexModel) {
			throw new Error("Expected codex spark and codex models to exist");
		}

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"contextPromotion.enabled": true,
		});

		const agent = new Agent({
			initialState: {
				model: sparkModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const closeSpy = vi.fn();
		session.providerSessionState.set("openai-codex-responses", {
			close: closeSpy,
		} satisfies ProviderSessionState);

		const overflowMessage = createOverflowMessage(sparkModel);
		session.agent.emitExternalEvent({ type: "message_end", message: overflowMessage });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [overflowMessage] });

		await waitFor(() => session.model?.id === codexModel.id);

		expect(session.model?.provider).toBe(codexModel.provider);
		expect(session.model?.id).toBe(codexModel.id);
		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState.size).toBe(0);
	});

	it("promotes on 413 payload-too-large overflow errors", async () => {
		const sparkModel = modelRegistry.find("openai-codex", "gpt-5.3-codex-spark");
		const codexModel = modelRegistry.find("openai-codex", "gpt-5.5");
		if (!sparkModel || !codexModel) {
			throw new Error("Expected codex spark and codex models to exist");
		}

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"contextPromotion.enabled": true,
		});

		const agent = new Agent({
			initialState: {
				model: sparkModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const overflowMessage = createOverflowMessage(
			sparkModel,
			"413 Request Entity Too Large: payload too large for model request body",
		);
		session.agent.emitExternalEvent({ type: "message_end", message: overflowMessage });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [overflowMessage] });

		await waitFor(() => session.model?.id === codexModel.id);

		expect(session.model?.provider).toBe(codexModel.provider);
		expect(session.model?.id).toBe(codexModel.id);
	});
	it("clears codex provider session state on manual setModel switch away from codex", async () => {
		const codexModel = modelRegistry.find("openai-codex", "gpt-5.3-codex");
		const nonCodexModel = modelRegistry.getAll().find(model => model.api !== "openai-codex-responses");
		if (!codexModel || !nonCodexModel) {
			throw new Error("Expected codex and non-codex models to exist");
		}
		authStorage.setRuntimeApiKey(nonCodexModel.provider, "test-other-key");

		const agent = new Agent({
			initialState: {
				model: codexModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		const closeSpy = vi.fn();
		session.providerSessionState.set("openai-codex-responses", {
			close: closeSpy,
		} satisfies ProviderSessionState);

		await session.setModel(nonCodexModel);

		expect(session.model?.provider).toBe(nonCodexModel.provider);
		expect(session.model?.id).toBe(nonCodexModel.id);
		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState.size).toBe(0);
	});

	it("clears codex provider session state on manual temporary switch into codex", async () => {
		const codexModel = modelRegistry.find("openai-codex", "gpt-5.3-codex");
		const nonCodexModel = modelRegistry.getAll().find(model => model.api !== "openai-codex-responses");
		if (!codexModel || !nonCodexModel) {
			throw new Error("Expected codex and non-codex models to exist");
		}
		authStorage.setRuntimeApiKey(nonCodexModel.provider, "test-other-key");

		const agent = new Agent({
			initialState: {
				model: nonCodexModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		const closeSpy = vi.fn();
		session.providerSessionState.set("openai-codex-responses", {
			close: closeSpy,
		} satisfies ProviderSessionState);

		await session.setModelTemporary(codexModel);

		expect(session.model?.provider).toBe(codexModel.provider);
		expect(session.model?.id).toBe(codexModel.id);
		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState.size).toBe(0);
	});

	it("clears codex provider session state when branching rewrites history", async () => {
		const codexModel = modelRegistry.find("openai-codex", "gpt-5.3-codex");
		if (!codexModel) {
			throw new Error("Expected codex model to exist");
		}

		const agent = new Agent({
			initialState: {
				model: codexModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		const firstUserId = session.sessionManager.appendMessage(createUserMessage("first"));
		session.sessionManager.appendMessage(createAssistantMessage(codexModel, "first response"));
		session.sessionManager.appendMessage(createUserMessage("second"));
		session.sessionManager.appendMessage(createAssistantMessage(codexModel, "second response"));
		const sessionContext = session.sessionManager.buildSessionContext();
		session.agent.replaceMessages(sessionContext.messages);

		const closeSpy = vi.fn();
		session.providerSessionState.set("openai-codex-responses", {
			close: closeSpy,
		} satisfies ProviderSessionState);

		const result = await session.branch(firstUserId);

		expect(result.cancelled).toBe(false);
		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState.size).toBe(0);
	});

	it("clears codex provider session state when tree navigation rewrites history", async () => {
		const codexModel = modelRegistry.find("openai-codex", "gpt-5.3-codex");
		if (!codexModel) {
			throw new Error("Expected codex model to exist");
		}

		const agent = new Agent({
			initialState: {
				model: codexModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		const firstUserId = session.sessionManager.appendMessage(createUserMessage("first"));
		session.sessionManager.appendMessage(createAssistantMessage(codexModel, "first response"));
		session.sessionManager.appendMessage(createUserMessage("second"));
		session.sessionManager.appendMessage(createAssistantMessage(codexModel, "second response"));
		const sessionContext = session.sessionManager.buildSessionContext();
		session.agent.replaceMessages(sessionContext.messages);

		const closeSpy = vi.fn();
		session.providerSessionState.set("openai-codex-responses", {
			close: closeSpy,
		} satisfies ProviderSessionState);

		const result = await session.navigateTree(firstUserId, { summarize: false });

		expect(result.cancelled).toBe(false);
		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState.size).toBe(0);
	});

	it("does not promote when promotion is disabled", async () => {
		const sparkModel = modelRegistry.find("openai-codex", "gpt-5.3-codex-spark");
		if (!sparkModel) {
			throw new Error("Expected codex spark model to exist");
		}

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"contextPromotion.enabled": false,
		});

		const agent = new Agent({
			initialState: {
				model: sparkModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const closeSpy = vi.fn();
		session.providerSessionState.set("openai-codex-responses", {
			close: closeSpy,
		} satisfies ProviderSessionState);

		const overflowMessage = createOverflowMessage(sparkModel);
		session.agent.emitExternalEvent({ type: "message_end", message: overflowMessage });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [overflowMessage] });

		await settle();

		expect(session.model?.provider).toBe(sparkModel.provider);
		expect(session.model?.id).toBe(sparkModel.id);
		expect(closeSpy).not.toHaveBeenCalled();
		expect(session.providerSessionState.size).toBe(1);
	});

	it("does not promote by default", async () => {
		const sparkModel = modelRegistry.find("openai-codex", "gpt-5.3-codex-spark");
		if (!sparkModel) {
			throw new Error("Expected codex spark model to exist");
		}

		const agent = new Agent({
			initialState: {
				model: sparkModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		const overflowMessage = createOverflowMessage(sparkModel);
		session.agent.emitExternalEvent({ type: "message_end", message: overflowMessage });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [overflowMessage] });

		await settle();

		expect(session.model?.provider).toBe(sparkModel.provider);
		expect(session.model?.id).toBe(sparkModel.id);
	});

	it("runs LLM compaction during overflow recovery under the summary strategy", async () => {
		const model = modelRegistry.find("openai-codex", "gpt-5.3-codex-spark");
		if (!model) {
			throw new Error("Expected codex spark model to exist");
		}
		const settings = Settings.isolated({
			"compaction.enabled": true,
			"compaction.strategy": "summary",
			"compaction.keepRecentTokens": 1,
			"compaction.thresholdPercent": -1,
			"contextPromotion.enabled": false,
		});
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "fallback summary",
			shortSummary: undefined,
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: preparation.tokensBefore,
			details: {},
		}));

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		// Big enough to be worth compacting, small enough that the summarization
		// request still fits the model: `"old context "` is 12 characters, so 20k
		// repeats is ~60k tokens against this model's 128k window. A history larger
		// than the window is a different case, and it has its own test below.
		session.sessionManager.appendMessage(createUserMessage("old context ".repeat(20_000)));
		session.sessionManager.appendMessage(createAssistantMessage(model, "old response"));
		session.sessionManager.appendMessage(createUserMessage("current request"));
		session.agent.replaceMessages(session.sessionManager.buildSessionContext().messages);
		const events: Array<Extract<AgentSessionEvent, { type: "auto_compaction_end" }>> = [];
		const compactionDone = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") {
				events.push(event);
				compactionDone.resolve();
			}
		});
		const continueSpy = vi.spyOn(session.agent, "continue").mockResolvedValue();

		const overflowMessage = createOverflowMessage(model);
		session.agent.emitExternalEvent({ type: "message_end", message: overflowMessage });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [overflowMessage] });

		await compactionDone.promise;

		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(events[0]?.errorMessage).toBeUndefined();
		expect(events[0]?.willRetry).toBe(true);
		await waitFor(() => continueSpy.mock.calls.length === 1);
		expect(session.sessionManager.getEntries().some(entry => entry.type === "compaction")).toBe(true);
	});

	it("refuses overflow recovery loudly when the summary cannot fit the model", async () => {
		// The other side of the row above: a history larger than the window cannot be
		// summarized by that model at all, because the summarization request carries
		// the conversation it is summarizing. The recovery has to say so and leave the
		// overflow in place, rather than reporting a compaction that never ran.
		//
		// The history is MANY small messages rather than one enormous one, and that is
		// the whole fixture. A single oversized text is what the truncation tier exists
		// to cut, so a session wedged that way is rescued rather than parked, and this
		// case then measured the rescue and not the refusal. Every message here is under
		// `TRUNCATION_MIN_TEXT_TOKENS`, so no tier has anything eligible to reduce and
		// the dead end is the real one.
		const model = modelRegistry.find("openai-codex", "gpt-5.3-codex-spark");
		if (!model) {
			throw new Error("Expected codex spark model to exist");
		}
		const contextWindow = model.contextWindow;
		if (contextWindow === null) {
			throw new Error("Expected codex spark model to state a context window");
		}
		const settings = Settings.isolated({
			"compaction.enabled": true,
			"compaction.strategy": "summary",
			"compaction.keepRecentTokens": 1,
			"contextPromotion.enabled": false,
		});
		const compactSpy = vi.spyOn(compactionModule, "compact");
		// Isolate the candidate set to the model this case is about. Compaction walks every
		// available model, and a sibling with a larger window would reach `compact()` — which this
		// suite does not mock — and hang the cell on a provider call. The cannot-fit refusal is a
		// skip of THIS window, not a network error from a bigger one.
		vi.spyOn(modelRegistry, "getAvailable").mockReturnValue([model]);
		compactSpy.mockRejectedValue(new Error("compact must not be reached: the summary cannot fit this model"));

		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		// Roughly twice the window, so no candidate can hold the request, spread over
		// messages the truncation tier will not touch. `"old context "` is 12 characters
		// and tokenizes at about three tokens, so each message is well under the
		// truncation floor and the pile is well over the window.
		const perMessageTokens = Math.floor(TRUNCATION_MIN_TEXT_TOKENS / 2);
		const messageCount = Math.ceil((2 * contextWindow) / perMessageTokens);
		for (let index = 0; index < messageCount; index++) {
			session.sessionManager.appendMessage(createUserMessage("old context ".repeat(perMessageTokens / 3)));
			session.sessionManager.appendMessage(createAssistantMessage(model, `old response ${index}`));
		}
		session.sessionManager.appendMessage(createUserMessage("current request"));
		session.agent.replaceMessages(session.sessionManager.buildSessionContext().messages);
		const events: Array<Extract<AgentSessionEvent, { type: "auto_compaction_end" }>> = [];
		const compactionDone = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") {
				events.push(event);
				compactionDone.resolve();
			}
		});
		vi.spyOn(session.agent, "continue").mockResolvedValue();

		const overflowMessage = createOverflowMessage(model);
		session.agent.emitExternalEvent({ type: "message_end", message: overflowMessage });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [overflowMessage] });

		await compactionDone.promise;

		expect(compactSpy).toHaveBeenCalledTimes(0);
		expect(events[0]?.willRetry).toBe(false);
		// The number in the message is what makes it actionable: which model, how
		// much it holds, and how much the summary would have needed.
		expect(events[0]?.errorMessage).toContain(`${model.provider}/${model.id} holds ${model.contextWindow} tokens`);
		expect(events[0]?.errorMessage).toContain("the summary needed");
		expect(session.sessionManager.getEntries().some(entry => entry.type === "compaction")).toBe(false);
		// And the refusal the user has to read is still the last thing in context.
		// The rollback runs after the event, so wait for it rather than racing it.
		await waitFor(() => session.messages.at(-1)?.role === "assistant");
		const last = session.messages.at(-1);
		expect(last?.role).toBe("assistant");
		expect(last && last.role === "assistant" ? last.stopReason : undefined).toBe("error");
	});

	it("promotes to a larger-context model on response.incomplete (length stop)", async () => {
		const sparkModel = modelRegistry.find("openai-codex", "gpt-5.3-codex-spark");
		const codexModel = modelRegistry.find("openai-codex", "gpt-5.5");
		if (!sparkModel || !codexModel) {
			throw new Error("Expected codex spark and codex models to exist");
		}

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"contextPromotion.enabled": true,
		});

		const agent = new Agent({
			initialState: {
				model: sparkModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const incompleteMessage = createIncompleteMessage(sparkModel);
		session.agent.emitExternalEvent({ type: "message_end", message: incompleteMessage });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [incompleteMessage] });

		await waitFor(() => session.model?.id === codexModel.id);

		expect(session.model?.provider).toBe(codexModel.provider);
		expect(session.model?.id).toBe(codexModel.id);
	});

	it("does not promote on length stop when message is from a different model", async () => {
		// Switching from a small-context model to a larger one and then receiving a
		// stale length-stop event for the previous model must NOT trigger promotion
		// or compaction on the new model — same guard as the overflow path.
		const sparkModel = modelRegistry.find("openai-codex", "gpt-5.3-codex-spark");
		const codexModel = modelRegistry.find("openai-codex", "gpt-5.5");
		if (!sparkModel || !codexModel) {
			throw new Error("Expected codex spark and codex models to exist");
		}

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"contextPromotion.enabled": true,
		});

		const agent = new Agent({
			initialState: {
				model: codexModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		// Stale incomplete from the smaller model — current session is already on codex.
		const staleIncomplete = createIncompleteMessage(sparkModel);
		session.agent.emitExternalEvent({ type: "message_end", message: staleIncomplete });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [staleIncomplete] });

		await settle();

		expect(session.model?.provider).toBe(codexModel.provider);
		expect(session.model?.id).toBe(codexModel.id);
	});
});

/**
 * Recalled memories reach the model at the TAIL of the context, never in the system prompt.
 *
 * WHY THIS SUITE EXISTS. The system prompt is the provider's cache prefix. Changing it
 * mid-session makes the next request re-read the entire conversation as fresh input at the
 * uncached rate: on a measured 66-turn trace, five turns came back with `cacheRead: 0` while
 * resending 46-72k tokens each, about 8% of that session's bill. Every one of those turns was
 * a memory event — a recall, a mental-model load, a mental-model TTL reload — writing volatile
 * text into the prompt through `buildDeveloperInstructions`, because that was the only channel
 * a memory backend had.
 *
 * The information is the same and the model reads it in the same place in the ordering. Only
 * the cache consequence changed: it arrives as a message after everything already cached, so
 * the prefix survives. These tests hold that line at the seam that actually pays the bill —
 * `systemPromptInvalidations()` — rather than trusting the call graph, and they pin the
 * de-duplication too, because a block re-sent every turn would trade a cache miss for
 * unbounded context growth.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { AgentMessage, AsideMessage } from "@veyyon/agent-core";
import { Agent, type AgentTool } from "@veyyon/agent-core";
import type { Model } from "@veyyon/ai";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { buildModel } from "@veyyon/catalog/build";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { hindsightBackend } from "@veyyon/coding-agent/hindsight/backend";
import { HindsightApi } from "@veyyon/coding-agent/hindsight/client";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { convertToLlm } from "@veyyon/coding-agent/session/messages";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { type } from "arktype";
import { createAssistantMessage } from "./helpers/agent-session-setup";

function createModel(): Model<"openai-responses"> {
	return buildModel({
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	});
}

interface Harness {
	session: AgentSession;
	/** Drain the aside provider the session installed, as the agent loop does at a step boundary. */
	drainAsides(): AgentMessage[];
}

const sessions: AgentSession[] = [];

afterEach(async () => {
	for (const session of sessions.splice(0)) await session.dispose();
	vi.restoreAllMocks();
});

beforeEach(() => {
	// The backend lists mental models on start. Nothing here should reach a network.
	vi.spyOn(HindsightApi.prototype, "listMentalModels").mockResolvedValue({ items: [] } as never);
});

/** A real session with the hindsight backend started against it. */
async function harness(): Promise<Harness> {
	const readTool: AgentTool = {
		name: "read",
		label: "Read",
		description: "read tool",
		parameters: type({ value: "string" }),
		strict: true,
		async execute() {
			return { content: [{ type: "text", text: "read executed" }] };
		},
	};
	const agent = new Agent({
		initialState: { model: createModel(), systemPrompt: ["base"], tools: [readTool], messages: [] },
	});
	// The provider is private on the Agent, so capture the function the session installs.
	// Wrapping the setter keeps this test at the real seam without adding test-only API.
	let provider: (() => AsideMessage[] | Promise<AsideMessage[]>) | undefined;
	const install = agent.setAsideMessageProvider.bind(agent);
	agent.setAsideMessageProvider = fn => {
		provider = fn ?? undefined;
		install(fn);
	};
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"memory.backend": "hindsight",
		"hindsight.apiUrl": "http://localhost:8888",
		"hindsight.mentalModelsEnabled": true,
	});
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings,
		modelRegistry: {} as never,
		toolRegistry: new Map<string, AgentTool>([[readTool.name, readTool]]),
		rebuildSystemPrompt: async () => ({ systemPrompt: ["base"] }),
	});
	sessions.push(session);
	await hindsightBackend.start({
		session: session as never,
		settings,
		modelRegistry: {} as never,
		agentDir: "/tmp",
		taskDepth: 0,
	});
	await session.getHindsightSessionState()?.mentalModelsLoadPromise;
	return {
		session,
		drainAsides() {
			const thunks = provider?.();
			if (!thunks || thunks instanceof Promise) return [];
			return thunks
				.map(entry => (typeof entry === "function" ? entry() : entry))
				.filter((message): message is AgentMessage => message !== null);
		},
	};
}

/** The memory block the model would see, or undefined when none was delivered. */
function memoryContentOf(messages: AgentMessage[]): string | undefined {
	const memory = messages.find(message => message.role === "custom" && message.customType === "memory-context");
	return memory && "content" in memory && typeof memory.content === "string" ? memory.content : undefined;
}

describe("a recall published mid-session", () => {
	it("delivers the memories as a message and invalidates no cache prefix", async () => {
		const { session, drainAsides } = await harness();
		const state = session.getHindsightSessionState();
		expect(state).toBeDefined();
		state!.lastRecallSnippet = "<memories>\nthe user prefers tabs\n</memories>";

		expect(await session.publishVolatileMemoryContext("test:recall")).toBe(true);

		expect(memoryContentOf(drainAsides())).toBe("<memories>\nthe user prefers tabs\n</memories>");
		// The line that costs money. An empty list means the provider served the whole
		// prefix from cache for this whole session.
		expect(session.systemPromptInvalidations()).toEqual([]);
	});

	it("marks the message undisplayed and attributed to the agent", async () => {
		// It is context for the model, not something the user asked to see; a displayed
		// block would put a wall of recalled memories in the transcript every turn.
		const { session, drainAsides } = await harness();
		session.getHindsightSessionState()!.lastRecallSnippet = "<memories>\nfact\n</memories>";
		await session.publishVolatileMemoryContext("test:recall");

		const memory = drainAsides().find(
			message => message.role === "custom" && message.customType === "memory-context",
		);
		expect(memory).toBeDefined();
		expect(memory && "display" in memory ? memory.display : undefined).toBe(false);
		expect(memory && "attribution" in memory ? memory.attribution : undefined).toBe("agent");
	});

	it("sends the block once, not again on every later step boundary", async () => {
		// The alternative failure: trading a cache miss for context that grows by the
		// whole memory block at every step of every turn.
		const { session, drainAsides } = await harness();
		session.getHindsightSessionState()!.lastRecallSnippet = "<memories>\nfact\n</memories>";
		await session.publishVolatileMemoryContext("test:recall");

		expect(memoryContentOf(drainAsides())).toBe("<memories>\nfact\n</memories>");
		expect(memoryContentOf(drainAsides())).toBeUndefined();
		expect(memoryContentOf(drainAsides())).toBeUndefined();
	});

	it("publishes nothing when the block has not changed since the last delivery", async () => {
		// A mental-model TTL reload that finds the same models must be a no-op, or the
		// same text lands in the context once per reload interval for the whole session.
		const { session, drainAsides } = await harness();
		session.getHindsightSessionState()!.lastRecallSnippet = "<memories>\nfact\n</memories>";
		await session.publishVolatileMemoryContext("test:first");
		drainAsides();

		expect(await session.publishVolatileMemoryContext("test:second")).toBe(false);
		expect(memoryContentOf(drainAsides())).toBeUndefined();
	});

	it("delivers the new block when the memories actually changed", async () => {
		// The negative twin of the de-duplication: suppressing an unchanged block must
		// not suppress a real update, or a recall the model needs never arrives.
		const { session, drainAsides } = await harness();
		const state = session.getHindsightSessionState()!;
		state.lastRecallSnippet = "<memories>\nfirst\n</memories>";
		await session.publishVolatileMemoryContext("test:first");
		drainAsides();

		state.lastRecallSnippet = "<memories>\nsecond\n</memories>";
		expect(await session.publishVolatileMemoryContext("test:second")).toBe(true);

		expect(memoryContentOf(drainAsides())).toBe("<memories>\nsecond\n</memories>");
		expect(session.systemPromptInvalidations()).toEqual([]);
	});

	it("publishes nothing when the backend holds no memories at all", async () => {
		// A configured backend that has recalled nothing must not push an empty message.
		const { session, drainAsides } = await harness();

		expect(await session.publishVolatileMemoryContext("test:empty")).toBe(false);
		expect(memoryContentOf(drainAsides())).toBeUndefined();
	});

	it("carries the mental models and the recall together, models first", async () => {
		// Curated knowledge anchors the model's prior, so it precedes the volatile
		// per-turn recall. The ordering was part of the contract when both lived in the
		// system prompt and it survives the move.
		const { session, drainAsides } = await harness();
		const state = session.getHindsightSessionState()!;
		state.mentalModelsSnippet = "<mental_models>\n# Prefs\nprefers tabs\n</mental_models>";
		state.lastRecallSnippet = "<memories>\nrecalled fact\n</memories>";
		await session.publishVolatileMemoryContext("test:both");

		const content = memoryContentOf(drainAsides());
		expect(content).toBeDefined();
		expect(content!.indexOf("<mental_models>\n")).toBeLessThan(content!.indexOf("<memories>\n"));
	});
});

describe("the system prompt after the split", () => {
	it("keeps the static memory guidance and none of the recalled text", async () => {
		// The static half is what the prompt is FOR: it does not change for the life of
		// the session, so it costs one cache write and nothing after that.
		const { session } = await harness();
		session.getHindsightSessionState()!.lastRecallSnippet = "<memories>\nsecret recalled fact\n</memories>";

		const instructions = await hindsightBackend.buildDeveloperInstructions("/tmp", session.settings, session);

		expect(instructions).toBeDefined();
		expect(instructions).not.toContain("secret recalled fact");
	});

	it("records no invalidation across a recall, a reload, and another recall", async () => {
		// The composition, which is what a real session does. Three memory events used
		// to mean three full re-reads of the conversation.
		const { session, drainAsides } = await harness();
		const state = session.getHindsightSessionState()!;
		state.lastRecallSnippet = "<memories>\none\n</memories>";
		await session.publishVolatileMemoryContext("hindsight:recall");
		drainAsides();
		state.mentalModelsSnippet = "<mental_models>\n# A\na\n</mental_models>";
		await session.publishVolatileMemoryContext("hindsight:MM reload");
		drainAsides();
		state.lastRecallSnippet = "<memories>\ntwo\n</memories>";
		await session.publishVolatileMemoryContext("hindsight:recall");
		drainAsides();

		expect(session.systemPromptInvalidations()).toEqual([]);
	});
});

/**
 * A new transcript has to be told the memories again, and the de-duplication is what makes that
 * non-obvious. Delivery is suppressed when the block matches the last one sent, which is correct
 * inside one conversation and wrong across two: `/new` and a session switch start a transcript that
 * does NOT contain the block, and the likely case is that the recall produces the SAME text, because
 * a project's mental models do not change between two `/new`s. Left uncleared, the cache would
 * silently starve every conversation after the first of its memories, with nothing failing.
 */
describe("a conversation reset", () => {
	it("re-delivers the same memory block to the new transcript", async () => {
		const { session, drainAsides } = await harness();
		const state = session.getHindsightSessionState()!;
		state.mentalModelsSnippet = "<mental_models>\n# Prefs\nprefers tabs\n</mental_models>";
		await session.publishVolatileMemoryContext("hindsight:recall");
		expect(memoryContentOf(drainAsides())).toBe("<mental_models>\n# Prefs\nprefers tabs\n</mental_models>");

		expect(await session.newSession()).toBe(true);

		// The same text, which is the case that used to be swallowed.
		session.getHindsightSessionState()!.mentalModelsSnippet =
			"<mental_models>\n# Prefs\nprefers tabs\n</mental_models>";
		expect(await session.publishVolatileMemoryContext("hindsight:recall")).toBe(true);
		expect(memoryContentOf(drainAsides())).toBe("<mental_models>\n# Prefs\nprefers tabs\n</mental_models>");
		expect(session.systemPromptInvalidations()).toEqual([]);
	});

	it("still sends the block only once inside the new conversation", async () => {
		// The negative twin. Clearing the cache on reset must not turn into "no
		// de-duplication at all", or the block lands again at every step boundary of the
		// new conversation, which is the cost the tail delivery exists to avoid.
		const { session, drainAsides } = await harness();
		session.getHindsightSessionState()!.lastRecallSnippet = "<memories>\nfact\n</memories>";
		await session.publishVolatileMemoryContext("hindsight:recall");
		drainAsides();
		await session.newSession();

		session.getHindsightSessionState()!.lastRecallSnippet = "<memories>\nfact\n</memories>";
		await session.publishVolatileMemoryContext("hindsight:recall");

		expect(memoryContentOf(drainAsides())).toBe("<memories>\nfact\n</memories>");
		expect(memoryContentOf(drainAsides())).toBeUndefined();
		expect(await session.publishVolatileMemoryContext("hindsight:recall")).toBe(false);
	});

	it("drops a block that was queued but never drained before the reset", async () => {
		// A recall that landed between two turns is queued, not yet in any transcript. If
		// the conversation is reset before the agent loop drains it, that queued message
		// belongs to a conversation that no longer exists: delivering it would put memories
		// recalled for the old transcript at the head of the new one, out of order with the
		// recall the new conversation is about to do for itself.
		const { session, drainAsides } = await harness();
		session.getHindsightSessionState()!.lastRecallSnippet = "<memories>\nold turn\n</memories>";
		await session.publishVolatileMemoryContext("hindsight:recall");

		await session.newSession();

		expect(memoryContentOf(drainAsides())).toBeUndefined();
	});
});

/**
 * The first turn of a session is the one case a memory backend can only reach through
 * `beforeAgentStartPrompt`, and it used to reach it by appending to the system prompt (recorded as
 * `memory-backend-injection`). These tests drive a REAL prompt through a stub model and read the
 * messages the model was actually handed, because that is the only place the distinction between
 * "in the prompt" and "in the context" is observable.
 */
describe("the first turn of a session", () => {
	let tempDir: TempDir;
	const started: { session: AgentSession; authStorage: AuthStorage }[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-memory-tail-first-turn-");
	});

	afterEach(async () => {
		for (const entry of started.splice(0)) {
			await entry.session.dispose();
			entry.authStorage.close();
		}
		tempDir.removeSync();
	});

	interface PromptCall {
		messageTexts: string[];
		systemPromptText: string;
	}

	/** A session wired to a stub model that records what each request carried. */
	async function promptHarness(): Promise<{ session: AgentSession; calls: PromptCall[] }> {
		const calls: PromptCall[] = [];
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in the bundled catalog");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"memory.backend": "hindsight",
			"hindsight.apiUrl": "http://localhost:8888",
			"hindsight.autoRecall": true,
			"hindsight.mentalModelsEnabled": false,
		});
		const bashTool: AgentTool = {
			name: "bash",
			label: "Bash",
			description: "Mock bash tool",
			parameters: type({}),
			execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
		};
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [bashTool], messages: [] },
			convertToLlm,
			streamFn: (_model, context) => {
				calls.push({
					messageTexts: context.messages.map(message =>
						"content" in message && typeof message.content === "string"
							? message.content
							: JSON.stringify("content" in message ? message.content : ""),
					),
					systemPromptText: (context.systemPrompt ?? []).join("\n\n"),
				});
				const response = createAssistantMessage("done");
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: response });
					stream.push({ type: "done", reason: "stop", message: response });
				});
				return stream;
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map<string, AgentTool>([[bashTool.name, bashTool]]),
		});
		started.push({ session, authStorage });
		await hindsightBackend.start({
			session: session as never,
			settings,
			modelRegistry: {} as never,
			agentDir: tempDir.path(),
			taskDepth: 0,
		});
		return { session, calls };
	}

	it("hands the first-turn recall to the model as a message, not in the system prompt", async () => {
		vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({
			results: [{ id: "1", text: "the user prefers tabs over spaces" }],
		} as never);
		const { session, calls } = await promptHarness();

		await session.prompt("what do you know about me?");

		expect(calls).toHaveLength(1);
		const call = calls[0]!;
		expect(call.messageTexts.some(text => text.includes("the user prefers tabs over spaces"))).toBe(true);
		// The distinction that costs money: the same text in the system prompt would have
		// invalidated the provider's prefix for the rest of the session.
		expect(call.systemPromptText).not.toContain("the user prefers tabs over spaces");
		expect(session.systemPromptInvalidations()).toEqual([]);
	});

	it("keeps the user's own prompt as the last message, after the memories", async () => {
		// The memories are context for the question, so the question comes last. A recall
		// appended after the prompt would read as the newest instruction.
		vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({
			results: [{ id: "1", text: "the user prefers tabs over spaces" }],
		} as never);
		const { session, calls } = await promptHarness();

		await session.prompt("what do you know about me?");

		const texts = calls[0]!.messageTexts;
		const memoryIndex = texts.findIndex(text => text.includes("the user prefers tabs over spaces"));
		const promptIndex = texts.findIndex(text => text.includes("what do you know about me?"));
		expect(memoryIndex).toBeGreaterThanOrEqual(0);
		expect(promptIndex).toBeGreaterThan(memoryIndex);
	});

	it("adds nothing when the recall comes back empty", async () => {
		// The negative twin. A session whose bank has nothing to say must send exactly the
		// user's message.
		vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({ results: [] } as never);
		const { session, calls } = await promptHarness();

		await session.prompt("what do you know about me?");

		expect(calls[0]!.messageTexts.filter(text => text.includes("<memories>"))).toEqual([]);
		expect(session.systemPromptInvalidations()).toEqual([]);
	});

	it("does not repeat the memories on the second turn", async () => {
		// Recall runs once per session, and the block is already in the conversation the
		// second request re-sends. Adding it again would pay for the same text twice.
		vi.spyOn(HindsightApi.prototype, "recall").mockResolvedValue({
			results: [{ id: "1", text: "the user prefers tabs over spaces" }],
		} as never);
		const { session, calls } = await promptHarness();

		await session.prompt("what do you know about me?");
		await session.prompt("and now?");

		expect(calls).toHaveLength(2);
		const secondTurnCopies = calls[1]!.messageTexts.filter(text =>
			text.includes("the user prefers tabs over spaces"),
		).length;
		expect(secondTurnCopies).toBe(1);
	});
});

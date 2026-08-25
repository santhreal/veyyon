import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentMessage } from "@veyyon/agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@veyyon/ai";
import type { Usage } from "@veyyon/catalog/types";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";

// WHY: getTurnIndex() counts assistant messages by iterating the full messages
// array. On a 33K-message session each call was ~1ms, and it is called multiple
// times per turn (once per tool result via inlineBudgetFor / computeOutputMeta).
// The cache returns the prior count when the array reference and length are
// unchanged, and incrementally scans only new messages on append. A different
// array reference (replaceMessages after compaction) triggers a full recompute.
// These tests verify the cache produces identical counts across all mutation
// paths: initial load, append, replaceMessages, and reset.

function makeUsage(over: Partial<Usage> = {}): Usage {
	return {
		input: 10,
		output: 2,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 12,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...over,
	};
}

describe("AgentSession getTurnIndex cache", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-turn-index-cache-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
	});

	function makeAssistantMessage(): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "anthropic",
			provider: "anthropic",
			model: "claude-sonnet-4-20250514",
			usage: makeUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		};
	}

	function makeUserMessage(): UserMessage {
		return { role: "user", content: "hi", timestamp: Date.now() };
	}

	function makeToolResultMessage(): ToolResultMessage {
		return {
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "read",
			content: [{ type: "text", text: "file content" }],
			isError: false,
			timestamp: Date.now(),
		};
	}

	it("counts assistant messages on initial load", () => {
		const model = modelRegistry.getAll().find(m => m.contextWindow && m.contextWindow > 0);
		if (!model) throw new Error("Expected bundled model with a context window");

		const messages: AgentMessage[] = [
			makeUserMessage(),
			makeAssistantMessage(),
			makeUserMessage(),
			makeAssistantMessage(),
		];
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages },
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		expect(session.getTurnIndex()).toBe(2);
	});

	it("returns same result on repeated calls without mutation", () => {
		const model = modelRegistry.getAll().find(m => m.contextWindow && m.contextWindow > 0);
		if (!model) throw new Error("Expected bundled model with a context window");

		const messages: AgentMessage[] = [
			makeUserMessage(),
			makeAssistantMessage(),
			makeAssistantMessage(),
			makeAssistantMessage(),
		];
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages },
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		expect(session.getTurnIndex()).toBe(3);
		expect(session.getTurnIndex()).toBe(3);
		expect(session.getTurnIndex()).toBe(3);
	});

	it("incrementally updates on append without full rescan", () => {
		const model = modelRegistry.getAll().find(m => m.contextWindow && m.contextWindow > 0);
		if (!model) throw new Error("Expected bundled model with a context window");

		const messages: AgentMessage[] = [makeUserMessage(), makeAssistantMessage()];
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages },
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		expect(session.getTurnIndex()).toBe(1);

		// Append a non-assistant message — count should not change
		agent.appendMessage(makeToolResultMessage());
		expect(session.getTurnIndex()).toBe(1);

		// Append an assistant message — count should increment
		agent.appendMessage(makeAssistantMessage());
		expect(session.getTurnIndex()).toBe(2);

		// Append user + assistant
		agent.appendMessage(makeUserMessage());
		agent.appendMessage(makeAssistantMessage());
		expect(session.getTurnIndex()).toBe(3);
	});

	it("recomputes from scratch after replaceMessages", () => {
		const model = modelRegistry.getAll().find(m => m.contextWindow && m.contextWindow > 0);
		if (!model) throw new Error("Expected bundled model with a context window");

		const messages: AgentMessage[] = [
			makeUserMessage(),
			makeAssistantMessage(),
			makeAssistantMessage(),
			makeAssistantMessage(),
		];
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages },
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		expect(session.getTurnIndex()).toBe(3);

		// Simulate compaction: replace with a shorter array that has fewer assistant messages
		const compacted: AgentMessage[] = [makeUserMessage(), makeAssistantMessage()];
		agent.replaceMessages(compacted);
		expect(session.getTurnIndex()).toBe(1);

		// Cache should work on the new array too
		expect(session.getTurnIndex()).toBe(1);
	});

	it("recomputes after reset", () => {
		const model = modelRegistry.getAll().find(m => m.contextWindow && m.contextWindow > 0);
		if (!model) throw new Error("Expected bundled model with a context window");

		const messages: AgentMessage[] = [makeUserMessage(), makeAssistantMessage(), makeAssistantMessage()];
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages },
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		expect(session.getTurnIndex()).toBe(2);

		agent.reset();
		expect(session.getTurnIndex()).toBe(0);

		// After reset, appending should work from the new baseline
		agent.appendMessage(makeUserMessage());
		agent.appendMessage(makeAssistantMessage());
		expect(session.getTurnIndex()).toBe(1);
	});

	it("counts zero for non-assistant-only messages", () => {
		const model = modelRegistry.getAll().find(m => m.contextWindow && m.contextWindow > 0);
		if (!model) throw new Error("Expected bundled model with a context window");

		const messages: AgentMessage[] = [makeUserMessage(), makeToolResultMessage(), makeUserMessage()];
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages },
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		expect(session.getTurnIndex()).toBe(0);
	});

	it("handles empty messages array", () => {
		const model = modelRegistry.getAll().find(m => m.contextWindow && m.contextWindow > 0);
		if (!model) throw new Error("Expected bundled model with a context window");

		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		expect(session.getTurnIndex()).toBe(0);
	});
});

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

describe("AgentSession session stats", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-session-stats-");
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

	it("includes context usage available from the active session", () => {
		const model = modelRegistry.getAll().find(candidate => candidate.contextWindow && candidate.contextWindow > 0);
		if (!model?.contextWindow) {
			throw new Error("Expected bundled model with a context window");
		}

		const userMessage: UserMessage = {
			role: "user",
			content: "Hello",
			timestamp: Date.now(),
		};
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 10,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 12,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0,
				},
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [userMessage, assistantMessage],
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		const directUsage = session.getContextUsage();
		const stats = session.getSessionStats();

		expect(directUsage).toEqual({
			tokens: 10,
			contextWindow: model.contextWindow,
			percent: (10 / model.contextWindow) * 100,
		});
		expect(stats.contextUsage).toEqual(directUsage);
	});

	// WHY: getSessionStats merged four O(n) passes (three .filter().length + one
	// summing loop) into a single loop. These tests verify the merged loop
	// produces identical counts and usage totals for every message role,
	// tool-call content, task-tool usage, premium requests, and the empty case.
	describe("getSessionStats single-pass counts and totals", () => {
		function makeUsage(over: Partial<Usage> = {}): Usage {
			return {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				...over,
			};
		}

		function makeSession(messages: AgentMessage[]): AgentSession {
			const model = modelRegistry.getAll().find(c => c.contextWindow && c.contextWindow > 0);
			if (!model) throw new Error("Expected bundled model with a context window");
			const agent = new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [], messages },
			});
			return new AgentSession({
				agent,
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated({ "compaction.enabled": false }),
				modelRegistry,
			});
		}

		function makeAssistant(
			model: { api: string; provider: string; id: string },
			over: Partial<Usage> & { content?: AssistantMessage["content"] } = {},
		): AssistantMessage {
			return {
				role: "assistant",
				content: over.content ?? [{ type: "text", text: "ok" }],
				api: model.api as AssistantMessage["api"],
				provider: model.provider,
				model: model.id,
				usage: makeUsage(over),
				stopReason: "stop",
				timestamp: Date.now(),
			};
		}

		function makeToolResult(toolName: string, details?: unknown): ToolResultMessage {
			return {
				role: "toolResult",
				toolCallId: `call-${Math.random().toString(36).slice(2)}`,
				toolName,
				content: [{ type: "text", text: "done" }],
				details,
				isError: false,
				timestamp: Date.now(),
			};
		}

		it("counts user, assistant, and toolResult messages correctly", () => {
			const model = modelRegistry.getAll().find(c => c.contextWindow && c.contextWindow > 0)!;
			const msgs: AgentMessage[] = [
				{ role: "user", content: "a", timestamp: Date.now() },
				makeAssistant(model),
				makeToolResult("bash"),
				{ role: "user", content: "b", timestamp: Date.now() },
				makeAssistant(model),
				makeToolResult("edit"),
				makeToolResult("read"),
			];
			const s = makeSession(msgs);
			session = s;
			const stats = s.getSessionStats();
			expect(stats.userMessages).toBe(2);
			expect(stats.assistantMessages).toBe(2);
			expect(stats.toolResults).toBe(3);
			expect(stats.totalMessages).toBe(7);
		});

		it("counts tool calls in assistant content blocks", () => {
			const model = modelRegistry.getAll().find(c => c.contextWindow && c.contextWindow > 0)!;
			const msgs: AgentMessage[] = [
				{ role: "user", content: "do things", timestamp: Date.now() },
				makeAssistant(model, {
					content: [
						{ type: "text", text: "sure" },
						{ type: "toolCall", id: "tc1", name: "bash", arguments: {} },
						{ type: "toolCall", id: "tc2", name: "read", arguments: {} },
					],
				}),
				makeAssistant(model, {
					content: [{ type: "toolCall", id: "tc3", name: "edit", arguments: {} }],
				}),
			];
			const s = makeSession(msgs);
			session = s;
			const stats = s.getSessionStats();
			expect(stats.toolCalls).toBe(3);
		});

		it("aggregates usage across multiple assistant messages", () => {
			const model = modelRegistry.getAll().find(c => c.contextWindow && c.contextWindow > 0)!;
			const msgs: AgentMessage[] = [
				{ role: "user", content: "x", timestamp: Date.now() },
				makeAssistant(model, { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, totalTokens: 165 }),
				makeAssistant(model, { input: 200, output: 80, cacheRead: 20, cacheWrite: 10, totalTokens: 310 }),
			];
			const s = makeSession(msgs);
			session = s;
			const stats = s.getSessionStats();
			expect(stats.tokens.input).toBe(300);
			expect(stats.tokens.output).toBe(130);
			expect(stats.tokens.cacheRead).toBe(30);
			expect(stats.tokens.cacheWrite).toBe(15);
			expect(stats.tokens.total).toBe(475);
		});

		it("aggregates task tool result usage but not non-task tool results", () => {
			const model = modelRegistry.getAll().find(c => c.contextWindow && c.contextWindow > 0)!;
			const taskUsage: Usage = makeUsage({ input: 500, output: 200, totalTokens: 700 });
			const msgs: AgentMessage[] = [
				{ role: "user", content: "spawn", timestamp: Date.now() },
				makeAssistant(model, { input: 10, output: 5, totalTokens: 15 }),
				makeToolResult("task", { usage: taskUsage }),
				makeToolResult("bash", { usage: makeUsage({ input: 999, totalTokens: 999 }) }),
			];
			const s = makeSession(msgs);
			session = s;
			const stats = s.getSessionStats();
			// assistant (10+5) + task (500+200) = 510 + 205
			expect(stats.tokens.input).toBe(510);
			expect(stats.tokens.output).toBe(205);
			expect(stats.tokens.total).toBe(715);
			// bash tool result with usage in details should NOT contribute
			expect(stats.toolResults).toBe(2);
		});

		it("counts premium requests from assistant usage", () => {
			const model = modelRegistry.getAll().find(c => c.contextWindow && c.contextWindow > 0)!;
			const msgs: AgentMessage[] = [
				{ role: "user", content: "x", timestamp: Date.now() },
				makeAssistant(model, { premiumRequests: 3 }),
				makeAssistant(model, { premiumRequests: 2 }),
			];
			const s = makeSession(msgs);
			session = s;
			const stats = s.getSessionStats();
			expect(stats.premiumRequests).toBe(5);
		});

		it("aggregates cost across assistant messages and task tool results", () => {
			const model = modelRegistry.getAll().find(c => c.contextWindow && c.contextWindow > 0)!;
			const taskUsage: Usage = makeUsage({
				cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
			});
			const msgs: AgentMessage[] = [
				{ role: "user", content: "x", timestamp: Date.now() },
				makeAssistant(model, { cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } }),
				makeToolResult("task", { usage: taskUsage }),
			];
			const s = makeSession(msgs);
			session = s;
			const stats = s.getSessionStats();
			expect(stats.cost).toBeCloseTo(0.33, 10);
		});

		it("returns zero counts for empty message list", () => {
			const s = makeSession([]);
			session = s;
			const stats = s.getSessionStats();
			expect(stats.userMessages).toBe(0);
			expect(stats.assistantMessages).toBe(0);
			expect(stats.toolResults).toBe(0);
			expect(stats.toolCalls).toBe(0);
			expect(stats.totalMessages).toBe(0);
			expect(stats.tokens.total).toBe(0);
			expect(stats.cost).toBe(0);
		});

		it("counts reasoning tokens from assistant usage", () => {
			const model = modelRegistry.getAll().find(c => c.contextWindow && c.contextWindow > 0)!;
			const msgs: AgentMessage[] = [
				{ role: "user", content: "x", timestamp: Date.now() },
				makeAssistant(model, { output: 100, reasoningTokens: 40, totalTokens: 100 }),
				makeAssistant(model, { output: 200, reasoningTokens: 60, totalTokens: 200 }),
			];
			const s = makeSession(msgs);
			session = s;
			const stats = s.getSessionStats();
			expect(stats.tokens.reasoning).toBe(100);
			expect(stats.tokens.output).toBe(300);
		});
	});
});

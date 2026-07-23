import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import * as compactionModule from "@veyyon/agent-core/compaction";
import type { AssistantMessage, ImageContent, ToolResultMessage } from "@veyyon/ai";
import { getBundledModel } from "@veyyon/catalog/models";
import {
	normalizeCompactionStrategy,
	resolveCompactionEngineAction,
} from "@veyyon/coding-agent/config/compaction-strategy";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";

const usage = {
	input: 16,
	output: 8,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 24,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("AgentSession shake", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let events: AgentSessionEvent[];
	let apiInfo: { api: AssistantMessage["api"]; provider: AssistantMessage["provider"]; model: string };

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-shake-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		events = [];

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		apiInfo = { api: model.api, provider: model.provider, model: model.id };

		const agent = new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } });
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": true, "compaction.autoContinue": false }),
			modelRegistry,
		});
		session.subscribe(event => events.push(event));
	});

	afterEach(async () => {
		if (session) await session.dispose();
		authStorage.close();
		try {
			await tempDir.remove();
		} catch {}
		vi.restoreAllMocks();
	});

	/** Seed a user → assistant(toolCall) → toolResult turn carrying a heavy bash result. */
	function seedHeavyToolResult(text: string, toolName = "bash"): void {
		const toolCallId = `call_${toolName}_${Math.random().toString(36).slice(2)}`;
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "do it" }],
			timestamp: Date.now() - 3,
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [
				{ type: "text", text: "working" },
				{ type: "toolCall", id: toolCallId, name: toolName, arguments: { command: "ls" } },
			],
			...apiInfo,
			stopReason: "toolUse",
			usage,
			timestamp: Date.now() - 2,
		});
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId,
			toolName,
			content: [{ type: "text", text }],
			isError: false,
			timestamp: Date.now() - 1,
		});
	}

	function branchToolResults(): ToolResultMessage[] {
		return sessionManager
			.getBranch()
			.filter(e => e.type === "message" && (e.message as { role?: string }).role === "toolResult")
			.map(e => (e as { message: ToolResultMessage }).message);
	}

	describe("elide", () => {
		it("drops the tool result, offloads to an artifact, and embeds the recovery link", async () => {
			seedHeavyToolResult("X".repeat(4000));
			const replaceSpy = vi.spyOn(session.agent, "replaceMessages");

			const result = await session.shake("elide");

			expect(result.mode).toBe("elide");
			expect(result.toolResultsDropped).toBe(1);
			expect(result.tokensFreed).toBeGreaterThan(0);
			expect(result.artifactId).toBeDefined();
			expect(replaceSpy).toHaveBeenCalled();

			const [tr] = branchToolResults();
			expect(tr.prunedAt).toBeGreaterThan(0);
			const text = tr.content.map(b => (b.type === "text" ? b.text : "")).join("");
			expect(text).toContain(`artifact://${result.artifactId}`);
			expect(text).toContain("shaken");
		});

		it("returns zero counts for an empty branch", async () => {
			const result = await session.shake("elide");
			expect(result.toolResultsDropped).toBe(0);
			expect(result.blocksDropped).toBe(0);
			expect(result.tokensFreed).toBe(0);
		});
	});

	describe("redundancy dedup", () => {
		it("elides an earlier byte-identical result the heavy pass would protect, keeping the newest copy", async () => {
			// Two small, recent, identical results: the heavy pass protects both
			// (inside protectTokens, below minSavings), so only the redundancy pass
			// can reclaim the older copy. Using DEFAULT_SHAKE_CONFIG (not the manual
			// aggressive preset) proves the dedup path fires on its own.
			seedHeavyToolResult("IDENTICAL_READ_BODY\n".repeat(20));
			seedHeavyToolResult("IDENTICAL_READ_BODY\n".repeat(20));

			const heavyOnly = compactionModule.collectShakeRegions(
				sessionManager.getBranch(),
				compactionModule.DEFAULT_SHAKE_CONFIG,
			);
			expect(heavyOnly).toHaveLength(0);

			const result = await session.shake("elide", { config: compactionModule.DEFAULT_SHAKE_CONFIG });
			expect(result.toolResultsDropped).toBe(1);
			expect(result.artifactId).toBeDefined();

			const [older, newer] = branchToolResults();
			expect(older.prunedAt).toBeGreaterThan(0);
			const olderText = older.content.map(b => (b.type === "text" ? b.text : "")).join("");
			expect(olderText).toContain(`artifact://${result.artifactId}`);
			expect(newer.prunedAt).toBeUndefined();
			expect(newer.content).toEqual([{ type: "text", text: "IDENTICAL_READ_BODY\n".repeat(20) }]);
		});

		it("leaves a single result untouched (nothing to dedup)", async () => {
			seedHeavyToolResult("UNIQUE_BODY\n".repeat(20));
			const result = await session.shake("elide", { config: compactionModule.DEFAULT_SHAKE_CONFIG });
			expect(result.toolResultsDropped).toBe(0);
			expect(branchToolResults()[0].prunedAt).toBeUndefined();
		});
	});

	describe("dedupeRedundantToolResults (proactive, strategy-independent)", () => {
		it("elides earlier identical copies and keeps the newest, without touching non-duplicates", async () => {
			seedHeavyToolResult("DUP_BODY\n".repeat(20)); // copy 1 (bash / command ls)
			seedHeavyToolResult("DIFFERENT_BODY\n".repeat(20)); // unique
			seedHeavyToolResult("DUP_BODY\n".repeat(20)); // copy 2 — identical to copy 1

			const result = await session.dedupeRedundantToolResults();
			expect(result.toolResultsDropped).toBe(1);
			expect(result.artifactId).toBeDefined();

			const [dup1, unique, dup2] = branchToolResults();
			expect(dup1.prunedAt).toBeGreaterThan(0);
			expect(dup1.content.map(b => (b.type === "text" ? b.text : "")).join("")).toContain(
				`artifact://${result.artifactId}`,
			);
			expect(unique.prunedAt).toBeUndefined();
			expect(dup2.prunedAt).toBeUndefined();
			expect(dup2.content).toEqual([{ type: "text", text: "DUP_BODY\n".repeat(20) }]);
		});

		it("is a no-op with zero counts when nothing is redundant", async () => {
			seedHeavyToolResult("ONLY_ONE\n".repeat(20));
			const result = await session.dedupeRedundantToolResults();
			expect(result.toolResultsDropped).toBe(0);
			expect(result.tokensFreed).toBe(0);
			expect(branchToolResults()[0].prunedAt).toBeUndefined();
		});
	});

	describe("images", () => {
		it("mirrors dropImages and reports the removed image count", async () => {
			const png: ImageContent = { type: "image", data: "iVBORw0KGgo", mimeType: "image/png" };
			sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "look" }, png],
				timestamp: Date.now(),
			});

			const result = await session.shake("images");

			expect(result.mode).toBe("images");
			expect(result.imagesDropped).toBe(1);
			const branch = sessionManager.getBranch();
			const userMsg = branch.find(e => e.type === "message" && (e.message as { role?: string }).role === "user");
			const content = (userMsg as { message: { content: unknown } }).message.content as Array<{ type: string }>;
			expect(content.some(b => b.type === "image")).toBe(false);
		});
	});

	describe("protected tools", () => {
		it("never shakes skill results", async () => {
			seedHeavyToolResult("S".repeat(4000), "skill");
			const result = await session.shake("elide");
			expect(result.toolResultsDropped).toBe(0);
		});
	});

	describe("legacy shake strategy retirement", () => {
		// The `shake` auto-compaction STRATEGY was retired: `compaction.strategy`
		// now accepts only `handoff` | `summary`, and the legacy `shake` token
		// folds into `summary` (compaction-strategy.ts LEGACY_SUMMARY). Auto
		// compaction therefore dispatches the `context-full` engine action, never a
		// `shake` action, and never calls AgentSession.shake() on its own. The
		// manual shake operation (exercised by the suites above) is unaffected.
		// These lock the retirement so a shake auto-dispatch cannot silently return.

		it("normalizes the legacy shake strategy token to summary / context-full", () => {
			expect(normalizeCompactionStrategy("shake")).toBe("summary");
			// The engine action a threshold run derives from the legacy token is
			// context-full — the in-place summary path, not a shake.
			expect(resolveCompactionEngineAction("shake", { reason: "threshold" })).toBe("context-full");
		});

		it("dispatches context-full (never a shake action) when the stored strategy is the legacy shake token", async () => {
			session.settings.override("compaction.strategy", "shake" as never);
			session.settings.set("compaction.thresholdPercent", 1);
			session.settings.set("contextPromotion.enabled", false);

			// Keep the summary path off the network: this asserts the routing, not
			// the LLM. Mock compact() as a safety net so no real completion is issued.
			vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
				summary: "retirement summary",
				shortSummary: undefined,
				firstKeptEntryId: preparation.firstKeptEntryId,
				tokensBefore: preparation.tokensBefore,
				details: {},
			}));
			// Spy shake to prove auto-compaction never routes through it under the
			// retired strategy (the manual operation stays callable, just unused here).
			const shakeSpy = vi.spyOn(session, "shake");

			const assistantMessage: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "trigger" }],
				...apiInfo,
				stopReason: "stop",
				usage: {
					input: 10_000,
					output: 1_000,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 11_000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			};
			session.agent.emitExternalEvent({ type: "message_end", message: assistantMessage });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMessage] });
			await session.waitForIdle();

			// The engine action is context-full...
			const starts = events.filter(event => event.type === "auto_compaction_start");
			expect(starts).toHaveLength(1);
			expect(starts[0]).toMatchObject({ type: "auto_compaction_start", action: "context-full" });
			// ...no shake action is ever emitted, at start or end...
			expect(events.some(event => (event as { action?: string }).action === "shake")).toBe(false);
			// ...and AgentSession.shake() was never invoked by auto-compaction (the
			// manual shake operation stays callable, it is simply never auto-routed).
			expect(shakeSpy).not.toHaveBeenCalled();
		});
	});
});

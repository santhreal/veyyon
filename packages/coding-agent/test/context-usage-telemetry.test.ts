import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import type { AssistantMessage } from "@veyyon/ai";
import type { InstrumentationLevel } from "@veyyon/ai/instrumentation";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { buildContextSnapshot, estimateContextSnapshotAttribution } from "@veyyon/coding-agent/session/context-usage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";

const usage = {
	input: 500,
	output: 20,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 520,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("context snapshot session telemetry", () => {
	let sharedDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@context-telemetry-");
		authStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("openai", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		await Settings.init({ inMemory: true });
	});

	afterAll(async () => {
		authStorage.close();
		await sharedDir.remove();
	});

	function createSession(level: InstrumentationLevel, responseUsage = usage) {
		const tempDir = TempDir.createSync(`@context-telemetry-${level}-`);
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const model = createMockModel({
			id: `context-${level}`,
			provider: "openai",
			contextWindow: 100_000,
			responses: [{ content: ["done"], stopReason: "stop", usage: responseUsage }],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["System prompt"], tools: [], messages: [] },
			streamFn: model.stream,
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"session.instrumentation": level,
			}),
			modelRegistry,
		});
		return { agent, session, sessionManager, tempDir, model };
	}

	function latestAssistant(sessionManager: SessionManager): AssistantMessage {
		for (const entry of sessionManager.getBranch().toReversed()) {
			if (entry.type === "message" && entry.message.role === "assistant") return entry.message;
		}
		throw new Error("Expected a persisted assistant message");
	}

	it("keeps off and basic snapshots at the legacy compact shape", async () => {
		const { session, sessionManager, tempDir } = createSession("off");
		await session.prompt("Keep this snapshot compact");
		await session.waitForIdle();
		const persistedSnapshot = latestAssistant(sessionManager).contextSnapshot;
		expect(Object.keys(persistedSnapshot ?? {}).sort()).toEqual(["nonMessageTokens", "promptTokens"]);
		expect(persistedSnapshot?.promptTokens).toBe(500);
		expect(persistedSnapshot?.nonMessageTokens).toBeGreaterThan(0);
		await tempDir.remove();

		const attribution = estimateContextSnapshotAttribution(500, 100, 50, "provider", "compaction-1");
		expect(buildContextSnapshot(500, 100, "basic", attribution)).toEqual({
			promptTokens: 500,
			nonMessageTokens: 100,
		});
	});

	it("persists deterministic rich component attribution without another token pass", async () => {
		const { session, sessionManager, tempDir } = createSession("rich");
		await session.prompt("Account for this request");
		await session.waitForIdle();

		const snapshot = latestAssistant(sessionManager).contextSnapshot;
		expect(snapshot).toBeDefined();
		expect(snapshot?.promptTokens).toBe(500);
		expect(snapshot?.promptTokensSource).toBe("provider");
		expect(snapshot?.nonMessageTokensEstimated).toBe(true);
		expect(snapshot?.storedMessagesTokensEstimated).toBe(true);
		expect(snapshot?.tailTokensEstimated).toBe(true);
		expect(snapshot?.tailTokens).toBeGreaterThan(0);
		expect((snapshot?.storedMessagesTokens ?? 0) + (snapshot?.tailTokens ?? 0)).toBe(
			(snapshot?.promptTokens ?? 0) - (snapshot?.nonMessageTokens ?? 0),
		);
		expect(snapshot?.compactionEntryId).toBeUndefined();

		await tempDir.remove();
	});

	/**
	 * Providers that report only output/total usage do not provide an
	 * authoritative prompt count. The preflight estimate must stay labeled as
	 * an estimate instead of misclassifying output tokens as provider input.
	 */
	it("uses the preflight estimate when provider prompt usage is zero", async () => {
		const zeroPromptUsage = {
			...usage,
			input: 0,
			output: 42,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 42,
		};
		const { session, sessionManager, tempDir } = createSession("rich", zeroPromptUsage);
		await session.prompt("Estimate this request");
		await session.waitForIdle();

		const snapshot = latestAssistant(sessionManager).contextSnapshot;
		expect(snapshot?.promptTokensSource).toBe("estimate");
		expect(snapshot?.promptTokens).not.toBe(42);
		expect(snapshot?.promptTokens).toBeGreaterThan(0);
		await tempDir.remove();
	});

	it("records the governing compaction only at ultra detail", async () => {
		const { session, sessionManager, tempDir } = createSession("ultra");
		const firstKeptEntryId = sessionManager.appendMessage({
			role: "user",
			content: "kept",
			timestamp: 1,
		});
		const compactionEntryId = sessionManager.appendCompaction("summary", undefined, firstKeptEntryId, 900);
		await session.prompt("Continue after compaction");
		await session.waitForIdle();

		expect(latestAssistant(sessionManager).contextSnapshot).toMatchObject({
			promptTokens: 500,
			promptTokensSource: "provider",
			compactionEntryId,
		});
		await tempDir.remove();
	});

	it("does not attach snapshots to aborted or error turns", async () => {
		const { agent, session, sessionManager, tempDir, model } = createSession("rich");
		const messages: AssistantMessage[] = [
			{
				role: "assistant",
				content: [{ type: "text", text: "partial" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				stopReason: "aborted",
				usage,
				timestamp: 10,
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "failed" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				stopReason: "error",
				errorMessage: "provider failed",
				usage,
				timestamp: 11,
			},
		];
		for (const message of messages) {
			const handled = Promise.withResolvers<void>();
			const unsubscribe = session.subscribe(event => {
				if (event.type === "message_end" && event.message === message) handled.resolve();
			});
			agent.emitExternalEvent({ type: "message_end", message });
			await handled.promise;
			unsubscribe();
		}
		await session.waitForIdle();

		const persisted = sessionManager
			.getBranch()
			.filter(entry => entry.type === "message")
			.map(entry => entry.message)
			.filter(message => message.role === "assistant");
		expect(persisted).toHaveLength(2);
		expect(persisted.map(message => message.contextSnapshot)).toEqual([undefined, undefined]);
		await tempDir.remove();
	});

	it("rebases component estimates without counting the pre-compaction tail twice", () => {
		const before = estimateContextSnapshotAttribution(1_000, 100, 250, "estimate");
		expect(before).toMatchObject({ storedMessagesTokens: 650, tailTokens: 250 });
		expect(before.storedMessagesTokens + before.tailTokens).toBe(900);

		const rebased = estimateContextSnapshotAttribution(400, 100, 0, "estimate", "compaction-2");
		expect(rebased).toEqual({
			storedMessagesTokens: 300,
			tailTokens: 0,
			promptTokensSource: "estimate",
			compactionEntryId: "compaction-2",
		});
		expect(rebased.storedMessagesTokens + rebased.tailTokens).toBe(300);
	});
});

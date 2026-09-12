/**
 * WHY: the auto-compaction candidate loop retries a failed summary on the same
 * model up to `retry.maxRetries` times when the failure is transient, and
 * moves on when it is a timeout, because re-sending a full context to a model
 * that just held it open for the whole watchdog window only pays the window
 * again. The provider watchdogs report a mid-stream stall as
 * "<provider> stream stalled while waiting for the next event", and that
 * wording classified as transient without the timeout flag, so a stalled
 * summary was re-sent ten times over. Observed 2026-09-09 on openai-codex:
 * eight retries at roughly thirty minutes apiece, the session held the whole
 * time.
 *
 * Closes the class: a summary that fails with any timeout-class message is
 * sent once per candidate, whichever provider worded it; a transient failure
 * that is not a timeout is still retried, so the fix did not disable retry.
 *
 * Does not catch: a candidate list where the stalled model is followed by
 * another candidate (the loop moves on, which is the intended path and is
 * covered by the fallback-announcement suites), nor a stall wording that
 * escapes the timeout vocabulary (pinned in packages/ai).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import * as compactionModule from "@veyyon/agent-core/compaction";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session-types";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";

const STALL_MESSAGES = [
	"Summarization failed: OpenAI Codex SSE stream stalled while waiting for the next event",
	"Summarization failed: Anthropic stream stalled while waiting for the next event",
	"Summarization failed: OpenAI responses stream timed out while waiting for the first event",
] as const;

const TRANSIENT_MESSAGE = "Summarization failed: 503 service unavailable";

describe("a stalled summary is not re-sent to the same model", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession;

	const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!bundled) throw new Error("Expected bundled anthropic/claude-sonnet-4-5 model");
	const model = { ...bundled, contextWindow: 200_000, maxTokens: 64_000 };

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-auto-compaction-stall-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("test-key");
	});

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			authStorage?.close();
			tempDir?.removeSync();
			vi.restoreAllMocks();
		}
	});

	function createSession() {
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"compaction.keepRecentTokens": 1,
				"compaction.autoContinue": false,
				"compaction.modelContextWindow": 200_000,
				"retry.maxRetries": 3,
				"retry.baseDelayMs": 1,
			} as Parameters<typeof Settings.isolated>[0]),
			modelRegistry,
		});

		for (let turn = 0; turn < 4; turn++) {
			const user = { role: "user" as const, content: `question ${turn} `.repeat(400), timestamp: Date.now() };
			const assistant = {
				role: "assistant" as const,
				content: [{ type: "text" as const, text: `answer ${turn} `.repeat(400) }],
				api: "anthropic-messages" as const,
				provider: "anthropic" as const,
				model: model.id,
				stopReason: "stop" as const,
				usage: {
					input: 1000,
					output: 100,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 1100,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: Date.now(),
			};
			session.agent.appendMessage(user);
			session.sessionManager.appendMessage(user);
			session.agent.appendMessage(assistant);
			session.sessionManager.appendMessage(assistant);
		}
	}

	function thresholdTurn() {
		return {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "Done." }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: model.id,
			stopReason: "stop" as const,
			usage: {
				input: 190_000,
				output: 1_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 191_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
	}

	async function runAutoCompaction() {
		const ends: Array<Extract<AgentSessionEvent, { type: "auto_compaction_end" }>> = [];
		const { promise: done, resolve } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") {
				ends.push(event);
				resolve();
			}
		});
		const turn = thresholdTurn();
		session.agent.emitExternalEvent({ type: "message_end", message: turn });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [turn] });
		await done;
		await session.waitForIdle();
		return ends;
	}

	for (const message of STALL_MESSAGES) {
		it(`sends the summary once when it fails with "${message}"`, async () => {
			createSession();
			let sent = 0;
			vi.spyOn(compactionModule, "compact").mockImplementation(async () => {
				sent += 1;
				throw new Error(message);
			});

			const ends = await runAutoCompaction();

			expect(sent).toBe(1);
			expect(ends).toHaveLength(1);
			expect(ends[0].result).toBeUndefined();
			expect(ends[0].errorMessage).toContain(message);
		});
	}

	it("still retries a transient failure that is not a timeout", async () => {
		createSession();
		let sent = 0;
		vi.spyOn(compactionModule, "compact").mockImplementation(async () => {
			sent += 1;
			throw new Error(TRANSIENT_MESSAGE);
		});

		const ends = await runAutoCompaction();

		// The first attempt plus `retry.maxRetries` retries.
		expect(sent).toBe(4);
		expect(ends).toHaveLength(1);
		expect(ends[0].result).toBeUndefined();
	});
});

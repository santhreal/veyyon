/**
 * Contract: automatic compaction never sends a summarization request to a model
 * whose context window provably cannot hold it.
 *
 * `estimateCompactionRequestTokens` exists so candidate admission can price the
 * whole physical request (conversation, static prompts, previous summary, hook
 * context, and the requested output budget) before a candidate is used. The
 * manual `/compact` path consulted it and skipped candidates that could not fit;
 * the automatic path did not, and that is the path that fires unattended on
 * every threshold crossing and every overflow recovery. Without the guard each
 * undersized candidate gets a full-context request that can only fail, and then
 * the next candidate is billed for the same span again.
 *
 * The differential is the same session under two `compaction.modelContextWindow`
 * values: too small to hold the payload (nothing is sent, the failure names the
 * shortfall) and large enough (the request goes out normally).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import * as compactionModule from "@veyyon/agent-core/compaction";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";

describe("auto-compaction candidate admission", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession;

	const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!bundled) throw new Error("Expected bundled anthropic/claude-sonnet-4-5 model");
	const model = { ...bundled, contextWindow: 200_000, maxTokens: 64_000 };

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-auto-compaction-admission-");
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

	/**
	 * A session holding enough conversation that the summarization request is
	 * worth thousands of tokens, with `compaction.modelContextWindow` pinned to
	 * `candidateWindow` so admission is decided by one number the test owns
	 * rather than by whatever the catalog says about each candidate.
	 */
	function createSession(candidateWindow: number) {
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"compaction.keepRecentTokens": 1,
				"compaction.autoContinue": false,
				"compaction.modelContextWindow": candidateWindow,
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

	/** The threshold-tripping turn that drives `#checkCompaction` into auto-compaction. */
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

	it("sends no summarization request when no candidate window can hold it", async () => {
		createSession(2_000);
		const compactSpy = vi.spyOn(compactionModule, "compact");

		const ends = await runAutoCompaction();

		expect(compactSpy).not.toHaveBeenCalled();
		expect(ends).toHaveLength(1);
		expect(ends[0].result).toBeUndefined();
		expect(ends[0].errorMessage).toContain("holds 2000 tokens and the summary needed");
	});

	it("sends the summarization request when the candidate window can hold it", async () => {
		createSession(200_000);
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async preparation => ({
			summary: "summary",
			shortSummary: "short",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: 42,
			details: {},
		}));

		const ends = await runAutoCompaction();

		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(ends).toHaveLength(1);
		expect(ends[0].result?.summary).toStartWith("summary");
	});
});

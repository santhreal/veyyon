/**
 * Candidate-window guard in AgentSession's compaction fallback chain.
 *
 * The summarization payload is sized against the MAIN model's threshold, so a
 * compaction candidate with a smaller context window would overflow mid-compact.
 * Such candidates must be skipped loudly, and when every candidate is too small
 * compaction must fail with an actionable error instead of a provider overflow.
 *
 * `compaction.modelContextWindow` (-1 = use each candidate's own metadata)
 * overrides the assumed window for proxies that serve a different size than
 * advertised.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/pi-agent-core";
import * as compactionModule from "@veyyon/pi-agent-core/compaction";
import { getBundledModel } from "@veyyon/pi-catalog/models";
import { ModelRegistry } from "@veyyon/pi-coding-agent/config/model-registry";
import { Settings } from "@veyyon/pi-coding-agent/config/settings";
import { AgentSession } from "@veyyon/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/pi-coding-agent/session/session-manager";
import { TempDir } from "@veyyon/pi-utils";
import { assistantMsg, userMsg } from "./utilities";

describe("compaction candidate context-window guard", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let modelRegistry: ModelRegistry;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-compaction-window-");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (session) {
			await session.dispose();
		}
		authStorage?.close();
		tempDir.removeSync();
	});

	async function createSession(overrides: Record<string, unknown>) {
		const currentModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!currentModel) {
			throw new Error("Expected bundled test model to exist");
		}

		const settings = Settings.isolated({
			"compaction.keepRecentTokens": 1,
			"compaction.strategy": "context-full",
			...overrides,
		});

		const agent = new Agent({
			initialState: {
				model: currentModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey(currentModel.provider, "anthropic-token");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.subscribe(() => {});

		for (const [userText, assistantText] of [
			["first question", "first answer"],
			["second question", "second answer"],
		] as const) {
			const user = userMsg(userText);
			const assistant = assistantMsg(assistantText);
			session.agent.appendMessage(user);
			session.sessionManager.appendMessage(user);
			session.agent.appendMessage(assistant);
			session.sessionManager.appendMessage(assistant);
		}

		return { currentModel };
	}

	it("fails with an actionable error when the configured window is smaller than the payload", async () => {
		// A 1-token assumed window is smaller than any real summarization
		// payload, so every candidate is skipped and compaction must refuse
		// loudly instead of sending an overflowing request.
		await createSession({ "compaction.modelContextWindow": 1 });
		const compactSpy = vi.spyOn(compactionModule, "compact");
		vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("anthropic-token");

		const error = await session.compact().catch(err => err);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("exceeds the context window of every compaction candidate");
		expect((error as Error).message).toContain("compaction.modelContextWindow");
		expect(compactSpy).not.toHaveBeenCalled();
	});

	it("runs compaction normally when the configured window fits the payload", async () => {
		const { currentModel } = await createSession({ "compaction.modelContextWindow": 200_000 });
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => ({
			summary: "guarded summary",
			shortSummary: "guarded short summary",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: 42,
			details: { provider: model.provider },
		}));
		vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("anthropic-token");

		const result = await session.compact();

		expect(result.summary).toBe("guarded summary");
		expect(compactSpy).toHaveBeenCalledTimes(1);
		expect(compactSpy.mock.calls[0]?.[1].id).toBe(currentModel.id);
	});

	it("uses each candidate's own metadata window when modelContextWindow is default (-1)", async () => {
		// Default sentinel: the guard reads candidate.contextWindow. Bundled
		// model windows dwarf this four-message payload, so compaction proceeds.
		await createSession({ "compaction.modelContextWindow": -1 });
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async (preparation, model) => ({
			summary: "default-window summary",
			shortSummary: "default-window short summary",
			firstKeptEntryId: preparation.firstKeptEntryId,
			tokensBefore: 42,
			details: { provider: model.provider },
		}));
		vi.spyOn(modelRegistry, "getApiKey").mockResolvedValue("anthropic-token");

		const result = await session.compact();

		expect(result.summary).toBe("default-window summary");
		expect(compactSpy).toHaveBeenCalledTimes(1);
	});
});

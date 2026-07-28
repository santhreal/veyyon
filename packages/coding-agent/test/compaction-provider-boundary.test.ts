import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type CompactionPreparation, DEFAULT_COMPACTION_SETTINGS } from "@veyyon/agent-core";
import * as compactionModule from "@veyyon/agent-core/compaction";
import { ProviderHttpError } from "@veyyon/ai/error";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ExtensionRunner } from "@veyyon/coding-agent/extensibility/extensions";
import type { MemoryBackend } from "@veyyon/coding-agent/memory-backend";
import * as memoryBackendModule from "@veyyon/coding-agent/memory-backend";
import { SecretObfuscator } from "@veyyon/coding-agent/secrets";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";

const HOOK_SECRET = "SESSION_HOOK_SECRET_7f31";
const MEMORY_SECRET = "SESSION_MEMORY_SECRET_28e4";
const LATE_SECRET = "SESSION_LATE_SECRET_b881";

const activeSessions: AgentSession[] = [];
const authStores: AuthStorage[] = [];
const tempDirs: TempDir[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(activeSessions.splice(0).map(session => session.dispose()));
	for (const store of authStores.splice(0)) store.close();
	for (const dir of tempDirs.splice(0)) dir.removeSync();
});

describe("AgentSession compaction confidentiality wiring", () => {
	it("sanitizes async hook/memory context immediately and resolves the live runtime on every fallback attempt", async () => {
		// WHY: extension and memory awaits can replace the authoritative runtime before their text reaches compact().
		const currentModel = getBundledModel("openai-codex", "gpt-5.4-mini");
		const fallbackModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!currentModel || !fallbackModel) throw new Error("Expected bundled compaction models");

		const tempDir = TempDir.createSync("@pi-compaction-boundary-");
		tempDirs.push(tempDir);
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStores.push(authStorage);
		authStorage.setRuntimeApiKey(currentModel.provider, "current-key");
		authStorage.setRuntimeApiKey(fallbackModel.provider, "fallback-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const settings = Settings.isolated({
			"compaction.keepRecentTokens": 1,
			"compaction.strategy": "summary",
		});
		settings.setModelRole("smol", `${fallbackModel.provider}/${fallbackModel.id}`);

		const sessionManager = SessionManager.inMemory(tempDir.path());
		const firstKeptEntryId = sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "kept safe text" }],
			timestamp: Date.now(),
		});
		const fixedPreparation: CompactionPreparation = {
			firstKeptEntryId,
			messagesToSummarize: [{ role: "user", content: [{ type: "text", text: "old safe text" }], timestamp: 1 }],
			turnPrefixMessages: [],
			recentMessages: [],
			isSplitTurn: false,
			tokensBefore: 100,
			previousSummary: undefined,
			previousPreserveData: undefined,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { ...DEFAULT_COMPACTION_SETTINGS, strategy: "summary" },
		};
		vi.spyOn(compactionModule, "prepareCompaction").mockReturnValue(fixedPreparation);

		let session: AgentSession;
		let refreshStage = 0;
		const refreshSecretRuntime = async () => {
			refreshStage++;
			const entries = [{ type: "plain" as const, content: HOOK_SECRET }];
			if (refreshStage >= 2) entries.push({ type: "plain", content: MEMORY_SECRET });
			if (refreshStage >= 3) entries.push({ type: "plain", content: LATE_SECRET });
			return new SecretObfuscator(entries);
		};
		const extensionRunner = {
			hasHandlers: (eventType: string) => eventType === "session.compacting",
			emit: async (event: { type: string }) => {
				if (event.type !== "session.compacting") return undefined;
				await session.refreshSecrets({ refreshPrompt: false });
				return { context: [`hook-safe ${HOOK_SECRET}`], prompt: `prompt-safe ${HOOK_SECRET}` };
			},
		} as unknown as ExtensionRunner;
		const memoryBackend: MemoryBackend = {
			id: "local",
			start() {},
			async buildDeveloperInstructions() {
				return undefined;
			},
			async clear() {},
			async enqueue() {},
			async preCompactionContext() {
				await session.refreshSecrets({ refreshPrompt: false });
				return `memory-safe ${MEMORY_SECRET}`;
			},
		};
		vi.spyOn(memoryBackendModule, "resolveMemoryBackend").mockResolvedValue(memoryBackend);

		const agent = new Agent({
			initialState: { model: currentModel, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			extensionRunner,
			obfuscator: new SecretObfuscator([]),
			refreshSecretRuntime,
		});
		activeSessions.push(session);
		session.subscribe(() => {});

		vi.spyOn(modelRegistry, "getApiKey").mockImplementation(async model => {
			if (model.provider === currentModel.provider) return "current-key";
			if (model.provider === fallbackModel.provider) return "fallback-key";
			return undefined;
		});
		const sentTexts: string[] = [];
		const compactSpy = vi
			.spyOn(compactionModule, "compact")
			.mockImplementation(async (preparation, model, _apiKey, _instructions, _signal, options) => {
				const extraContext = options?.extraContext ?? [];
				const materialized = [options?.promptOverride ?? "", ...extraContext].join("\n");
				expect(materialized).not.toContain(HOOK_SECRET);
				expect(materialized).not.toContain(MEMORY_SECRET);
				expect(materialized).toContain("hook-safe");
				expect(materialized).toContain("memory-safe");

				if (sentTexts.length === 0) await session.refreshSecrets({ refreshPrompt: false });
				const outbound = options?.obfuscateProviderText?.(`late-safe ${LATE_SECRET}`);
				if (outbound === undefined) throw new Error("Expected live compaction transform");
				sentTexts.push(outbound);
				if (model.provider === currentModel.provider) {
					throw new ProviderHttpError("credential rejected", 401);
				}
				return {
					summary: "fallback summary",
					shortSummary: "fallback short summary",
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: preparation.tokensBefore,
					details: {},
				};
			});

		const result = await session.compact();

		expect(result.summary).toBe("fallback summary");
		expect(compactSpy).toHaveBeenCalledTimes(2);
		expect(sentTexts).toHaveLength(2);
		for (const sentText of sentTexts) {
			expect(sentText).toContain("late-safe");
			expect(sentText).not.toContain(LATE_SECRET);
		}
	});
});

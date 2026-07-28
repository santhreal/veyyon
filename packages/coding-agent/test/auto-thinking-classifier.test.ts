import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { ThinkingLevel } from "@veyyon/agent-core";
import type { ApiKeyResolver, Model } from "@veyyon/ai";
import * as ai from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";
import { Effort } from "@veyyon/catalog/effort";
import { getBundledModel } from "@veyyon/catalog/models";
import {
	classifyDifficulty,
	parseDifficultyBucket,
	parseDifficultyLevel,
} from "@veyyon/coding-agent/auto-thinking/classifier";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { SecretObfuscator } from "@veyyon/coding-agent/secrets/obfuscator";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import {
	AUTO_THINKING,
	clampAutoThinkingEffort,
	parseCliThinkingLevel,
	parseConfiguredThinkingLevel,
	parseEffort,
	parseThinkingLevel,
	resolveProvisionalAutoLevel,
} from "@veyyon/coding-agent/thinking";
import type { TinyMemoryLocalModelKey } from "@veyyon/coding-agent/tiny/models";
import { tinyModelClient } from "@veyyon/coding-agent/tiny/title-client";
import { TempDir } from "@veyyon/utils";

describe("auto thinking classifier helpers", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	interface LocalClassifierFixture {
		settings: Settings;
		registry: ModelRegistry;
		model: Model;
		cleanup: () => void;
	}

	async function createLocalClassifierFixture(
		autoThinkingModel: TinyMemoryLocalModelKey,
	): Promise<LocalClassifierFixture> {
		const tempDir = TempDir.createSync("@pi-auto-thinking-classifier-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const model = getBundledModel("anthropic", "claude-sonnet-4-6");
		if (!model) {
			authStorage.close();
			tempDir.removeSync();
			throw new Error("Expected bundled Claude Sonnet 4.6 model");
		}

		return {
			settings: Settings.isolated({ "providers.autoThinkingModel": autoThinkingModel }),
			registry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			model,
			cleanup: () => {
				authStorage.close();
				tempDir.removeSync();
			},
		};
	}

	it("parses configured thinking without widening provider-facing thinking selectors", () => {
		expect(parseConfiguredThinkingLevel(AUTO_THINKING)).toBe(AUTO_THINKING);
		expect(parseConfiguredThinkingLevel(Effort.High)).toBe(Effort.High);
		expect(parseConfiguredThinkingLevel("bogus")).toBeUndefined();
		expect(parseThinkingLevel(AUTO_THINKING)).toBeUndefined();
		expect(parseThinkingLevel(ThinkingLevel.Off)).toBe(ThinkingLevel.Off);
	});

	it("parses CLI --thinking selectors while rejecting inherit", () => {
		expect(parseCliThinkingLevel(ThinkingLevel.Off)).toBe(ThinkingLevel.Off);
		expect(parseCliThinkingLevel(AUTO_THINKING)).toBe(AUTO_THINKING);
		expect(parseCliThinkingLevel("max")).toBe(ThinkingLevel.Max);
		expect(parseCliThinkingLevel(ThinkingLevel.Inherit)).toBeUndefined();
		expect(parseCliThinkingLevel("bogus")).toBeUndefined();
	});

	it("maps online 4-way classifier labels to effort levels", () => {
		expect(parseDifficultyLevel("x-high")).toBe(Effort.XHigh);
		expect(parseDifficultyLevel("The answer is HIGH.")).toBe(Effort.High);
		expect(parseDifficultyLevel("med")).toBe(Effort.Medium);
		expect(parseDifficultyLevel("low")).toBe(Effort.Low);
		expect(parseDifficultyLevel("unknown")).toBeUndefined();
	});

	it("maps local 3-bucket labels to coarse effort levels", () => {
		expect(parseDifficultyBucket("trivial")).toBe(Effort.Low);
		expect(parseDifficultyBucket("moderate")).toBe(Effort.High);
		expect(parseDifficultyBucket("hard")).toBe(Effort.XHigh);
		expect(parseDifficultyBucket("medium")).toBeUndefined();
	});

	it("expands the local reasoning classifier budget", async () => {
		let maxTokens: number | undefined;
		const fixture = await createLocalClassifierFixture("qwen3-1.7b");
		vi.spyOn(tinyModelClient, "complete").mockImplementation(async (_modelKey, _prompt, options) => {
			maxTokens = options?.maxTokens;
			return "moderate";
		});

		try {
			const effort = await classifyDifficulty("fix the local classifier token budget", {
				settings: fixture.settings,
				registry: fixture.registry,
				model: fixture.model,
			});

			expect(effort).toBe(Effort.High);
			expect(maxTokens).toBe(1024);
		} finally {
			fixture.cleanup();
		}
	});

	it("uses a larger local non-reasoning classifier floor", async () => {
		let maxTokens: number | undefined;
		const fixture = await createLocalClassifierFixture("qwen2.5-1.5b");
		vi.spyOn(tinyModelClient, "complete").mockImplementation(async (_modelKey, _prompt, options) => {
			maxTokens = options?.maxTokens;
			return "moderate";
		});

		try {
			const effort = await classifyDifficulty("rename a local helper", {
				settings: fixture.settings,
				registry: fixture.registry,
				model: fixture.model,
			});

			expect(effort).toBe(Effort.High);
			expect(maxTokens).toBe(16);
		} finally {
			fixture.cleanup();
		}
	});

	it("uses shared tiny-message preprocessing before local classification", async () => {
		let classifierPrompt = "";
		const fixture = await createLocalClassifierFixture("qwen2.5-1.5b");
		vi.spyOn(tinyModelClient, "complete").mockImplementation(async (_modelKey, promptText) => {
			classifierPrompt = promptText;
			return "moderate";
		});

		try {
			await classifyDifficulty(
				"\u001b[31minvestigate failure\u001b[0m 54783db3f0f17c74cae81976f0e825a909deb71e\n```\nnoisy code\n```",
				{
					settings: fixture.settings,
					registry: fixture.registry,
					model: fixture.model,
				},
			);

			expect(classifierPrompt).toContain("investigate failure 54783db");
			expect(classifierPrompt).not.toContain("54783db3f0f17c74cae81976f0e825a909deb71e");
			expect(classifierPrompt).not.toContain("noisy code");
		} finally {
			fixture.cleanup();
		}
	});

	it("uses a reasoning-safe online classifier budget when the catalog disables reasoning", async () => {
		const baseModel = getBundledModel("anthropic", "claude-sonnet-4-6");
		if (!baseModel) throw new Error("Expected bundled Claude Sonnet 4.6 model");
		const classifierModel = { ...baseModel, reasoning: false };
		const settings = {
			get(path: string) {
				if (path === "providers.autoThinkingModel") return "online";
				return undefined;
			},
			getModelRole(role: string) {
				return role === "smol" ? `${classifierModel.provider}/${classifierModel.id}` : undefined;
			},
			getStorage() {
				return undefined;
			},
		} as never;
		const registry = {
			getAvailable: () => [classifierModel],
			getApiKey: async () => "test-key",
			resolver: () => async () => "test-key",
		} as never;
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "high" }],
		} as never);

		const effort = await classifyDifficulty("add validation around the retry path", {
			settings,
			registry,
			model: baseModel,
		});
		const options = completeSimpleMock.mock.calls[0]?.[2] as
			| { disableReasoning?: boolean; maxTokens?: number }
			| undefined;

		expect(effort).toBe(Effort.High);
		expect(options).toMatchObject({ disableReasoning: true, maxTokens: 1024 });
	});

	it("redacts secrets at the online auto-thinking provider boundary", async () => {
		const baseModel = getBundledModel("anthropic", "claude-sonnet-4-6");
		if (!baseModel) throw new Error("Expected bundled Claude Sonnet 4.6 model");
		const classifierModel = { ...baseModel, reasoning: false };
		const settings = {
			get(path: string) {
				if (path === "providers.autoThinkingModel") return "online";
				return undefined;
			},
			getModelRole(role: string) {
				return role === "smol" ? `${classifierModel.provider}/${classifierModel.id}` : undefined;
			},
			getStorage() {
				return undefined;
			},
		} as never;
		const registry = {
			getAvailable: () => [classifierModel],
			getApiKey: async () => "test-key",
			resolver: () => async () => "test-key",
		} as never;
		const secret = "AUTO_THINKING_SECRET_76491";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }]);
		const placeholder = obfuscator.obfuscate(secret);
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "high" }],
		} as never);

		await classifyDifficulty(`Analyze the retry path using ${secret}`, {
			settings,
			registry,
			model: baseModel,
			obfuscateProviderText: text => obfuscator.obfuscate(text),
		});

		const request = completeSimpleMock.mock.calls[0]?.[1] as { messages?: Array<{ content: string }> } | undefined;
		const providerContent = request?.messages?.[0]?.content;
		expect(providerContent).toContain(placeholder);
		expect(providerContent).not.toContain(secret);
	});

	it("keeps a complete placeholder when online classification truncates around a secret", async () => {
		const baseModel = getBundledModel("anthropic", "claude-sonnet-4-6");
		if (!baseModel) throw new Error("Expected bundled Claude Sonnet 4.6 model");
		const classifierModel = { ...baseModel, reasoning: false };
		const settings = {
			get: (path: string) => (path === "providers.autoThinkingModel" ? "online" : undefined),
			getModelRole: (role: string) =>
				role === "smol" ? `${classifierModel.provider}/${classifierModel.id}` : undefined,
			getStorage: () => undefined,
		} as never;
		const registry = {
			getAvailable: () => [classifierModel],
			getApiKey: async () => "test-key",
			resolver: () => async () => "test-key",
		} as never;
		const secret = "AUTO_BOUNDARY_SECRET_ABCDEF";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }]);
		const placeholder = obfuscator.obfuscate(secret);
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "high" }],
		} as never);

		// Why: tiny preprocessing formerly cut the exact secret before replacing it,
		// and its hash cleanup could then cut the replacement itself.
		await classifyDifficulty(`${"a".repeat(1300)}${secret}${"z".repeat(1800)}`, {
			settings,
			registry,
			model: baseModel,
			obfuscateProviderText: text => obfuscator.obfuscate(text),
		});

		const request = completeSimpleMock.mock.calls[0]?.[1] as { messages: Array<{ content: string }> };
		expect(request.messages[0]?.content).toContain(placeholder);
		expect(request.messages[0]?.content).not.toContain(secret);
	});

	it("re-reads the online classifier sanitizer after credential resolution", async () => {
		const baseModel = getBundledModel("anthropic", "claude-sonnet-4-6");
		if (!baseModel) throw new Error("Expected bundled Claude Sonnet 4.6 model");
		const classifierModel = { ...baseModel, reasoning: false };
		const settings = {
			get: (path: string) => (path === "providers.autoThinkingModel" ? "online" : undefined),
			getModelRole: (role: string) =>
				role === "smol" ? `${classifierModel.provider}/${classifierModel.id}` : undefined,
			getStorage: () => undefined,
		} as never;
		const secret = "AUTO_NEW_RUNTIME_SECRET_119";
		const placeholder = "#AUTO_RUNTIME_SECRET#";
		let sanitize = (text: string) => text;
		const registry = {
			getAvailable: () => [classifierModel],
			getApiKey: async () => {
				sanitize = text => text.replaceAll(secret, placeholder);
				return "test-key";
			},
			resolver: () => async () => "test-key",
		} as never;
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "high" }],
		} as never);

		// Why: credential refresh can install a new secret runtime while the
		// classifier is suspended in getApiKey.
		await classifyDifficulty(`Analyze ${secret}`, {
			settings,
			registry,
			model: baseModel,
			obfuscateProviderText: text => sanitize(text),
		});

		const request = completeSimpleMock.mock.calls[0]?.[1] as { messages: Array<{ content: string }> };
		expect(request.messages[0]?.content).toContain(placeholder);
		expect(request.messages[0]?.content).not.toContain(secret);
	});

	it("re-sanitizes online classification for a credential retry", async () => {
		const baseModel = getBundledModel("anthropic", "claude-sonnet-4-6");
		if (!baseModel) throw new Error("Expected bundled Claude Sonnet 4.6 model");
		const classifierModel = { ...baseModel, reasoning: false };
		const settings = {
			get: (path: string) => (path === "providers.autoThinkingModel" ? "online" : undefined),
			getModelRole: (role: string) =>
				role === "smol" ? `${classifierModel.provider}/${classifierModel.id}` : undefined,
			getStorage: () => undefined,
		} as never;
		const secret = "AUTO_RETRY_SECRET_883";
		const placeholder = "#AUTO_RETRY_SECRET#";
		let sanitize = (text: string) => text;
		let attempt = 0;
		const captures: string[] = [];
		const registry = {
			getAvailable: () => [classifierModel],
			getApiKey: async () => "test-key",
			resolver: () => async () => {
				attempt++;
				if (attempt === 2) sanitize = text => text.replaceAll(secret, placeholder);
				return `test-key-${attempt}`;
			},
		} as never;
		vi.spyOn(ai, "completeSimple").mockImplementation(async (_model, context, options) => {
			const resolveKey = options?.apiKey as ApiKeyResolver;
			await resolveKey({ lastChance: false, error: undefined });
			captures.push(JSON.stringify(context));
			await resolveKey({ lastChance: true, error: new Error("401"), previousKey: "test-key-1" });
			captures.push(JSON.stringify(context));
			return { stopReason: "stop", content: [{ type: "text", text: "high" }] } as never;
		});

		// Why: the auth retry loop is inside completeSimple and otherwise reuses
		// the logical request snapshot without consulting this helper again.
		await classifyDifficulty(`Analyze ${secret}`, {
			settings,
			registry,
			model: baseModel,
			obfuscateProviderText: text => sanitize(text),
		});

		expect(captures[1]).toContain(placeholder);
		expect(captures[1]).not.toContain(secret);
	});

	it("clamps auto effort to model support while never resolving below low", () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-6");
		if (!model) throw new Error("Expected bundled Claude Sonnet 4.6 model");

		expect(clampAutoThinkingEffort(model, Effort.XHigh)).toBe(Effort.High);
		expect(clampAutoThinkingEffort(model, Effort.Minimal)).toBe(Effort.Low);
	});

	it("clamps max down to the ladder ceiling on models without a max tier", () => {
		const xhighCeilingModel = buildModel({
			id: "mock-xhigh-ceiling",
			name: "Mock XHigh Ceiling",
			api: "openai-completions",
			provider: "mock",
			baseUrl: "https://example.com",
			reasoning: true,
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh] },
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 4096,
		});

		expect(clampAutoThinkingEffort(xhighCeilingModel, Effort.Max)).toBe(Effort.XHigh);
	});

	it("returns undefined for reasoning models without controllable efforts (devin-agent shape)", () => {
		// Repro for https://github.com/can1357/oh-my-pi/issues/3356 — Devin
		// models report `reasoning: true` but expose no `thinking.efforts` (Cascade
		// selects effort by routing to sibling model ids). `auto` must not invent
		// a concrete effort here, or `requireSupportedEffort` throws in stream.ts.
		const devinModel = {
			id: "glm-5-2",
			name: "GLM-5.2",
			api: "devin-agent",
			provider: "devin",
			baseUrl: "https://server.codeium.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 4096,
		} as Model;

		expect(clampAutoThinkingEffort(devinModel, Effort.Low)).toBeUndefined();
		expect(clampAutoThinkingEffort(devinModel, Effort.XHigh)).toBeUndefined();
		expect(clampAutoThinkingEffort(devinModel, Effort.Max)).toBeUndefined();
		expect(resolveProvisionalAutoLevel(devinModel)).toBeUndefined();
	});

	it("parses max as a real thinking level", () => {
		expect(parseEffort("max")).toBe(Effort.Max);
		expect(parseThinkingLevel("max")).toBe(ThinkingLevel.Max);
		expect(parseConfiguredThinkingLevel("max")).toBe(ThinkingLevel.Max);
	});

	it("rejects inherited object keys as thinking selectors", () => {
		for (const selector of ["toString", "constructor", "__proto__"]) {
			expect(parseEffort(selector)).toBeUndefined();
			expect(parseThinkingLevel(selector)).toBeUndefined();
			expect(parseConfiguredThinkingLevel(selector)).toBeUndefined();
		}
	});
});

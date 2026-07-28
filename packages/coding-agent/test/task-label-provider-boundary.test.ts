import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Api, ApiKeyResolver, Model } from "@veyyon/ai";
import * as ai from "@veyyon/ai";
import { getBundledModel } from "@veyyon/catalog/models";
import { SecretObfuscator } from "@veyyon/coding-agent/secrets/obfuscator";
import { generateTaskLabel } from "@veyyon/coding-agent/task/label";
import { tinyTitleClient } from "@veyyon/coding-agent/tiny/title-client";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("task label provider boundary", () => {
	it("obfuscates the delegated assignment before tiny-model label generation", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5") as Model<Api> | undefined;
		if (!model) throw new Error("Expected bundled Claude Sonnet 4.5 model");
		const secret = "TASK_LABEL_RAW_SECRET_123";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }]);
		const placeholder = obfuscator.obfuscate(secret);
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "<title>Inspect account configuration</title>" }],
		} as never);
		const settings = {
			get(path: string) {
				return path === "providers.tinyModel" ? "online" : undefined;
			},
			getModelRole(role: string) {
				return role === "smol" ? `${model.provider}/${model.id}` : undefined;
			},
			getStorage() {
				return undefined;
			},
		} as never;
		const registry = {
			getAvailable: () => [model],
			getApiKey: async () => "test-key",
			getApiKeyForProvider: async () => "test-key",
			authStorage: { rotateSessionCredential: async () => false },
			resolver: () => async () => "test-key",
		} as never;

		const assignment = ` \nInspect account configuration using ${secret}\t `;
		const sanitize = vi.fn((text: string) => obfuscator.obfuscate(text));
		const label = await generateTaskLabel(assignment, registry, settings, "task-label-session", sanitize);

		expect(label).toBe("Inspect account configuration");
		const providerContext = completeSimpleMock.mock.calls[0]?.[1] as {
			messages: Array<{ content: string }>;
		};
		const captured = JSON.stringify(providerContext);
		expect(captured).not.toContain(secret);
		expect(captured).toContain(placeholder);
		// Why: label trimming is itself preprocessing; the exact raw assignment
		// must reach the transform before whitespace can alter a configured match.
		expect(sanitize.mock.calls[0]?.[0]).toBe(assignment);
	});

	it("keeps local task-label input trimmed and skips the provider sanitizer", async () => {
		const sanitize = vi.fn((text: string) => text.replace("Inspect local work", "changed"));
		const generate = vi.spyOn(tinyTitleClient, "generate").mockResolvedValue("Inspect local work");
		const settings = {
			get: (path: string) => (path === "providers.tinyModel" ? "lfm2-350m" : undefined),
		} as never;

		// Why: confidentiality hardening at an external boundary must not alter
		// explicit local-only tiny-model semantics.
		const label = await generateTaskLabel(
			" \n Inspect local work \t ",
			{} as never,
			settings,
			"local-task-label",
			sanitize,
		);

		expect(label).toBe("Inspect local work");
		expect(generate.mock.calls[0]?.[1]).toBe("Inspect local work");
		expect(sanitize).not.toHaveBeenCalled();
	});

	it("skips the sanitizer and provider for an empty delegated assignment", async () => {
		const completeSimpleMock = vi.spyOn(ai, "completeSimple");
		const obfuscateProviderText = vi.fn((text: string) => text);

		const label = await generateTaskLabel(
			" \n\t ",
			{} as never,
			{} as never,
			"empty-task-label-session",
			obfuscateProviderText,
		);

		expect(label).toBeNull();
		expect(obfuscateProviderText).not.toHaveBeenCalled();
		expect(completeSimpleMock).not.toHaveBeenCalled();
	});

	it("keeps a complete placeholder when a task label crosses title truncation", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5") as Model<Api> | undefined;
		if (!model) throw new Error("Expected bundled Claude Sonnet 4.5 model");
		const settings = {
			get: (path: string) => (path === "providers.tinyModel" ? "online" : undefined),
			getModelRole: (role: string) => (role === "smol" ? `${model.provider}/${model.id}` : undefined),
			getStorage: () => undefined,
		} as never;
		const registry = {
			getAvailable: () => [model],
			getApiKey: async () => "test-key",
			resolver: () => async () => "test-key",
		} as never;
		const secret = "TASK_LABEL_BOUNDARY_SECRET_ABCDEF";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }]);
		const placeholder = obfuscator.obfuscate(secret);
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "<title>Boundary label</title>" }],
		} as never);

		// Why: generateTaskLabel used to trim first and its title delegate used to
		// truncate first, producing two lossy seams before exact replacement.
		await generateTaskLabel(
			`${"a".repeat(1300)}${secret}${"z".repeat(1800)}`,
			registry,
			settings,
			"task-label-boundary",
			text => obfuscator.obfuscate(text),
		);

		const context = completeSimpleMock.mock.calls[0]?.[1] as { messages: Array<{ content: string }> };
		expect(context.messages[0]?.content).toContain(placeholder);
		expect(context.messages[0]?.content).not.toContain(secret);
	});

	it("re-reads the task-label sanitizer after credential resolution", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5") as Model<Api> | undefined;
		if (!model) throw new Error("Expected bundled Claude Sonnet 4.5 model");
		const settings = {
			get: (path: string) => (path === "providers.tinyModel" ? "online" : undefined),
			getModelRole: (role: string) => (role === "smol" ? `${model.provider}/${model.id}` : undefined),
			getStorage: () => undefined,
		} as never;
		const secret = "TASK_LABEL_NEW_RUNTIME_SECRET_812";
		const placeholder = "#TASK_LABEL_RUNTIME_SECRET#";
		let sanitize = (text: string) => text;
		const registry = {
			getAvailable: () => [model],
			getApiKey: async () => {
				sanitize = text => text.replaceAll(secret, placeholder);
				return "test-key";
			},
			resolver: () => async () => "test-key",
		} as never;
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "<title>Fresh label</title>" }],
		} as never);

		// Why: label generation delegates through an awaited credential lookup;
		// the delegate must not retain the sanitizer result from label trimming.
		await generateTaskLabel(`Inspect ${secret}`, registry, settings, "task-label-stale", text => sanitize(text));

		const context = completeSimpleMock.mock.calls[0]?.[1] as { messages: Array<{ content: string }> };
		expect(context.messages[0]?.content).toContain(placeholder);
		expect(context.messages[0]?.content).not.toContain(secret);
	});

	it("re-sanitizes a task-label request for a credential retry", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5") as Model<Api> | undefined;
		if (!model) throw new Error("Expected bundled Claude Sonnet 4.5 model");
		const settings = {
			get: (path: string) => (path === "providers.tinyModel" ? "online" : undefined),
			getModelRole: (role: string) => (role === "smol" ? `${model.provider}/${model.id}` : undefined),
			getStorage: () => undefined,
		} as never;
		const secret = "TASK_LABEL_RETRY_SECRET_883";
		const placeholder = "#TASK_LABEL_RETRY_SECRET#";
		let sanitize = (text: string) => text;
		let attempt = 0;
		const captures: string[] = [];
		const registry = {
			getAvailable: () => [model],
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
			return {
				stopReason: "stop",
				content: [{ type: "text", text: "<title>Retry label</title>" }],
			} as never;
		});

		// Why: the task-label helper has no visibility into completeSimple's auth
		// loop, so its title delegate must rebuild the request at resolver time.
		await generateTaskLabel(`Inspect ${secret}`, registry, settings, "task-label-retry", text => sanitize(text));

		expect(captures[1]).toContain(placeholder);
		expect(captures[1]).not.toContain(secret);
	});
});

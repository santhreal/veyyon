import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Api, Model } from "@veyyon/ai";
import * as ai from "@veyyon/ai";
import { getBundledModel } from "@veyyon/catalog/models";
import { SecretObfuscator } from "@veyyon/coding-agent/secrets/obfuscator";
import { generateTaskLabel } from "@veyyon/coding-agent/task/label";

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

		const label = await generateTaskLabel(
			`Inspect account configuration using ${secret}`,
			registry,
			settings,
			"task-label-session",
			text => obfuscator.obfuscate(text),
		);

		expect(label).toBe("Inspect account configuration");
		const providerContext = completeSimpleMock.mock.calls[0]?.[1] as {
			messages: Array<{ content: string }>;
		};
		const captured = JSON.stringify(providerContext);
		expect(captured).not.toContain(secret);
		expect(captured).toContain(placeholder);
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
});

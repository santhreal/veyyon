import { describe, expect, test } from "bun:test";
import type { Model } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";
import { resolveCliModel, resolveModelRoleValue } from "@veyyon/coding-agent/config/model-resolver";
import { Settings } from "@veyyon/coding-agent/config/settings";

function model(provider: string, id: string): Model<"anthropic-messages"> {
	return buildModel({
		provider,
		id,
		name: `${provider}/${id}`,
		api: "anthropic-messages",
		baseUrl: `https://${provider}.example.com`,
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	});
}

describe("issue #980 provider-qualified model resolution", () => {
	test("prefers the explicit anthropic provider when the exact pair exists", () => {
		const availableModels = [model("amazon-bedrock", "claude-3-7-sonnet"), model("anthropic", "claude-3-7-sonnet")];
		const settings = Settings.isolated({
			modelRoles: { default: "anthropic/claude-3-7-sonnet" },
		});

		const resolved = resolveModelRoleValue(settings.getModelRole("default"), availableModels, { settings });
		expect(resolved.model?.provider).toBe("anthropic");
		expect(resolved.model?.id).toBe("claude-3-7-sonnet");
	});

	test("does not silently fall back to bedrock when a provider-qualified role misses", () => {
		const availableModels = [model("amazon-bedrock", "claude-3-7-sonnet"), model("anthropic", "claude-sonnet-4-5")];
		const settings = Settings.isolated({
			modelRoles: { default: "anthropic/claude-3-7-sonnet" },
		});

		const roleValue = settings.getModelRole("default");
		const roleResolved = resolveModelRoleValue(roleValue, availableModels, { settings });
		expect(roleResolved.model).toBeUndefined();

		const cliResolved = resolveCliModel({
			cliModel: "anthropic/claude-3-7-sonnet",
			modelRegistry: {
				getAll: () => availableModels,
			},
		});
		expect(cliResolved.model).toBeUndefined();
		expect(cliResolved.error).toBe(
			'Model "anthropic/claude-3-7-sonnet" not found among 2 model(s) with usable credentials. Did you mean: amazon-bedrock/claude-3-7-sonnet, anthropic/claude-sonnet-4-5?',
		);
	});
});

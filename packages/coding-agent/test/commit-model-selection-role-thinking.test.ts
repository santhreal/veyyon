import { describe, expect, it } from "bun:test";
import { Effort } from "@veyyon/catalog/effort";
import { getBundledModel } from "@veyyon/catalog/models";
import { resolvePrimaryModel, resolveSmolModel } from "@veyyon/coding-agent/commit/model-selection";

function getModelOrThrow(id: string) {
	const model = getBundledModel("anthropic", id);
	if (!model) throw new Error(`Expected model ${id}`);
	return model;
}

function createSettings(modelRoles: Record<string, string>) {
	return {
		getModelRole(role: string) {
			return modelRoles[role];
		},
		getStorage() {
			return undefined;
		},
		setModelRole(role: string, value: string) {
			modelRoles[role] = value;
		},
		get(path: string) {
			if (path === "modelRoles") return modelRoles;
			return undefined;
		},
	} as never;
}

describe("commit role thinking selection", () => {
	// Which selector decides, and what the model does with it, are two questions,
	// and a fixture that asks them on one model can answer neither. This case asks
	// only the first, so every level it names must be one the target model declares:
	// Opus 4.5 declares `low`/`medium`/`high` and takes `low` as `low`, which a
	// dropped alias suffix could not fake by clamping. Resolution reports the
	// selector it read, so the `:max` on the commit role arrives as `max` here and
	// meets the model's ladder later, at the session that sends it.
	it("lets an alias's own thinking suffix replace the one stored on the role it points at", async () => {
		const defaultModel = getModelOrThrow("claude-opus-4-5");
		const commitModel = getModelOrThrow("claude-sonnet-4-5");
		const settings = createSettings({
			default: `${defaultModel.provider}/${defaultModel.id}:high`,
			commit: `${commitModel.provider}/${commitModel.id}:max`,
			smol: "@default:low",
		});
		const registry = {
			getAvailable: () => [defaultModel, commitModel],
			getApiKey: async () => "test-key",
			getApiKeyForProvider: async () => "test-key",
			authStorage: { rotateSessionCredential: async () => false as const },
			resolver: () => async () => "test-key",
		};

		const primary = await resolvePrimaryModel(undefined, settings, registry);
		expect(primary.model.id).toBe(commitModel.id);
		expect(primary.thinkingLevel).toBe(Effort.Max);

		const smol = await resolveSmolModel(settings, registry, commitModel, "fallback-key");
		expect(smol.model.id).toBe(defaultModel.id);
		// `low` rather than the `high` stored on the `default` role: the suffix
		// nearest the caller wins, and it is not appended to produce `high:low`.
		expect(smol.thinkingLevel).toBe(Effort.Low);
	});

	it("clamps a level the aliased model cannot take to its lowest, not to the aliased role's level", async () => {
		const defaultModel = getModelOrThrow("claude-opus-4-5");
		const commitModel = getModelOrThrow("claude-sonnet-4-5");
		const settings = createSettings({
			default: `${defaultModel.provider}/${defaultModel.id}:high`,
			commit: `${commitModel.provider}/${commitModel.id}:max`,
			smol: "@default:minimal",
		});
		const registry = {
			getAvailable: () => [defaultModel, commitModel],
			getApiKey: async () => "test-key",
			getApiKeyForProvider: async () => "test-key",
			authStorage: { rotateSessionCredential: async () => false as const },
			resolver: () => async () => "test-key",
		};

		const smol = await resolveSmolModel(settings, registry, commitModel, "fallback-key");

		expect(smol.model.id).toBe(defaultModel.id);
		// Opus 4.5 declares no level below `low`, so `minimal` resolves to `low`.
		// The assertion that matters is the second one: the clamp lands on the
		// model's floor and never on the `high` the aliased role stores, which is
		// what inheriting the alias target's suffix would produce.
		expect(smol.thinkingLevel).toBe(Effort.Low);
		expect(smol.thinkingLevel).not.toBe(Effort.High);
	});
});

describe("commit unavailable-default fallback (parity with the main session)", () => {
	it("substitutes an available model with a loud warning when the configured default is unavailable", async () => {
		const availableModel = getModelOrThrow("claude-sonnet-4-5");
		// Configured default points at a provider/model that is not available.
		const settings = createSettings({ default: "gonezo/model-that-left" });
		const registry = {
			getAvailable: () => [availableModel],
			getApiKey: async () => "test-key",
			getApiKeyForProvider: async () => "test-key",
			authStorage: { rotateSessionCredential: async () => false as const },
			resolver: () => async () => "test-key",
		};

		const warnings: string[] = [];
		const primary = await resolvePrimaryModel(undefined, settings, registry, message => warnings.push(message));

		expect(primary.model.id).toBe(availableModel.id);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('"gonezo/model-that-left"');
		expect(warnings[0]).toContain(`${availableModel.provider}/${availableModel.id}`);
	});

	it("still fails hard for an explicit override that does not resolve", async () => {
		const availableModel = getModelOrThrow("claude-sonnet-4-5");
		const settings = createSettings({});
		const registry = {
			getAvailable: () => [availableModel],
			getApiKey: async () => "test-key",
			getApiKeyForProvider: async () => "test-key",
			authStorage: { rotateSessionCredential: async () => false as const },
			resolver: () => async () => "test-key",
		};

		const warnings: string[] = [];
		await expect(
			resolvePrimaryModel("gonezo/model-that-left", settings, registry, message => warnings.push(message)),
		).rejects.toThrow("No model available for commit generation");
		expect(warnings).toHaveLength(0);
	});

	it("substitutes silently when no default role is configured at all", async () => {
		const availableModel = getModelOrThrow("claude-sonnet-4-5");
		const settings = createSettings({});
		const registry = {
			getAvailable: () => [availableModel],
			getApiKey: async () => "test-key",
			getApiKeyForProvider: async () => "test-key",
			authStorage: { rotateSessionCredential: async () => false as const },
			resolver: () => async () => "test-key",
		};

		const warnings: string[] = [];
		const primary = await resolvePrimaryModel(undefined, settings, registry, message => warnings.push(message));

		// Picking an available model IS the default resolution here — nothing
		// configured was skipped, so no warning (mirrors main.ts).
		expect(primary.model.id).toBe(availableModel.id);
		expect(warnings).toHaveLength(0);
	});

	it("warns when a configured smol model is skipped for missing credentials", async () => {
		const primaryModel = getModelOrThrow("claude-sonnet-4-5");
		const smolModel = getModelOrThrow("claude-opus-4-5");
		const settings = createSettings({ smol: `${smolModel.provider}/${smolModel.id}` });
		const registry = {
			getAvailable: () => [primaryModel, smolModel],
			// The configured smol model resolves but its provider has no key.
			getApiKey: async (model: { id: string }) => (model.id === smolModel.id ? undefined : "test-key"),
			getApiKeyForProvider: async () => "test-key",
			authStorage: { rotateSessionCredential: async () => false as const },
			resolver: () => async () => "test-key",
		};

		const warnings: string[] = [];
		const smol = await resolveSmolModel(settings, registry, primaryModel, "fallback-key", message =>
			warnings.push(message),
		);

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain(`${smolModel.provider}/${smolModel.id}`);
		// Substitution still lands on an authenticated model, never the unauthed one.
		expect(smol.model.id).not.toBe(smolModel.id);
	});

	it("still fails hard when no model is available at all", async () => {
		const settings = createSettings({ default: "gonezo/model-that-left" });
		const registry = {
			getAvailable: () => [],
			getApiKey: async () => "test-key",
			getApiKeyForProvider: async () => "test-key",
			authStorage: { rotateSessionCredential: async () => false as const },
			resolver: () => async () => "test-key",
		};

		await expect(resolvePrimaryModel(undefined, settings, registry, () => {})).rejects.toThrow(
			"No model available for commit generation",
		);
	});
});

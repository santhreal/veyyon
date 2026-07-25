import { describe, expect, it } from "bun:test";
import { formatModelAuthBadge, resolveModelAuthStatus } from "@veyyon/coding-agent/modes/components/model-selector";
import {
	DEFAULT_MODEL_SETTING_ID,
	getSettingsForTab,
	invalidateSettingDefsCache,
} from "@veyyon/coding-agent/modes/components/settings-defs";

describe("settings model pickers", () => {
	it("exposes modelRoles as a searchable roles editor, not a JSON text field", () => {
		invalidateSettingDefsCache();
		const roles = getSettingsForTab("model").find(def => def.path === "modelRoles");
		expect(roles?.type).toBe("modelRoles");
		expect(roles?.group).toBe("Roles");
	});

	it("exposes compaction.model as a model selector on the model tab", () => {
		invalidateSettingDefsCache();
		const modelTab = getSettingsForTab("model");
		expect(modelTab.find(def => def.path === "compaction.model")?.type).toBe("modelSelector");
	});

	/**
	 * The subagent model is a picker too, but it lives on the Subagents tab beside
	 * the per-agent rows and the delegation switch that decide alongside it. It sat
	 * on the Model tab while the per-agent overrides sat behind `/agents` and a role
	 * called "Subtask" sat in the role table: three places to look for one decision,
	 * which is how an operator could set a subagent model and watch something else
	 * win.
	 */
	it("exposes subagent.model as a model selector on the subagents tab", () => {
		invalidateSettingDefsCache();
		expect(getSettingsForTab("subagents").find(def => def.path === "subagent.model")?.type).toBe("modelSelector");
		expect(getSettingsForTab("model").find(def => def.path === "subagent.model")).toBeUndefined();
	});

	/**
	 * The gap this closes: `/settings` had no control for the DEFAULT (main)
	 * model — only roles and the subagent slot — so a user could not pick the
	 * model each new session starts on without editing config by hand. The entry
	 * is synthetic (no schema key; it maps to the `default` model-role slot the
	 * interactive `/model` choice persists to) and must sit at the very top of the
	 * model tab's "Models" group, where "what model do I start on?" is looked for.
	 */
	it("exposes a Default Model entry at the top of the model tab", () => {
		invalidateSettingDefsCache();
		const modelTab = getSettingsForTab("model");
		const dm = modelTab.find(def => def.path === DEFAULT_MODEL_SETTING_ID);
		expect(dm?.type).toBe("defaultModel");
		expect(dm?.label).toBe("Default Model");
		expect(dm?.group).toBe("Models");
		// First item in the Models group (top of the tab).
		expect(modelTab.filter(def => def.group === "Models")[0]?.path).toBe(DEFAULT_MODEL_SETTING_ID);
	});
});

describe("model auth badges", () => {
	it("formats authenticated / keyless / unauthenticated labels", () => {
		expect(formatModelAuthBadge("authenticated")).toEqual({ text: "auth", color: "success" });
		expect(formatModelAuthBadge("keyless")).toEqual({ text: "local", color: "dim" });
		expect(formatModelAuthBadge("unauthenticated")).toEqual({ text: "no auth", color: "warning" });
	});

	it("resolveModelAuthStatus uses registry auth + keyless", () => {
		const model = {
			id: "x",
			name: "x",
			provider: "ollama",
			api: "openai-completions",
			baseUrl: "",
			reasoning: false,
			input: ["text" as const],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1,
			maxTokens: 1,
		};
		const keyless = {
			isKeylessProvider: (p: string) => p === "ollama",
			hasConfiguredAuth: () => true,
			authStorage: { hasAuth: () => false },
		};
		expect(resolveModelAuthStatus(keyless as never, model as never)).toBe("keyless");

		const authed = {
			isKeylessProvider: () => false,
			hasConfiguredAuth: () => true,
			authStorage: { hasAuth: () => true },
		};
		expect(resolveModelAuthStatus(authed as never, model as never)).toBe("authenticated");

		const missing = {
			isKeylessProvider: () => false,
			hasConfiguredAuth: () => false,
			authStorage: { hasAuth: () => false },
		};
		expect(resolveModelAuthStatus(missing as never, model as never)).toBe("unauthenticated");
	});
});

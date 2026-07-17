import { describe, expect, it } from "bun:test";
import { formatModelAuthBadge, resolveModelAuthStatus } from "@veyyon/pi-coding-agent/modes/components/model-selector";
import { getSettingsForTab, invalidateSettingDefsCache } from "@veyyon/pi-coding-agent/modes/components/settings-defs";

describe("settings model pickers", () => {
	it("exposes modelRoles as a searchable roles editor, not a JSON text field", () => {
		invalidateSettingDefsCache();
		const roles = getSettingsForTab("model").find(def => def.path === "modelRoles");
		expect(roles?.type).toBe("modelRoles");
		expect(roles?.group).toBe("Roles");
	});

	it("exposes subagent.model and compaction.model as model selectors", () => {
		invalidateSettingDefsCache();
		const modelTab = getSettingsForTab("model");
		expect(modelTab.find(def => def.path === "subagent.model")?.type).toBe("modelSelector");
		expect(modelTab.find(def => def.path === "compaction.model")?.type).toBe("modelSelector");
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

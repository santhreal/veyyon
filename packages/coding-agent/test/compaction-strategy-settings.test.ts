import { describe, expect, it } from "bun:test";
import {
	migrateCompactionStrategyValue,
	normalizeCompactionStrategy,
} from "@veyyon/coding-agent/config/compaction-strategy";
import { resolveAgentModelPatterns, resolveCompactionModelPatterns } from "@veyyon/coding-agent/config/model-resolver";
import { getKnownRoleIds, MODEL_ROLE_IDS, SELECTABLE_MODEL_ROLE_IDS } from "@veyyon/coding-agent/config/model-roles";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { getSettingsForTab } from "@veyyon/coding-agent/modes/components/settings-defs";

describe("compaction strategy settings", () => {
	// After the image-archive engine was removed, every in-session strategy
	// (`snap`/`snapcompact`/`context-full`/`shake`) folds to the pure-LLM
	// `summary` strategy; only `handoff` (session transfer) stays distinct.
	it("normalizes legacy strategy tokens to handoff or summary only", () => {
		expect(normalizeCompactionStrategy("snapcompact")).toBe("summary");
		expect(normalizeCompactionStrategy("snap")).toBe("summary");
		expect(normalizeCompactionStrategy("summary")).toBe("summary");
		expect(normalizeCompactionStrategy("context-full")).toBe("summary");
		expect(normalizeCompactionStrategy("shake")).toBe("summary");
		expect(normalizeCompactionStrategy("handoff")).toBe("handoff");
		expect(normalizeCompactionStrategy("off")).toBe("summary");
		expect(migrateCompactionStrategyValue("snapcompact")).toBe("summary");
	});

	it("migrates persisted compaction.strategy values on settings load", () => {
		// A persisted `snap`/`snapcompact` strategy from before the removal now
		// loads as `summary` (in-place LLM summarization).
		const fromSnapcompact = Settings.isolated({ "compaction.strategy": "snapcompact" });
		expect(fromSnapcompact.get("compaction.strategy")).toBe("summary");

		const fromContextFull = Settings.isolated({ "compaction.strategy": "context-full" });
		expect(fromContextFull.get("compaction.strategy")).toBe("summary");

		const fromOff = Settings.isolated({ "compaction.strategy": "off" });
		expect(fromOff.get("compaction.strategy")).toBe("handoff");
		expect(fromOff.get("compaction.enabled")).toBe(false);
	});

	it("migrates compactionModel into compaction.model when unset", () => {
		const settings = Settings.isolated({
			compaction: { compactionModel: "openai/gpt-5" },
		} as Record<string, unknown>);
		expect(settings.get("compaction.model")).toBe("openai/gpt-5");
	});
});

describe("model role selectability", () => {
	it("excludes default from selectable built-in role ids", () => {
		expect(MODEL_ROLE_IDS).not.toContain("default");
		expect(SELECTABLE_MODEL_ROLE_IDS).not.toContain("default");
	});

	it("getKnownRoleIds does not surface default", () => {
		const settings = Settings.isolated({ modelRoles: { default: "openai/gpt-5" } });
		expect(getKnownRoleIds(settings)).not.toContain("default");
	});
});

describe("subagent and compaction model resolution", () => {
	it("prefers subagent.model over agent frontmatter model", () => {
		const settings = Settings.isolated({
			"subagent.model": "openai/gpt-5",
			modelRoles: { task: "anthropic/claude-sonnet-4-5" },
		});
		const patterns = resolveAgentModelPatterns({
			agentModel: "@task",
			settings,
			activeModelPattern: "openai/gpt-4.1",
		});
		expect(patterns[0]).toContain("gpt-5");
	});

	it("reads compaction.model from settings", () => {
		const settings = Settings.isolated({ "compaction.model": "openai/gpt-5" });
		expect(resolveCompactionModelPatterns(settings)).toEqual(["openai/gpt-5"]);
	});
});

describe("model tab compaction UI", () => {
	it("exposes the three compaction fields plus subagent.model on the model tab", () => {
		const modelTab = getSettingsForTab("model");
		const paths = modelTab.map(def => def.path);
		expect(paths).toContain("subagent.model");
		expect(paths).toContain("compaction.thresholdPercent");
		expect(paths).toContain("compaction.strategy");
		expect(paths).toContain("compaction.model");
	});

	it("keeps advanced compaction knobs schema-only", () => {
		const visible = getSettingsForTab("model").map(def => def.path);
		expect(visible).not.toContain("compaction.enabled");
		expect(visible).not.toContain("compaction.autoContinue");
	});

	it("exposes modelRoles on the model tab under Roles", () => {
		const rolesUi = getSettingsForTab("model").filter(def => def.group === "Roles");
		expect(rolesUi.map(def => def.path)).toContain("modelRoles");
	});
});

import { describe, expect, it } from "bun:test";
import {
	migrateCompactionStrategyValue,
	normalizeCompactionStrategy,
} from "@veyyon/coding-agent/config/compaction-strategy";
import { resolveCompactionModelPatterns } from "@veyyon/coding-agent/config/model-resolver";
import { getKnownRoleIds, MODEL_ROLE_IDS, SELECTABLE_MODEL_ROLE_IDS } from "@veyyon/coding-agent/config/model-roles";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { SETTINGS_SCHEMA } from "@veyyon/coding-agent/config/settings-schema";
import { getSettingsForTab } from "@veyyon/coding-agent/modes/components/settings-defs";
import { resolveSubagentModel } from "@veyyon/coding-agent/task/subagent-settings";

describe("compaction strategy settings", () => {
	// Every historical strategy token now folds to the sole in-place `summary`
	// strategy. Session transfer is owned only by the explicit `/handoff` command.
	it("normalizes every legacy strategy token to summary", () => {
		for (const strategy of ["snapcompact", "snap", "summary", "context-full", "shake", "handoff", "off"]) {
			expect(normalizeCompactionStrategy(strategy)).toBe("summary");
			expect(migrateCompactionStrategyValue(strategy)).toBe("summary");
		}
	});

	it("migrates persisted compaction.strategy values on settings load", () => {
		for (const strategy of ["snapcompact", "context-full", "shake-summary", "handoff"]) {
			const migrated = Settings.isolated({ "compaction.strategy": strategy });
			expect(migrated.get("compaction.strategy")).toBe("summary");
		}

		const fromOff = Settings.isolated({ "compaction.strategy": "off" });
		expect(fromOff.get("compaction.strategy")).toBe("summary");
		expect(fromOff.get("compaction.enabled")).toBe(false);
	});

	it("offers summary as the only strategy in settings", () => {
		const entry = SETTINGS_SCHEMA["compaction.strategy"];

		expect(entry.type).toBe("enum");
		expect(entry.values).toEqual(["summary"]);
		expect(entry.ui?.options?.map(option => option.value)).toEqual(["summary"]);
	});

	it("normalizes every unrecognized strategy to summary rather than passing it through", () => {
		// The default is deliberate: an unreadable strategy must still compact, so
		// a typo cannot silently leave a session with no context management. It is
		// `summary` and not `handoff` because summarizing in place is the
		// lower-consequence of the two when the intent is unknown.
		for (const unknown of ["shake-summary", "SUMMARY", "handoff ", "archive", "", "snapshot", "0", "true"]) {
			expect(normalizeCompactionStrategy(unknown)).toBe("summary");
		}
		expect(normalizeCompactionStrategy(undefined)).toBe("summary");
	});

	it("maps every known and unknown string to summary", () => {
		const inputs = ["handoff", "summary", "snap", "snapcompact", "context-full", "shake", "off", "nonsense"];
		expect(inputs.map(value => normalizeCompactionStrategy(value))).toEqual(inputs.map(() => "summary"));
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
	/**
	 * `subagent.model` outranks an agent definition's own `model:` frontmatter, so
	 * one blanket setting really does move every subagent. The full four-layer
	 * matrix lives in the subagent-model suite; this keeps the neighbouring
	 * compaction case honest company.
	 */
	it("prefers subagent.model over agent frontmatter model", () => {
		const settings = Settings.isolated({ "subagent.model": "openai/gpt-5" });
		const resolved = resolveSubagentModel({
			settings,
			agentName: "scout",
			agentModel: "anthropic/claude-sonnet-4-5",
			activeModelPattern: "openai/gpt-4.1",
		});
		expect(resolved.source).toBe("blanket");
		expect(resolved.patterns[0]).toContain("gpt-5");
	});

	it("reads compaction.model from settings", () => {
		const settings = Settings.isolated({ "compaction.model": "openai/gpt-5" });
		expect(resolveCompactionModelPatterns(settings)).toEqual(["openai/gpt-5"]);
	});
});

describe("model tab compaction UI", () => {
	it("exposes the three compaction fields on the model tab", () => {
		const modelTab = getSettingsForTab("model");
		const paths = modelTab.map(def => def.path);
		expect(paths).toContain("compaction.threshold");
		expect(paths).toContain("compaction.strategy");
		expect(paths).toContain("compaction.model");
	});

	/**
	 * The subagent model belongs to the Subagents tab, next to the per-agent rows
	 * and the delegation switch that decide alongside it.
	 *
	 * It sat on the Model tab while the per-agent overrides sat behind `/agents` and
	 * a role called "Subtask" sat in the model hub — three places to look for one
	 * decision, which is how an operator could set a subagent model and watch
	 * something else win. One tab owns it now.
	 */
	it("keeps the subagent model on the subagents tab, not the model tab", () => {
		expect(getSettingsForTab("model").map(def => def.path)).not.toContain("subagent.model");
		expect(getSettingsForTab("subagents").map(def => def.path)).toContain("subagent.model");
	});

	/**
	 * There is EXACTLY ONE row for the compaction trigger.
	 *
	 * Two rows both labelled "Compaction Threshold" (`thresholdTokens` and
	 * `thresholdPercent`) shipped for months: an operator could not tell which was
	 * in force, and editing the wrong one silently did nothing. This asserts on the
	 * visible LABEL, not the path, because the confusion was a label collision —
	 * a future percent/token split under different paths would reproduce it.
	 */
	it("shows exactly one compaction-threshold row, with the retired keys hidden", () => {
		const visible = getSettingsForTab("model");
		const thresholdRows = visible.filter(def => /compaction threshold/i.test(def.label));
		expect(thresholdRows.map(def => def.path)).toEqual(["compaction.threshold"]);

		const paths = visible.map(def => def.path);
		expect(paths).not.toContain("compaction.thresholdTokens");
		expect(paths).not.toContain("compaction.thresholdPercent");
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

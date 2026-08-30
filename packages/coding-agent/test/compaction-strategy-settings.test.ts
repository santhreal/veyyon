import { describe, expect, it } from "bun:test";
import {
	migrateCompactionStrategyValue,
	normalizeCompactionStrategy,
} from "@veyyon/coding-agent/config/compaction-strategy";
import { resolveCompactionModelPatterns } from "@veyyon/coding-agent/config/model-resolver";
import { getKnownRoleIds, MODEL_ROLE_IDS, SELECTABLE_MODEL_ROLE_IDS } from "@veyyon/coding-agent/config/model-roles";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { SETTINGS_SCHEMA } from "@veyyon/coding-agent/config/settings-schema";
import { getSettingsForTab } from "@veyyon/coding-agent/modes/terminal/components/selectors/settings-defs";
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

/**
 * WHY: a model slot with two settings surfaces is a slot the operator sets in
 * one place and the feature reads from the other. `task` was removed for that
 * reason and `advisor` followed it. The class this closes is "a built-in role
 * that owns a feature's model AND appears in the generic Roles table": the
 * table's membership is pinned by exact equality, so adding a role there is a
 * decision someone records rather than a default.
 *
 * Not caught here: a role whose model is duplicated by a NON-settings surface
 * (a slash command, a CLI flag). Those are covered by each feature's own suite.
 */
describe("model role selectability", () => {
	it("offers exactly the roles that no feature group owns", () => {
		expect(SELECTABLE_MODEL_ROLE_IDS).toEqual(["smol", "slow", "vision", "plan", "designer", "commit", "tiny"]);
	});

	it("excludes default from selectable built-in role ids", () => {
		expect(MODEL_ROLE_IDS).not.toContain("default");
		expect(SELECTABLE_MODEL_ROLE_IDS).not.toContain("default");
	});

	it("keeps the advisor slot working while dropping its row from the Roles table", () => {
		// The slot is what resolveAdvisorRoleSelection reads and what `@advisor`
		// names; only the duplicate surface went away.
		expect(MODEL_ROLE_IDS).toContain("advisor");
		expect(SELECTABLE_MODEL_ROLE_IDS).not.toContain("advisor");
		const settings = Settings.isolated({ modelRoles: { advisor: "openai/gpt-5" } });
		expect(settings.getModelRole("advisor")).toBe("openai/gpt-5");
		expect(getKnownRoleIds(settings)).toContain("advisor");
	});

	it("getKnownRoleIds does not surface default", () => {
		const settings = Settings.isolated({ modelRoles: { default: "openai/gpt-5" } });
		expect(getKnownRoleIds(settings)).not.toContain("default");
	});
});

describe("subagent and compaction model resolution", () => {
	/**
	 * `subagent.model` outranks an agent definition's own `model:` frontmatter
	 * while Same Model for All Agents is on, so one shared setting really does
	 * move every subagent. The full two-chain matrix lives in the subagent-model
	 * suite; this keeps the neighbouring compaction case honest company.
	 */
	it("prefers subagent.model over agent frontmatter model while shared is on", () => {
		const settings = Settings.isolated({ "subagent.sharedModel": true, "subagent.model": "openai/gpt-5" });
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

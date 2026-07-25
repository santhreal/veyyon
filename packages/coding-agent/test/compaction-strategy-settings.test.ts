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

	/**
	 * There are exactly two strategies, and nothing can produce a third.
	 *
	 * The settings enum said `handoff | summary` while the engine's
	 * `CompactionSettings.strategy` still admitted `"context-full"`, `"shake"`
	 * and `"off"`, so the type behind the setting disagreed with the setting. The
	 * first two are engine ACTIONS rather than user strategies; `"off"` was a
	 * second way to spell `enabled: false`, which let two fields disagree about
	 * whether compaction runs at all.
	 *
	 * These cases pin the collapsed shape from both ends: the enum a user can
	 * choose from, and the normalizer everything passes through. Without the
	 * second, a value that never appears in the enum could still reach the engine
	 * from a hand-edited config or an older session artifact.
	 */
	it("offers exactly the two strategies in the settings enum", () => {
		const entry = SETTINGS_SCHEMA["compaction.strategy"];

		expect(entry.type).toBe("enum");
		expect([...(entry as { values: readonly string[] }).values].sort()).toEqual(["handoff", "summary"]);
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

	it("keeps handoff the only value that is not summary", () => {
		// Guards the normalizer against becoming a pass-through: every legacy token
		// plus a sample of junk must land in a two-element set.
		const inputs = ["handoff", "summary", "snap", "snapcompact", "context-full", "shake", "off", "nonsense"];
		const results = new Set(inputs.map(value => normalizeCompactionStrategy(value)));

		expect([...results].sort()).toEqual(["handoff", "summary"]);
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

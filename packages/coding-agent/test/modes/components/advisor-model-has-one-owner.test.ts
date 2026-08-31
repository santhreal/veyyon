/**
 * WHY: the model the advisor runs was reachable only through the generic
 * Model → Roles table, one row among eight, while every other advisor knob
 * lived in the Advisor group. An operator who turned the advisor on had no way
 * to see which model it would run from where it was turned on, and the Roles
 * table gave the slot a second home under a different name.
 *
 * The class this closes is "a feature's model is asked for somewhere other than
 * the feature's own settings group, or in two places at once". The Advisor
 * Model row is now the only settings surface for the `advisor` slot: it appears
 * inside the Advisor group, it is hidden while the advisor is off, it reads and
 * writes the same slot `resolveAdvisorRoleSelection` resolves, and `advisor` is
 * gone from the Roles table.
 *
 * Not caught here: the per-advisor `model:` override in WATCHDOG.yml, which is
 * a deliberate second layer with different scope (one advisor, not the
 * profile), edited by `/advisor configure` and covered by advisor/config.test.ts.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { Model } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";
import type { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resolveAdvisorRoleSelection } from "@veyyon/coding-agent/config/model-resolver";
import { getRoleInfo, SELECTABLE_MODEL_ROLE_IDS } from "@veyyon/coding-agent/config/model-roles";
import { resetSettingsForTest, Settings, settings } from "@veyyon/coding-agent/config/settings";
import {
	ADVISOR_MODEL_SETTING_ID,
	ADVISOR_MODEL_SLOT,
	getAllSettingDefs,
	invalidateSettingDefsCache,
} from "@veyyon/coding-agent/modes/components/settings-defs";
import { SettingsSelectorComponent } from "@veyyon/coding-agent/modes/components/settings-selector";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { stubStdoutGeometry } from "../../helpers/stdout-geometry";

const REVIEWER = "test/reviewer-model";
const SECOND = "test/second-model";

function makeModel(id: string, name: string): Model {
	return buildModel({
		id,
		name,
		api: "openai-completions",
		provider: "test",
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10_000,
		maxTokens: 1_000,
	});
}

const MODELS = [makeModel("reviewer-model", "Reviewer model"), makeModel("second-model", "Second model")];

const modelRegistry = {
	isKeylessProvider: () => false,
	hasConfiguredAuth: () => true,
	authStorage: { hasAuth: () => true },
} as unknown as ModelRegistry;

let geometryStub: { restore(): void } | undefined;

beforeAll(async () => {
	await initTheme();
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	geometryStub = stubStdoutGeometry({ columns: 160, rows: 40 });
	invalidateSettingDefsCache();
});

afterEach(() => {
	geometryStub?.restore();
	geometryStub = undefined;
	invalidateSettingDefsCache();
	resetSettingsForTest();
});

function createSelector(): SettingsSelectorComponent {
	return new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark"],
			availablePersonalities: ["default"],
			providers: ["test"],
			cwd: process.cwd(),
			modelRegistry,
			availableModels: MODELS,
		},
		{ onChange: () => {}, onCancel: () => {} },
	);
}

/**
 * The row's rendered line, or "" when the row is not in the tab at all. Selects
 * first so the list scrolls it into view: the model tab is longer than the
 * terminal, and scanning an unscrolled render would report every row below the
 * fold as absent.
 */
function advisorModelRow(): string {
	const component = createSelector();
	component.openTab("model");
	if (!component.selectSetting(ADVISOR_MODEL_SETTING_ID)) return "";
	return (
		component
			.render(160)
			.map(stripVTControlCharacters)
			.find(line => line.includes("Advisor Model")) ?? ""
	);
}

function openAdvisorModel(): SettingsSelectorComponent {
	const component = createSelector();
	component.openTab("model");
	expect(component.selectSetting(ADVISOR_MODEL_SETTING_ID)).toBe(true);
	component.handleInput("\n");
	return component;
}

describe("advisor model has one owner", () => {
	it("declares the row inside the Advisor group, directly after Enable Advisor", () => {
		const defs = getAllSettingDefs();
		const advisorGroup = defs.filter(def => def.tab === "model" && def.group === "Advisor");
		expect(advisorGroup.map(def => def.label)).toEqual([
			"Enable Advisor",
			"Advisor Model",
			"Advisor for Subagents",
			"Advisor Sync Backlog",
			"Advisor Immune Turns",
		]);
	});

	it("hides the row while the advisor is off and shows it once on", () => {
		settings.set("advisor.enabled", false);
		expect(advisorModelRow()).toBe("");

		settings.set("advisor.enabled", true);
		expect(advisorModelRow()).toContain("Advisor Model");
	});

	it("is the only settings surface for the slot: advisor is gone from the Roles table", () => {
		expect(SELECTABLE_MODEL_ROLE_IDS).not.toContain("advisor");
		// The Roles submenu lists exactly the selectable roles, so the Advisor row
		// it used to carry cannot come back through role metadata either.
		const roleNames = SELECTABLE_MODEL_ROLE_IDS.map(role => getRoleInfo(role, settings).name);
		expect(roleNames).not.toContain(getRoleInfo("advisor", settings).name);
	});

	it("writes the slot the advisor resolver reads", () => {
		settings.set("advisor.enabled", true);
		const component = openAdvisorModel();
		for (const char of "reviewer-model") component.handleInput(char);
		component.handleInput("\n");

		expect(settings.getModelRole(ADVISOR_MODEL_SLOT)).toBe(REVIEWER);
		expect(resolveAdvisorRoleSelection(settings, MODELS, undefined)?.model.id).toBe("reviewer-model");
	});

	it("shows the assigned model on the row and clears back to inherit", () => {
		settings.set("advisor.enabled", true);
		settings.setModelRole(ADVISOR_MODEL_SLOT, SECOND);
		expect(advisorModelRow()).toContain("second-model");

		const component = openAdvisorModel();
		component.handleInput("\x7f");
		expect(settings.getModelRole(ADVISOR_MODEL_SLOT)).toBeUndefined();
		// Unset means the advisor follows the live main model, which is what
		// resolveAdvisorRoleSelection returns when the slot is empty.
		expect(resolveAdvisorRoleSelection(settings, MODELS, MODELS[1])?.model.id).toBe("second-model");
	});
});

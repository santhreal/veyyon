/**
 * WHY THIS SUITE EXISTS (EFFORT-ROWS-NARROW-TO-THE-MODEL — THE WHOLE CLASS).
 *
 * `/effort`, `/thinking`, the model hub, the role slots and the model-chain editor all ask the model
 * which efforts it exposes, so a model that routes effort through separate model ids correctly offers
 * none. Two screens did not: **Subagents → Subagent Effort** printed a fixed ladder (fixed separately,
 * and wired-tested in `settings-subagent-effort-rows.test.ts`), and **Model → Default Effort** narrowed
 * its per-model rows correctly but said nothing when the narrowing left a single row — so the user
 * got a one-row list with the heading "Valid effort variants for cursor/composer-1.5", which reads as a
 * broken screen rather than an answer.
 *
 * The incident-only version of this suite would pin those two paths. It would go green again the next
 * time an effort picker ships somewhere else, which is exactly how the second one arrived. So:
 *
 *  - The settings sweep DERIVES its variant space from `SETTINGS_SCHEMA` at run time. Every row that
 *    leaves its options to the runtime is opened against a real model, and a row is CLASSIFIED as an
 *    effort picker by behaviour (its rows are the levels the model declares) rather than by name. A new
 *    runtime row that offers efforts is therefore held to the same contract the day it lands, and a new
 *    runtime row that is not an effort picker is checked against the recorded set below so nobody has to
 *    guess whether it was considered.
 *  - The forbidden levels in each assertion are computed as "the vocabulary minus what this model
 *    declares", so adding a level to the ladder does not leave a stale hardcoded list behind.
 *  - The one-row explanation is asserted through `noSelectableEffortNotice`, the exported owner, so a
 *    second wording cannot appear on a second surface. A literal here would pass while the two screens
 *    said different things.
 *
 * What this does NOT catch: a NON-settings effort picker added to a surface with no runtime registry to
 * enumerate (a new modal, a new slash command). `configuredThinkingLevelOptions` and
 * `configuredThinkingLevelsForModel` are the two funnels every existing one goes through, and a new
 * picker that hand-rolls its list instead is invisible to any in-process test.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { Api, Model } from "@veyyon/ai";
import { type GeneratedProvider, getBundledModel } from "@veyyon/catalog/models";
import { ANY_MODEL_EFFORT_KEY } from "@veyyon/coding-agent/config/effort-resolver";
import type { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings, settings } from "@veyyon/coding-agent/config/settings";
import { getUi, isSettingPath, SETTINGS_SCHEMA, type SettingPath } from "@veyyon/coding-agent/config/settings-schema";
import { SettingsSelectorComponent } from "@veyyon/coding-agent/modes/components/settings-selector";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import {
	CONFIGURED_THINKING_LEVELS,
	configuredThinkingLevelsForModel,
	noSelectableEffortNotice,
} from "@veyyon/coding-agent/thinking";
import { stubStdoutGeometry } from "../../helpers/stdout-geometry";

/** The inherit-row label each surface uses; the notice has to name the row the user can see. */
const SETTINGS_INHERIT_LABEL = "Inherit";
const MODEL_STEP_INHERIT_LABEL = "Model default";

const ENTER = "\n";

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
	geometryStub = stubStdoutGeometry({ columns: 200, rows: 60 });
});

afterEach(() => {
	resetSettingsForTest();
	geometryStub?.restore();
	geometryStub = undefined;
});

function requireModel(provider: GeneratedProvider, id: string): Model<Api> {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`the bundled catalog has no ${provider}/${id} to narrow against`);
	return model;
}

/**
 * A Cursor row bakes its effort into the model id, so the catalog declares no selectable effort for it.
 * This is the reported shape, and the assertions below check the catalog still says so rather than
 * trusting the id: a metadata change would otherwise turn every case here into a no-op that passes.
 */
function noEffortModel(): Model<Api> {
	const model = requireModel("cursor", "composer-1.5");
	expect(configuredThinkingLevelsForModel(model)).toEqual([]);
	return model;
}

/** A model that DOES declare a ladder, so a picker narrowing to nothing everywhere cannot pass. */
function ladderModel(): Model<Api> {
	const model = requireModel("anthropic", "claude-sonnet-4-6");
	expect(configuredThinkingLevelsForModel(model).length).toBeGreaterThan(0);
	return model;
}

function build(model: Model<Api> | undefined): SettingsSelectorComponent {
	return new SettingsSelectorComponent(
		{
			model,
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark", "light"],
			availablePersonalities: ["default"],
			providers: ["cursor", "anthropic"],
			cwd: process.cwd(),
			modelRegistry,
			availableModels: model ? [model] : [],
		},
		{ onChange: () => {}, onCancel: () => {} },
	);
}

/**
 * Panel width used for every case here.
 *
 * The settings screen is a two-column panel and it wraps a long description inside the right column,
 * so at a narrow width a sentence the user reads as one sentence arrives split across rows with the
 * TAB LIST interleaved between the halves. Nothing about that is what these cases are checking, and a
 * flattened frame reads `... no selectable effort, Tasks so only Inherit applies`, so the assertions
 * would be about layout. Wide enough that the notice lands on one line, and the render width is what
 * makes that true rather than luck.
 */
const PANEL_WIDTH = 160;

/** Open one settings row's submenu with `model` in scope and return what it renders. */
function openRow(path: SettingPath, model: Model<Api> | undefined): string {
	const tab = getUi(path)?.tab;
	if (!tab) throw new Error(`${path} declares no tab, so no screen can reach it`);
	const component = build(model);
	component.openTab(tab);
	expect(component.selectSetting(path)).toBe(true);
	component.handleInput(ENTER);
	return stripVTControlCharacters(component.render(PANEL_WIDTH).join("\n"));
}

/**
 * Levels the vocabulary knows and this model does not, as word-boundary matchers.
 *
 * Derived, not listed: a level added to `CONFIGURED_THINKING_LEVELS` is covered the day it lands.
 * Boundaries matter because "Follow the session's effort" contains `low` and `xhigh` contains `high`,
 * so a substring check would fail on correct output and pass on wrong output for the same reason.
 */
function forbiddenLevelMatchers(model: Model<Api> | undefined): Array<{ level: string; pattern: RegExp }> {
	const declared = new Set<string>(configuredThinkingLevelsForModel(model).map(String));
	return CONFIGURED_THINKING_LEVELS.map(String)
		.filter(level => !declared.has(level))
		.map(level => ({ level, pattern: new RegExp(`\\b${level}\\b`) }));
}

describe("every settings row that leaves its effort options to the runtime narrows to the model", () => {
	/** Rows whose options only the runtime knows, read from the schema rather than remembered. */
	const runtimeRows: SettingPath[] = Object.keys(SETTINGS_SCHEMA)
		.filter(isSettingPath)
		.filter(path => getUi(path)?.options === "runtime");

	/**
	 * Runtime rows that are deliberately NOT effort pickers. Recorded rather than inferred so a NEW
	 * runtime row cannot slip through as "probably a theme": the assertion below fails until it is
	 * either classified as an effort picker by behaviour or written down here.
	 */
	const NON_EFFORT_RUNTIME_ROWS: Readonly<Record<string, string>> = {
		"theme.dark": "themes, filled from the installed theme list",
		"theme.light": "themes, filled from the installed theme list",
		personality: "personalities, filled from the bundled + user personality list",
	};

	/** A row is an effort picker when its rows ARE the levels the model in scope declares. */
	function isEffortPicker(path: SettingPath): boolean {
		const model = ladderModel();
		const rendered = openRow(path, model);
		return configuredThinkingLevelsForModel(model).every(level => new RegExp(`\\b${level}\\b`).test(rendered));
	}

	it("classifies every runtime row as an effort picker or records why it is not", () => {
		const effortRows = runtimeRows.filter(isEffortPicker);
		const unclassified = runtimeRows.filter(
			path => !effortRows.includes(path) && !Object.hasOwn(NON_EFFORT_RUNTIME_ROWS, path),
		);

		expect(unclassified).toEqual([]);
		// Without this the sweep below passes on a schema where nothing was found, which is the
		// green-by-luck failure that lets an unnarrowed row ship.
		expect(effortRows.length).toBeGreaterThan(0);
		expect(effortRows).toContain("subagent.thinkingLevel");
	});

	it("offers a model with no selectable effort the inherit row alone, and says why", () => {
		const model = noEffortModel();
		const effortRows = runtimeRows.filter(isEffortPicker);

		for (const path of effortRows) {
			const rendered = openRow(path, model);
			expect(rendered, path).toContain(SETTINGS_INHERIT_LABEL);
			expect(rendered, path).toContain(noSelectableEffortNotice(SETTINGS_INHERIT_LABEL));
			for (const { level, pattern } of forbiddenLevelMatchers(model)) {
				expect(pattern.test(rendered), `${path} still offers ${level}`).toBe(false);
			}
		}
	});

	it("offers a model that declares a ladder exactly its own levels, without the notice", () => {
		const model = ladderModel();
		const effortRows = runtimeRows.filter(isEffortPicker);

		for (const path of effortRows) {
			const rendered = openRow(path, model);
			for (const level of configuredThinkingLevelsForModel(model)) {
				expect(new RegExp(`\\b${level}\\b`).test(rendered), `${path} dropped ${level}`).toBe(true);
			}
			for (const { level, pattern } of forbiddenLevelMatchers(model)) {
				expect(pattern.test(rendered), `${path} offers ${level}, which this model does not declare`).toBe(false);
			}
			expect(rendered, path).not.toContain(noSelectableEffortNotice(SETTINGS_INHERIT_LABEL));
		}
	});
});

describe("Model → Default Effort explains a row it has narrowed to nothing", () => {
	/**
	 * Open Settings → Model → Default Effort and enter the first row's effort picker.
	 *
	 * Seeding the row rather than adding one through the model picker is deliberate: an
	 * ALREADY-PERSISTED value for a model that cannot accept it is the case a user arrives at
	 * (settings edited by hand, or a row written while a different model was in scope), and it is the
	 * one the read path has to answer honestly.
	 */
	function openSeededRow(model: Model<Api>, storedLevel: string): string {
		const selector = `${model.provider}/${model.id}`;
		settings.set("defaultEffort", { [selector]: storedLevel });
		const component = build(model);
		component.openTab("model");
		expect(component.selectSetting("defaultEffort")).toBe(true);
		component.handleInput(ENTER);
		// One row and no any-model row, so the first list entry is the seeded model's row.
		component.handleInput(ENTER);
		return stripVTControlCharacters(component.render(PANEL_WIDTH).join("\n"));
	}

	it("says why the picker has one row instead of heading it as valid variants", () => {
		const model = noEffortModel();

		const rendered = openSeededRow(model, "high");

		expect(rendered).toContain(MODEL_STEP_INHERIT_LABEL);
		expect(rendered).toContain(noSelectableEffortNotice(MODEL_STEP_INHERIT_LABEL));
		expect(rendered).not.toContain("Valid effort variants");
		for (const { level, pattern } of forbiddenLevelMatchers(model)) {
			expect(pattern.test(rendered), `still offers ${level}`).toBe(false);
		}
	});

	/**
	 * The other half. Without it the case above also passes on a picker that explains itself for every
	 * model and offers nothing to anyone, which is the failure a narrowing change introduces most often.
	 */
	it("keeps the variants heading and every declared level for a model that has them", () => {
		const model = ladderModel();

		const rendered = openSeededRow(model, "high");

		expect(rendered).toContain("Valid effort variants");
		expect(rendered).not.toContain(noSelectableEffortNotice(MODEL_STEP_INHERIT_LABEL));
		for (const level of configuredThinkingLevelsForModel(model)) {
			expect(new RegExp(`\\b${level}\\b`).test(rendered), `dropped ${level}`).toBe(true);
		}
	});

	/**
	 * The any-model row has no model and never will, so narrowing it would hide levels that are legal on
	 * whatever model later runs, and with only the inherit sentinel left every pick would delete the row.
	 * The notice must not appear here either: there is no model to say it about.
	 */
	it("still offers the whole vocabulary on the any-model row", () => {
		settings.set("defaultEffort", { [ANY_MODEL_EFFORT_KEY]: "high" });
		const component = build(noEffortModel());
		component.openTab("model");
		expect(component.selectSetting("defaultEffort")).toBe(true);
		component.handleInput(ENTER);
		component.handleInput(ENTER);
		const rendered = stripVTControlCharacters(component.render(PANEL_WIDTH).join("\n"));

		expect(rendered).not.toContain(noSelectableEffortNotice(MODEL_STEP_INHERIT_LABEL));
		for (const level of CONFIGURED_THINKING_LEVELS) {
			expect(new RegExp(`\\b${level}\\b`).test(rendered), `any-model row dropped ${level}`).toBe(true);
		}
	});
});

describe("the one-row explanation has one owner", () => {
	/**
	 * Two surfaces print this sentence and they name different inherit rows ("Inherit" on the settings
	 * row, "Model default" under a model), so the label is a parameter rather than two literals. If it
	 * were two literals they could drift, and the same model would read as differently broken on each
	 * screen — which is the exact complaint that started this.
	 */
	it("names the row the user can actually see on each surface", () => {
		for (const label of [SETTINGS_INHERIT_LABEL, MODEL_STEP_INHERIT_LABEL]) {
			expect(noSelectableEffortNotice(label)).toContain(label);
			expect(noSelectableEffortNotice(label)).toContain("no selectable effort");
		}
		expect(noSelectableEffortNotice()).toBe(noSelectableEffortNotice(SETTINGS_INHERIT_LABEL));
		expect(noSelectableEffortNotice(MODEL_STEP_INHERIT_LABEL)).not.toBe(noSelectableEffortNotice());
	});
});

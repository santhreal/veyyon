/**
 * The Default Model settings row owns the saved profile default, while a
 * runtime model-role override owns only the active session. These regressions
 * keep the two sources visible and independently editable.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { Model } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";
import type { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { DEFAULT_MODEL_SLOT } from "@veyyon/coding-agent/config/model-roles";
import { resetSettingsForTest, Settings, settings } from "@veyyon/coding-agent/config/settings";
import { DEFAULT_MODEL_SETTING_ID } from "@veyyon/coding-agent/modes/components/settings-defs";
import { SettingsSelectorComponent } from "@veyyon/coding-agent/modes/components/settings-selector";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { TempDir } from "@veyyon/utils";
import { stubStdoutGeometry } from "../../helpers/stdout-geometry";

const SAVED_A = "test/saved-model-a";
const RUNTIME_B = "test/runtime-model-b";
const CANDIDATE_C = "test/candidate-model-c";
const OVERRIDE_SUMMARY = "saved-model-a → runtime-model-b";

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

const MODELS = [
	makeModel("saved-model-a", "Saved model A"),
	makeModel("runtime-model-b", "Runtime model B"),
	makeModel("candidate-model-c", "Candidate model C"),
];

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
});

afterEach(() => {
	geometryStub?.restore();
	geometryStub = undefined;
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

function defaultModelRow(component: SettingsSelectorComponent): string {
	component.openTab("model");
	return (
		component
			.render(160)
			.map(stripVTControlCharacters)
			.find(line => line.includes("Default Model")) ?? ""
	);
}

function openDefaultModel(component = createSelector()): SettingsSelectorComponent {
	component.openTab("model");
	expect(component.selectSetting(DEFAULT_MODEL_SETTING_ID)).toBe(true);
	component.handleInput("\n");
	return component;
}

function setSavedAWithRuntimeB(): void {
	settings.setPersistedModelRole(DEFAULT_MODEL_SLOT, SAVED_A);
	settings.override("modelRoles", { [DEFAULT_MODEL_SLOT]: RUNTIME_B });
}

describe("default model source ownership", () => {
	/** A runtime override must change the effective role without obscuring which exact selector is saved. */
	it("keeps persisted and effective default-model selectors independently observable", () => {
		setSavedAWithRuntimeB();

		expect(settings.getPersistedModelRole(DEFAULT_MODEL_SLOT)).toBe(SAVED_A);
		expect(settings.getModelRole(DEFAULT_MODEL_SLOT)).toBe(RUNTIME_B);

		settings.setPersistedModelRole(DEFAULT_MODEL_SLOT, CANDIDATE_C);
		expect(settings.getPersistedModelRole(DEFAULT_MODEL_SLOT)).toBe(CANDIDATE_C);
		expect(settings.getModelRole(DEFAULT_MODEL_SLOT)).toBe(RUNTIME_B);

		settings.setPersistedModelRole(DEFAULT_MODEL_SLOT, undefined);
		expect(settings.getPersistedModelRole(DEFAULT_MODEL_SLOT)).toBeUndefined();
		expect(settings.getModelRole(DEFAULT_MODEL_SLOT)).toBe(RUNTIME_B);
	});

	/** /settings must name both owners so the saved launch selector is not presented as the active session selector. */
	it("renders the saved selector beside the active runtime selector", () => {
		setSavedAWithRuntimeB();

		const row = defaultModelRow(createSelector());
		expect(row).not.toBe("");
		expect(row).toContain(OVERRIDE_SUMMARY);
		expect(row).toContain("Default Model · runtime");
	});

	/** Opening on saved A, choosing C, and clearing must all write the profile layer without replacing runtime B. */
	it("preselects and edits the persisted selector while preserving the runtime override", () => {
		setSavedAWithRuntimeB();

		const preselected = openDefaultModel();
		preselected.handleInput("\n");
		expect(settings.getPersistedModelRole(DEFAULT_MODEL_SLOT)).toBe(SAVED_A);
		expect(settings.getModelRole(DEFAULT_MODEL_SLOT)).toBe(RUNTIME_B);

		const chooseCandidate = openDefaultModel();
		for (const char of "candidate-model-c") chooseCandidate.handleInput(char);
		chooseCandidate.handleInput("\n");
		expect(settings.getPersistedModelRole(DEFAULT_MODEL_SLOT)).toBe(CANDIDATE_C);
		expect(settings.getModelRole(DEFAULT_MODEL_SLOT)).toBe(RUNTIME_B);

		const clearSaved = openDefaultModel();
		clearSaved.handleInput("\x7f");
		expect(settings.getPersistedModelRole(DEFAULT_MODEL_SLOT)).toBeUndefined();
		expect(settings.getModelRole(DEFAULT_MODEL_SLOT)).toBe(RUNTIME_B);
	});

	/** Without a higher-precedence override, the saved selector is also effective and needs no active-session qualifier. */
	it("shows the saved selector alone when it is also active", () => {
		settings.setPersistedModelRole(DEFAULT_MODEL_SLOT, SAVED_A);

		expect(settings.getPersistedModelRole(DEFAULT_MODEL_SLOT)).toBe(SAVED_A);
		expect(settings.getModelRole(DEFAULT_MODEL_SLOT)).toBe(SAVED_A);
		const row = defaultModelRow(createSelector());
		expect(row).not.toBe("");
		expect(row).toContain(SAVED_A);
		expect(row).not.toContain(" · active ");
		expect(row).not.toContain("(runtime)");
	});

	/** A saved change made under a runtime override must become the next no-flag launch default. */
	it("restores the newly saved selector after a no-override reload", async () => {
		using tempDir = TempDir.createSync("@veyyon-default-model-source-");
		const first = await Settings.loadIsolated({ agentDir: tempDir.path(), cwd: tempDir.path() });
		first.override("modelRoles", { [DEFAULT_MODEL_SLOT]: RUNTIME_B });
		first.setPersistedModelRole(DEFAULT_MODEL_SLOT, CANDIDATE_C);
		await first.flush();

		expect(first.getModelRole(DEFAULT_MODEL_SLOT)).toBe(RUNTIME_B);
		const reloaded = await Settings.loadIsolated({ agentDir: tempDir.path(), cwd: tempDir.path() });
		expect(reloaded.getPersistedModelRole(DEFAULT_MODEL_SLOT)).toBe(CANDIDATE_C);
		expect(reloaded.getModelRole(DEFAULT_MODEL_SLOT)).toBe(CANDIDATE_C);
		expect(reloaded.getModelRoleSource(DEFAULT_MODEL_SLOT)).toBe("profile");
	});
});

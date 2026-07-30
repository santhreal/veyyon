/**
 * Model-chain rows summarize the effective ordered candidates regardless of the
 * valid config encoding used to store them.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { SettingsSelectorComponent } from "@veyyon/coding-agent/modes/components/settings-selector";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { stubStdoutGeometry } from "../../helpers/stdout-geometry";

const PRIMARY = "anthropic/claude-opus-4-5";
const FALLBACK = "openai/gpt-5.2";
const SUMMARY = `${PRIMARY} +1 fallback`;

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
			availableThemes: ["titanium"],
			availablePersonalities: ["default"],
			providers: [],
			cwd: process.cwd(),
		},
		{ onChange: () => {}, onCancel: () => {} },
	);
}

function rowText(component: SettingsSelectorComponent, tab: "model" | "subagents", label: string): string {
	component.openTab(tab);
	return (
		component
			.render(160)
			.map(stripVTControlCharacters)
			.find(line => line.includes(label)) ?? ""
	);
}

describe("settings model-chain summaries", () => {
	/** YAML list form is a first-class model-chain encoding and must never be mislabeled as inheritance. */
	it("summarizes array-encoded compaction and subagent chains", async () => {
		await Settings.instance.set("compaction.model", [PRIMARY, FALLBACK]);
		await Settings.instance.set("subagent.model", [PRIMARY, FALLBACK]);
		const component = createSelector();

		expect(rowText(component, "model", "Compaction Model")).toContain(SUMMARY);
		expect(rowText(component, "subagents", "Subagent Model")).toContain(SUMMARY);
	});

	/** Comma and array encodings resolve identically, so their visible summaries must be byte-for-byte equivalent. */
	it("renders comma and array encodings with the same summary", async () => {
		await Settings.instance.set("compaction.model", `${PRIMARY}, ${FALLBACK}`);
		const comma = rowText(createSelector(), "model", "Compaction Model");
		await Settings.instance.set("compaction.model", [PRIMARY, FALLBACK]);
		const array = rowText(createSelector(), "model", "Compaction Model");

		expect(comma).toContain(SUMMARY);
		expect(array).toContain(SUMMARY);
		expect(comma.trim()).toBe(array.trim());
	});

	/** Empty chains mean live inheritance; only that empty state may carry the `inherit` label. */
	it("reserves inherit for an empty chain", async () => {
		await Settings.instance.set("compaction.model", []);
		const component = createSelector();

		expect(rowText(component, "model", "Compaction Model")).toContain("inherit");
	});
});

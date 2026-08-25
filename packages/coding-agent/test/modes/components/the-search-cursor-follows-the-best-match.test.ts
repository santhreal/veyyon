/**
 * The settings search cursor follows the best match as the query refines.
 *
 * WHY THIS SUITE EXISTS. Search recomputes on every keystroke, and the list
 * preserved the selected row by id across recomputes: an intermediate query
 * whose top hit was a worse row parked the cursor there while the final
 * ranking re-ordered around it. Typing `compaction model` ranked Compaction
 * Model first but left the cursor on Compaction Fallback, so Enter — the key
 * the footer offers — activated the third-best match. Arrow keys never pass
 * through the recompute, so pinning the top row per query change costs no
 * navigation.
 *
 * What this does not catch: pointer selection, which routes around the
 * keyboard cursor entirely.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { SettingsSelectorComponent } from "@veyyon/coding-agent/modes/components/settings-selector";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { stubStdoutGeometry } from "../../helpers/stdout-geometry";

let geometryStub: { restore(): void } | undefined;

beforeAll(async () => {
	await initTheme();
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	geometryStub = stubStdoutGeometry({ columns: 100, rows: 40 });
});

afterEach(() => {
	geometryStub?.restore();
	geometryStub = undefined;
	resetSettingsForTest();
});

describe("search selection follows the best match", () => {
	it("lands on the top-ranked row after the last keystroke", () => {
		const component = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["dark"],
				availablePersonalities: [],
				providers: [],
				cwd: process.cwd(),
			},
			{ onChange: () => {}, onCancel: () => {} },
		);
		component.openTab("appearance");
		for (const char of "compaction model") component.handleInput(char);

		expect(component.getSelectedSettingId()).toBe("compaction.model");
	});

	it("keeps an arrow-key selection until the next keystroke", () => {
		const component = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["dark"],
				availablePersonalities: [],
				providers: [],
				cwd: process.cwd(),
			},
			{ onChange: () => {}, onCancel: () => {} },
		);
		component.openTab("appearance");
		for (const char of "compaction model") component.handleInput(char);
		expect(component.getSelectedSettingId()).toBe("compaction.model");

		component.handleInput("[B"); // arrow down, away from the best match
		const moved = component.getSelectedSettingId();
		expect(moved).not.toBe("compaction.model");

		// The next keystroke re-ranks, and the cursor is the best match again.
		component.handleInput("s");
		expect(component.getSelectedSettingId()).not.toBe(moved);
	});
});

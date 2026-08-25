/**
 * The selected settings row shows its description without a keypress.
 *
 * WHY THIS SUITE EXISTS. Every setting carries a `ui.description`, but the list
 * painted it only for rows the operator had expanded with Right/l — a gesture
 * nothing on the screen named. The result was a panel full of settings whose
 * descriptions were, to any reasonable reading, nonexistent. The row under the
 * cursor is the one being considered, so its description now renders inline,
 * borrowing rows from the visible window.
 *
 * The unset-value placeholder shares this file because it is the same class of
 * "the panel looked broken, not empty": a text setting with nothing stored used
 * to paint a blank value cell beside its label.
 *
 * What this does not catch: the reserved-mode band used by other panels, and
 * description wrapping past the inline cap.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
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

function createSelector(): SettingsSelectorComponent {
	return new SettingsSelectorComponent(
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
}

function frame(component: SettingsSelectorComponent): string {
	return component.render(100).map(stripVTControlCharacters).join("\n");
}

describe("the selected row shows its description", () => {
	it("paints the selected row's description with no expand keypress", () => {
		const component = createSelector();
		component.openTab("model");
		expect(component.selectSetting("compaction.threshold")).toBe(true);

		// The schema description of compaction.threshold, visible on selection alone.
		expect(frame(component)).toContain("When auto-compaction triggers");
	});

	it("does not paint a neighbouring row's description", () => {
		const component = createSelector();
		component.openTab("model");
		expect(component.selectSetting("compaction.threshold")).toBe(true);

		// Collapse Compacted History's description belongs to a row two up.
		expect(frame(component)).not.toContain("Collapse pre-compaction history behind the summary");
	});
});

describe("an unset setting shows a dash, not a blank cell", () => {
	it("marks an empty string setting", () => {
		const component = createSelector();
		component.openTab("interaction");
		expect(component.selectSetting("collab.webUrl")).toBe(true);

		expect(frame(component)).toMatch(/Web UI URL\s+—/);
	});

	it("marks an empty record setting", () => {
		const component = createSelector();
		component.openTab("interaction");
		expect(component.selectSetting("tools.approval")).toBe(true);

		expect(frame(component)).toMatch(/Tool Approval Policies\s+—/);
	});

	it("shows the stored value once one exists, dash gone", async () => {
		await Settings.instance.set("collab.webUrl", "https://example.com/ui");
		const component = createSelector();
		component.openTab("interaction");
		expect(component.selectSetting("collab.webUrl")).toBe(true);

		const panel = frame(component);
		// The value cell is narrower than the URL at this width: it clips with
		// the ellipsis marker rather than a silent cut.
		expect(panel).toContain("https://example.c…");
		expect(panel).not.toMatch(/Web UI URL\s+—/);
	});
});

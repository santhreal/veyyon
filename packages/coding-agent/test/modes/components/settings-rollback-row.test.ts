/**
 * The "Roll back version" row in `/settings`.
 *
 * Rolling back is not a setting: it has no stored value and no default, it is
 * an action taken once. It lives in the settings panel anyway, next to
 * `startup.autoUpdate`, because "updates happen on their own" and "I can undo
 * one" are the same question — and answering only the first is precisely what
 * made updates feel like something done to the user rather than configured by
 * them.
 *
 * Two properties matter enough to lock:
 *
 *   - The row appears ONLY when a real installer is wired behind it. A row that
 *     opened a picker and could then install nothing would read as a feature
 *     that exists and is broken, which is worse than no row at all.
 *   - It sits under the auto-update toggle it qualifies, anchored to that
 *     setting rather than to a fixed index, so reordering the group later
 *     cannot silently separate them.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import {
	ROLLBACK_ROW_ID,
	type SettingsCallbacks,
	SettingsSelectorComponent,
} from "@veyyon/coding-agent/modes/components/settings-selector";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { VERSION } from "@veyyon/utils";
import { stubStdoutGeometry } from "../../helpers/stdout-geometry";

const WIDTH = 160;

beforeAll(async () => {
	await initTheme();
});

let geometryStub: { restore(): void } | undefined;

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	// Tall enough that the whole interaction tab renders without scrolling. The
	// number is a FIXTURE, not a contract: these tests assert that the rollback
	// row exists and sits after the auto-update toggle, and a row scrolled out
	// of a short viewport fails them for a reason that has nothing to do with
	// either claim. It was 60, which stopped being enough the first time a
	// setting was added to the Approvals group, so give it real headroom rather
	// than the exact current height.
	geometryStub = stubStdoutGeometry({ rows: 120 });
});

afterEach(() => {
	geometryStub?.restore();
	geometryStub = undefined;
});

function createSelector(callbacks: Partial<SettingsCallbacks> = {}): SettingsSelectorComponent {
	return new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark"],
			availablePersonalities: ["default"],
			providers: ["alpha"],
			cwd: process.cwd(),
		},
		{ onChange: () => {}, onCancel: () => {}, ...callbacks },
	);
}

/** The interaction tab's rendered rows, stripped of styling. */
function interactionRows(comp: SettingsSelectorComponent): string {
	comp.openTab("interaction");
	return comp
		.render(WIDTH)
		.map(line => stripVTControlCharacters(line))
		.join("\n");
}

describe("when the host can perform a rollback", () => {
	it("offers the row", () => {
		const comp = createSelector({ onRollback: async () => {} });

		expect(interactionRows(comp)).toContain("Roll back version");
	});

	it("selects by its stable id, so other surfaces can deep-link to it", () => {
		const comp = createSelector({ onRollback: async () => {} });
		comp.openTab("interaction");

		expect(comp.selectSetting(ROLLBACK_ROW_ID)).toBe(true);
		expect(comp.getSelectedSettingId()).toBe(ROLLBACK_ROW_ID);
	});

	it("sits in the same group as the auto-update toggle", () => {
		// The row exists to answer the question the toggle raises. Separated from
		// it, it is just another command nobody finds.
		const rows = interactionRows(createSelector({ onRollback: async () => {} }));
		const toggle = rows.indexOf("Automatic Updates");
		const rollback = rows.indexOf("Roll back version");

		expect(toggle).toBeGreaterThan(-1);
		expect(rollback).toBeGreaterThan(toggle);
	});

	it("shows the running version as its value, so the row says where you are", () => {
		// A row reading "Roll back version" with no value gives no sense of what
		// you would be rolling back FROM.
		const comp = createSelector({ onRollback: async () => {} });

		expect(interactionRows(comp)).toContain(VERSION);
	});

	it("says a change takes effect on restart when the row is expanded", () => {
		// The panel closes cleanly on selection, whose obvious reading is that the
		// running process is now the version you picked. It never is. (The picker
		// itself repeats this in its title, where it cannot be missed.)
		const comp = createSelector({ onRollback: async () => {} });
		comp.openTab("interaction");
		comp.selectSetting(ROLLBACK_ROW_ID);
		comp.handleInput("\x1b[C");

		expect(
			comp
				.render(WIDTH)
				.map(line => stripVTControlCharacters(line))
				.join("\n"),
		).toContain("restart");
	});
});

describe("when the host cannot perform a rollback", () => {
	it("does not offer the row at all", () => {
		// Not disabled, not greyed: absent. A row that opens a picker and then
		// installs nothing reads as a broken feature rather than an unavailable one.
		expect(interactionRows(createSelector())).not.toContain("Roll back version");
	});

	it("still shows the auto-update setting it sits beside", () => {
		// Proves the row's absence is the row's own gate, not the whole group
		// failing to render.
		expect(interactionRows(createSelector())).toContain("Automatic Updates");
	});

	it("cannot be selected by id", () => {
		const comp = createSelector();
		comp.openTab("interaction");

		expect(comp.selectSetting(ROLLBACK_ROW_ID)).toBe(false);
	});
});

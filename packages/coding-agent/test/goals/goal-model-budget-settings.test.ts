import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { SettingsSelectorComponent } from "@veyyon/coding-agent/modes/components/settings-selector";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { stubStdoutGeometry } from "../helpers/stdout-geometry";

const SETTING = "goal.modelBudgetsEnabled" as const;

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

function createSelector(changes: Array<[string, unknown]>): SettingsSelectorComponent {
	return new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark"],
			availablePersonalities: ["default"],
			providers: [],
			cwd: process.cwd(),
		},
		{
			onChange: (path, value) => changes.push([path, value]),
			onCancel: () => {},
		},
	);
}

describe("model goal budget Settings ownership", () => {
	it("defaults off and toggles only through its Settings row", () => {
		const changes: Array<[string, unknown]> = [];
		const selector = createSelector(changes);

		expect(Settings.instance.get(SETTING)).toBe(false);
		selector.openTab("tasks");
		expect(selector.selectSetting(SETTING)).toBe(true);

		selector.handleInput(" ");
		expect(Settings.instance.get(SETTING)).toBe(true);
		expect(changes).toEqual([[SETTING, true]]);

		selector.handleInput(" ");
		expect(Settings.instance.get(SETTING)).toBe(false);
		expect(changes).toEqual([
			[SETTING, true],
			[SETTING, false],
		]);
	});
});

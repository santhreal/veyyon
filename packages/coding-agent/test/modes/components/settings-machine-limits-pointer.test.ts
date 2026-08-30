/**
 * The row on Resources that names where the machine-wide limits are.
 *
 * There are two limit scopes and they read identically on screen: "CPU Limit"
 * bounds one session tree and is stored in the active profile, "Machine CPU
 * Limit" bounds every veyyon process on the host and is stored in
 * ~/.veyyon/config.yml. Somebody who opens Resources looking for "the CPU
 * limit" sets the session one, watches a second veyyon ignore it, and
 * concludes the feature does not work. The pointer row is the only thing on
 * that tab that says the other scope exists.
 *
 * The class this closes: a Resources tab that renders without the pointer. It
 * is not a setting, so no schema, defaults test or settings-reference gate
 * covers it — the row can be dropped in a refactor and every other suite stays
 * green.
 *
 * What it does not catch: whether the Global tab still hosts the machine rows
 * it points at. The settings-domain suites own that.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import type { SettingTab } from "@veyyon/coding-agent/config/settings-schema";
import {
	MACHINE_LIMITS_POINTER_ROW_ID,
	SettingsSelectorComponent,
} from "@veyyon/coding-agent/modes/components/settings-selector";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { stubStdoutGeometry } from "../../helpers/stdout-geometry";

const WIDTH = 160;

beforeAll(async () => {
	await initTheme();
});

let geometryStub: { restore(): void } | undefined;

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	geometryStub = stubStdoutGeometry({ rows: 120 });
});

afterEach(() => {
	geometryStub?.restore();
	geometryStub = undefined;
});

function selector(): SettingsSelectorComponent {
	return new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark"],
			availablePersonalities: ["default"],
			providers: ["alpha"],
			cwd: process.cwd(),
		},
		{ onChange: () => {}, onCancel: () => {} },
	);
}

function rows(comp: SettingsSelectorComponent, tab: SettingTab): string {
	comp.openTab(tab);
	return comp
		.render(WIDTH)
		.map(line => stripVTControlCharacters(line))
		.join("\n");
}

describe("the Resources tab", () => {
	it("names the machine-wide limits", () => {
		expect(rows(selector(), "resources")).toContain("Machine-wide limits");
	});

	it("sends the reader to the Global tab, where those limits are stored", () => {
		expect(rows(selector(), "resources")).toContain("Global tab");
	});

	it("puts the pointer above the first session limit, before the wrong one is set", () => {
		const rendered = rows(selector(), "resources");
		const pointer = rendered.indexOf("Machine-wide limits");
		const sessionLimit = rendered.indexOf("CPU Limit");

		expect(pointer).toBeGreaterThan(-1);
		expect(sessionLimit).toBeGreaterThan(pointer);
	});

	it("selects by a stable id, so another surface can deep-link to it", () => {
		const comp = selector();
		comp.openTab("resources");

		expect(comp.selectSetting(MACHINE_LIMITS_POINTER_ROW_ID)).toBe(true);
		expect(comp.getSelectedSettingId()).toBe(MACHINE_LIMITS_POINTER_ROW_ID);
	});

	it("explains that a session limit is bounded by the machine limit when expanded", () => {
		// The two scopes are not independent: session groups are created inside
		// the machine group, so a session limit larger than the machine one is
		// the machine one. Somebody raising a session cap has to know that.
		const comp = selector();
		comp.openTab("resources");
		comp.selectSetting(MACHINE_LIMITS_POINTER_ROW_ID);
		comp.handleInput("\x1b[C");

		const expanded = comp
			.render(WIDTH)
			.map(line => stripVTControlCharacters(line))
			.join("\n");

		expect(expanded).toContain("bounded by it");
	});
});

describe("the other tabs", () => {
	it("do not carry the pointer, which is about the Resources tab alone", () => {
		const comp = selector();

		expect(rows(comp, "interaction")).not.toContain("Machine-wide limits");
		expect(comp.selectSetting(MACHINE_LIMITS_POINTER_ROW_ID)).toBe(false);
	});
});

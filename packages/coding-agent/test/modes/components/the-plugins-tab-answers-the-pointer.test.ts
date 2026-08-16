/**
 * WHY. The Plugins tab is the one settings tab that is not a SettingsList: it
 * mounts its own stack of views (plugin list, npm detail, marketplace detail,
 * config sub-pane) into the settings card's body. The host routed pane pointer
 * events only into `#currentList`, which is null on this tab, so hovering a
 * plugin row changed nothing, clicking one did nothing, and the wheel was dead
 * — while each view printed its keys as a dim inline hint line ("Enter to
 * configure · Esc to go back"), the oldest chrome idiom left in the tree, under
 * a card whose footer was meanwhile advertising the generic "enter change".
 *
 * THE CLASS THIS CLOSES. The pointer reaching every view the tab can mount, and
 * the card's footer naming the keys of the view actually in front of the user
 * rather than the tab behind it. Both directions are pinned: the chips are
 * asserted by exact equality per view, so a new view or a renamed key turns
 * this RED until someone decides what the pointer does with it, and the pane
 * gestures (hover, click, wheel, value-column click, chip click) are each
 * driven through the real `SettingsSelectorComponent`.
 *
 * WHAT IT DOES NOT CATCH. One terminal size. The config sub-panes (enum picker
 * and text input) are reachable only from a plugin that declares settings; the
 * chip set they hand the card is asserted, their own rows are not.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { PluginManager } from "@veyyon/coding-agent/extensibility/plugins";
import {
	type InstalledPluginSummary,
	MarketplaceManager,
} from "@veyyon/coding-agent/extensibility/plugins/marketplace";
import type { InstalledPlugin } from "@veyyon/coding-agent/extensibility/plugins/types";
import { SettingsSelectorComponent } from "@veyyon/coding-agent/modes/components/settings-selector";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { type AnsiPolicy, getAnsiPolicy, setAnsiPolicy } from "@veyyon/tui";
import { stubStdoutGeometry } from "../../helpers/stdout-geometry";

const WIDTH = 120;
/** SGR column safely inside the pane, past the category sidebar. */
const PANE_COL = 61;

function strip(s: string): string {
	return stripVTControlCharacters(s);
}

let previousAnsiPolicy: AnsiPolicy;
let geometryStub: { restore(): void } | undefined;

beforeAll(async () => {
	previousAnsiPolicy = getAnsiPolicy();
	// The hover band is a background fill; the piped-test policy strips it.
	setAnsiPolicy("full");
	await initTheme();
});

afterAll(() => {
	setAnsiPolicy(previousAnsiPolicy);
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	geometryStub = stubStdoutGeometry({ columns: WIDTH, rows: 40 });
});

afterEach(() => {
	resetSettingsForTest();
	geometryStub?.restore();
	geometryStub = undefined;
});

const npmPlugin: InstalledPlugin = {
	name: "npm-side",
	version: "1.2.3",
	path: "/cache/npm/npm-side",
	manifest: { version: "1.2.3", description: "the npm half of the list" },
	enabledFeatures: null,
	enabled: true,
};

const marketplacePlugin: InstalledPluginSummary = {
	id: "mkt-side@catalog",
	scope: "user",
	entries: [
		{
			scope: "user",
			installPath: "/cache/marketplace/mkt-side",
			version: "0.4.2",
			installedAt: "2026-01-02T03:04:05.000Z",
			lastUpdated: "2026-02-03T04:05:06.000Z",
			enabled: true,
		},
	],
};

/** A plugin that declares an enum setting, so its detail view can open a config sub-pane. */
const configurablePlugin: InstalledPlugin = {
	name: "cfg-side",
	version: "2.0.0",
	path: "/cache/npm/cfg-side",
	manifest: {
		version: "2.0.0",
		description: "declares one enum setting",
		settings: { mode: { type: "enum", description: "Pick a mode", values: ["fast", "slow"], default: "fast" } },
	},
	enabledFeatures: null,
	enabled: true,
};

function openPluginsTab(plugins: readonly InstalledPlugin[] = [npmPlugin]): {
	component: SettingsSelectorComponent;
	setEnabled: ReturnType<typeof spyOn<PluginManager, "setEnabled">>;
	setPluginSetting: ReturnType<typeof spyOn<PluginManager, "setPluginSetting">>;
	restore: () => void;
} {
	const listSpy = spyOn(PluginManager.prototype, "list").mockResolvedValue([...plugins]);
	const marketplaceSpy = spyOn(MarketplaceManager.prototype, "listInstalledPlugins").mockResolvedValue([
		marketplacePlugin,
	]);
	const settingsSpy = spyOn(PluginManager.prototype, "getPluginSettings").mockResolvedValue({});
	const setEnabled = spyOn(PluginManager.prototype, "setEnabled").mockResolvedValue(undefined);
	const setPluginSetting = spyOn(PluginManager.prototype, "setPluginSetting").mockResolvedValue(undefined);
	const component = new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark"],
			availablePersonalities: ["default"],
			providers: [],
			cwd: process.cwd(),
		},
		{ onChange: () => {}, onCancel: () => {} },
	);
	component.openTab("plugins");
	return {
		component,
		setEnabled,
		setPluginSetting,
		restore: () => {
			listSpy.mockRestore();
			marketplaceSpy.mockRestore();
			settingsSpy.mockRestore();
			setEnabled.mockRestore();
			setPluginSetting.mockRestore();
		},
	};
}

function frameLines(component: SettingsSelectorComponent): readonly string[] {
	return component.render(WIDTH);
}

function frameText(component: SettingsSelectorComponent): string {
	return frameLines(component).map(strip).join("\n");
}

/** Wait for the asynchronous npm + marketplace listing to mount the list view. */
async function awaitText(component: SettingsSelectorComponent, needle: string): Promise<void> {
	for (let attempt = 0; attempt < 400; attempt++) {
		if (frameText(component).includes(needle)) return;
		await Bun.sleep(1);
	}
	throw new Error(`the plugins tab never rendered ${JSON.stringify(needle)}:\n${frameText(component)}`);
}

/** 1-based screen row of the first line containing `needle`. */
function rowOf(component: SettingsSelectorComponent, needle: string): number {
	const index = frameLines(component).findIndex(line => strip(line).includes(needle));
	if (index === -1) throw new Error(`no rendered row contains ${JSON.stringify(needle)}`);
	return index + 1;
}

const motionAt = (row: number, col = PANE_COL): string => `\x1b[<35;${col};${row}M`;
const clickAt = (row: number, col = PANE_COL): string => `\x1b[<0;${col};${row}M`;
/** Wheel-down notch (SGR button 65). */
const wheelDownAt = (row: number, col = PANE_COL): string => `\x1b[<65;${col};${row}M`;
/**
 * Footer chip labels the card is painting, in order. Read from the contiguous
 * separator-carrying rows directly above the card's bottom border, since body
 * rows and the tip band carry the same `·` glyph.
 */
function chipLabels(component: SettingsSelectorComponent): string[] {
	const lines = frameLines(component).map(strip);
	const bottom = lines.findIndex(line => line.includes("└"));
	expect(bottom, "card bottom border").toBeGreaterThan(0);
	const footer: string[] = [];
	for (let index = bottom - 1; index >= 0; index--) {
		const line = lines[index] as string;
		if (line.includes("Tip")) break;
		if (line.includes("·")) {
			footer.unshift(line);
			continue;
		}
		if (footer.length > 0) break;
	}
	expect(footer.length, "footer rows").toBeGreaterThan(0);
	return footer
		.join("·")
		.replaceAll("│", "")
		.split("·")
		.map(part => part.trim())
		.filter(part => part.length > 0);
}

/** 1-based row/col inside the footer chip carrying `label`. */
function chipAt(component: SettingsSelectorComponent, label: string): { row: number; col: number } {
	const lines = frameLines(component).map(strip);
	const row = lines.findIndex(line => line.includes(label));
	if (row === -1) throw new Error(`no footer row carries ${JSON.stringify(label)}`);
	return { row: row + 1, col: (lines[row] as string).indexOf(label) + 2 };
}

describe("the plugins tab answers the pointer", () => {
	it("names the plugin list's keys in the card footer instead of the generic settings keys", async () => {
		const { component, restore } = openPluginsTab();
		try {
			await awaitText(component, "npm-side");

			expect(chipLabels(component)).toEqual(["up/down navigate", "enter configure", "esc close"]);
			// The old dim hint line under the list is gone: the card's footer is
			// the only place the keys are named.
			expect(frameText(component)).not.toContain("Enter to configure");
		} finally {
			restore();
		}
	});

	it("bands the plugin row under the pointer without moving the selection", async () => {
		const { component, restore } = openPluginsTab();
		try {
			await awaitText(component, "mkt-side@catalog");

			const before = frameLines(component);
			const index = before.findIndex(line => strip(line).includes("mkt-side@catalog"));
			component.handleInput(motionAt(index + 1));

			const after = frameLines(component);
			expect(strip(after[index] ?? "")).toContain("mkt-side@catalog");
			expect(after[index]).not.toBe(before[index]);
			// A background fill; fg-only styling cannot produce "48;".
			expect(after[index]).toContain("48;");
			for (let line = 0; line < before.length; line++) {
				if (line !== index) expect(after[line], `row ${line}`).toBe(before[line]);
			}
		} finally {
			restore();
		}
	});

	it("opens a plugin's detail view on a click, and the footer follows the view", async () => {
		const { component, restore } = openPluginsTab();
		try {
			await awaitText(component, "mkt-side@catalog");

			component.handleInput(clickAt(rowOf(component, "mkt-side@catalog")));
			await awaitText(component, "Enable or disable this marketplace plugin");

			expect(chipLabels(component)).toEqual(["up/down navigate", "enter toggle", "esc back"]);
			expect(frameText(component)).not.toContain("npm-side");
		} finally {
			restore();
		}
	});

	it("steps the plugin list selection on a wheel notch", async () => {
		const { component, restore } = openPluginsTab();
		try {
			await awaitText(component, "mkt-side@catalog");
			const listRow = rowOf(component, "npm-side");

			component.handleInput(wheelDownAt(listRow));
			// A wheel notch moves the cursor exactly as Down does, so the click
			// that follows lands on the second entry.
			component.handleInput("\n");
			await awaitText(component, "Enable or disable this marketplace plugin");
		} finally {
			restore();
		}
	});

	it("toggles a plugin from a click on its value column", async () => {
		const { component, setEnabled, restore } = openPluginsTab();
		try {
			await awaitText(component, "npm-side");
			component.handleInput(clickAt(rowOf(component, "npm-side")));
			await awaitText(component, "Enable or disable this plugin");

			const row = rowOf(component, "Enabled");
			// The value column sits at the right edge of the pane, where the
			// toggle's current value paints.
			const valueCol = strip(frameLines(component)[row - 1] as string).indexOf("true") + 2;
			component.handleInput(clickAt(row, valueCol));

			expect(setEnabled).toHaveBeenCalledWith("npm-side", false);
		} finally {
			restore();
		}
	});

	it("returns to the plugin list from the back chip, exactly as Esc does", async () => {
		const { component, restore } = openPluginsTab();
		try {
			await awaitText(component, "npm-side");
			component.handleInput(clickAt(rowOf(component, "npm-side")));
			await awaitText(component, "Enable or disable this plugin");

			const back = chipAt(component, "esc back");
			component.handleInput(clickAt(back.row, back.col));
			await awaitText(component, "mkt-side@catalog");

			expect(chipLabels(component)).toEqual(["up/down navigate", "enter configure", "esc close"]);
		} finally {
			restore();
		}
	});

	it("hands the card the sub-pane keys while a config row's picker is open, and answers a click in it", async () => {
		const { component, setPluginSetting, restore } = openPluginsTab([configurablePlugin]);
		try {
			await awaitText(component, "cfg-side");
			component.handleInput(clickAt(rowOf(component, "cfg-side")));
			await awaitText(component, "mode");

			// Open the enum picker from the config row's value column.
			const row = rowOf(component, "mode");
			const valueCol = strip(frameLines(component)[row - 1] as string).indexOf("fast") + 2;
			component.handleInput(clickAt(row, valueCol));
			await awaitText(component, "Pick a mode");

			// A sub-pane owns the keys, so the footer names ITS keys, not the
			// detail view's behind it.
			expect(chipLabels(component)).toEqual(["enter confirm", "esc back"]);

			component.handleInput(clickAt(rowOf(component, "slow")));
			expect(setPluginSetting).toHaveBeenCalledWith("cfg-side", "mode", "slow");
		} finally {
			restore();
		}
	});

	it("bands the settings row under the pointer inside a plugin's detail view", async () => {
		const { component, restore } = openPluginsTab([configurablePlugin]);
		try {
			await awaitText(component, "cfg-side");
			component.handleInput(clickAt(rowOf(component, "cfg-side")));
			// Two rows, so the pointer can rest on one that is NOT the selection:
			// a band over the selected row would prove nothing.
			await awaitText(component, "mode");

			const before = frameLines(component);
			const index = before.findIndex(line => strip(line).includes("mode"));
			component.handleInput(motionAt(index + 1));

			const after = frameLines(component);
			expect(after[index]).not.toBe(before[index]);
			expect(after[index]).toContain("48;");
		} finally {
			restore();
		}
	});
});

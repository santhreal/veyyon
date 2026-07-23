/**
 * SPEC-SETTINGS-SIMPLIFICATION acceptance criteria (BACKLOG.md §6).
 *
 * Note on tab names: the spec's grep-derived draft assumed a `privacy` and
 * `advanced` top-level tab would exist. The real `SettingTab` union has
 * neither — `images.blockImages` lives under the existing `providers` tab's
 * `Privacy` group, and `display.collapseCompacted` under the existing
 * `model` tab's `Compaction` group. Assertions below use the real tabs.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings, settings } from "@veyyon/coding-agent/config/settings";
import { SETTINGS_SCHEMA, TAB_GROUPS } from "@veyyon/coding-agent/config/settings-schema";
import { getSettingDef, getSettingsForTab } from "@veyyon/coding-agent/modes/components/settings-defs";
import { SettingsSelectorComponent } from "@veyyon/coding-agent/modes/components/settings-selector";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { ImageProtocol, TERMINAL } from "@veyyon/tui";
import { removeSyncWithRetries, Snowflake } from "@veyyon/utils";

type MutableTerminalInfo = { imageProtocol: ImageProtocol | null };
const terminal = TERMINAL as unknown as MutableTerminalInfo;

// The 13 keys SPEC-SETTINGS-SIMPLIFICATION demoted from appearance's flat list
// into the collapsed fold. These are the ORIGINAL appearance keys, tracked
// separately from later additions so the "26 original keys / placement-only"
// spec below stays exact.
const DEMOTED_APPEARANCE_PATHS = [
	"statusLine.sessionAccent",
	"statusLine.transparent",
	"statusLine.compactThinkingLevel",
	"statusLine.showHookStatus",
	"images.autoResize",
	"terminal.showProgress",
	"tui.textSizing",
	"tui.renderMermaid",
	"tui.tight",
	"tui.scrollbackRebuild",
	"display.cacheMissMarker",
	"showHardwareCursor",
	"task.showResolvedModelBadge",
] as const;

// Keys added to the Advanced fold AFTER the spec: new experimental toggles that
// default into Advanced (advanced: true) so the simplified 12-row appearance
// view stays stable as the product grows. `display.subagentInbox` is the
// experimental opencode-style agent split, off by default.
const EXTRA_ADVANCED_APPEARANCE_PATHS = ["display.subagentInbox"] as const;

// Everything the collapsed Advanced fold holds today: the 13 spec-demoted
// originals plus any post-spec experimental additions. Drives the heading count.
const ALL_ADVANCED_APPEARANCE_PATHS = [...DEMOTED_APPEARANCE_PATHS, ...EXTRA_ADVANCED_APPEARANCE_PATHS] as const;
const ADVANCED_COUNT = ALL_ADVANCED_APPEARANCE_PATHS.length;

// The 12 keys that stay visible in appearance's default (collapsed) view.
const KEPT_APPEARANCE_PATHS = [
	"theme.dark",
	"theme.light",
	"symbolPreset",
	"colorBlindMode",
	"statusLine.preset",
	"statusLine.separator",
	"terminal.showImages",
	"tui.hyperlinks",
	"tui.paintGround",
	"display.shimmer",
	"display.smoothStreaming",
	"display.showTokenUsage",
] as const;

beforeAll(async () => {
	await initTheme();
});

describe("appearance advanced fold — schema", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		resetSettingsForTest();
	});

	it("keeps exactly 12 non-advanced rows and 14 advanced rows in appearance, with 3 groups and no Images group", () => {
		const appearanceDefs = getSettingsForTab("appearance");
		const visible = appearanceDefs.filter(def => !def.advanced);
		const advanced = appearanceDefs.filter(def => def.advanced);

		expect(visible.map(def => def.path).sort()).toEqual([...KEPT_APPEARANCE_PATHS].sort());
		expect(advanced.map(def => def.path).sort()).toEqual([...ALL_ADVANCED_APPEARANCE_PATHS].sort());
		expect(TAB_GROUPS.appearance.length).toBe(3);
		expect(TAB_GROUPS.appearance).not.toContain("Images");
	});

	it("moves images.blockImages to providers/Privacy and display.collapseCompacted to model/Compaction without deleting either key", () => {
		expect(getSettingDef("images.blockImages")).toMatchObject({ tab: "providers", group: "Privacy" });
		expect(getSettingDef("display.collapseCompacted")).toMatchObject({ tab: "model", group: "Compaction" });
		expect(getSettingDef("terminal.showImages")).toMatchObject({ tab: "appearance", group: "Display" });
		expect(TAB_GROUPS.appearance).not.toContain("Images");
	});

	it("does not delete any of the 26 original appearance keys from the schema (demotion/move is placement-only)", () => {
		const originalAppearanceKeys = [
			...KEPT_APPEARANCE_PATHS,
			...DEMOTED_APPEARANCE_PATHS,
			"images.blockImages",
			"display.collapseCompacted",
		];
		for (const key of originalAppearanceKeys) {
			expect(Object.hasOwn(SETTINGS_SCHEMA, key)).toBe(true);
		}
	});

	it("preserves defaults for demoted and moved keys — demotion never changes a default value", () => {
		expect(settings.get("statusLine.transparent")).toBe(false);
		expect(settings.get("images.blockImages")).toBe(false);
		expect(settings.get("display.collapseCompacted")).toBe(true);
	});
});

describe("appearance advanced fold — panel rendering", () => {
	const originalProtocol = TERMINAL.imageProtocol;

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		// terminal.showImages carries `condition: hasImageProtocol`; stub the
		// protocol so the row renders deterministically alongside the other
		// 10 kept appearance settings (11 total).
		terminal.imageProtocol = ImageProtocol.Kitty;
	});

	afterEach(() => {
		resetSettingsForTest();
		terminal.imageProtocol = originalProtocol;
	});

	function createSelector(): SettingsSelectorComponent {
		return new SettingsSelectorComponent(
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
	}

	// Flat single-column layout (width 70) so every row for the tab renders inline.
	const FLAT_WIDTH = 70;

	it("collapses every advanced key behind a single Advanced heading row by default", () => {
		const comp = createSelector();
		const rendered = comp.render(FLAT_WIDTH).join("\n");

		expect(rendered).toContain("Dark Theme");
		expect(rendered).toContain("Show Inline Images");
		expect(rendered).toContain("Show Token Usage");
		expect(rendered).toContain(`Advanced (${ADVANCED_COUNT})`);

		// Demoted rows stay hidden while the fold is collapsed and every value is default.
		expect(rendered).not.toContain("Transparent Status Line");
		expect(rendered).not.toContain("Tight Layout");
		expect(rendered).not.toContain("Show Resolved Model Badge");
	});

	it("expands the Advanced fold on Enter to reveal the demoted rows, keeping the count stable", () => {
		const comp = createSelector();
		// The 12 kept rows precede the Advanced toggle in tab order; that many Down
		// presses lands selection on the toggle row itself.
		for (let i = 0; i < KEPT_APPEARANCE_PATHS.length; i++) comp.handleInput("\x1b[B");
		comp.handleInput("\n");

		const rendered = comp.render(FLAT_WIDTH).join("\n");
		expect(rendered).toContain(`Advanced (${ADVANCED_COUNT})`);
		expect(rendered).toContain("Transparent Status Line");
		expect(rendered).toContain("Render Mermaid Diagrams");
		expect(rendered).toContain("Session Accent");
		// Demoted rows below the floating viewport are reachable by scroll; the
		// fold is open when the early advanced rows paint under the toggle.
		// (The sticky "Theme" header pinned above — its own section scrolled
		// out of view — costs one row of the visible window.)
		expect(rendered).toContain(`▾ Advanced (${ADVANCED_COUNT})`);
		expect(rendered).toContain("Theme");
	});

	it("surfaces a non-default advanced value even while the fold stays collapsed, without inflating the heading count", () => {
		settings.set("statusLine.transparent", true);
		const comp = createSelector();
		const rendered = comp.render(FLAT_WIDTH).join("\n");

		// Changed value is surfaced...
		expect(rendered).toContain("Transparent Status Line");
		// ...but the heading count still reflects every advanced def, and
		// other (still-default) advanced rows stay hidden.
		expect(rendered).toContain(`Advanced (${ADVANCED_COUNT})`);
		expect(rendered).not.toContain("Tight Layout");
		expect(rendered).not.toContain("Show Resolved Model Badge");
	});
});

describe("appearance advanced fold — search", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		resetSettingsForTest();
	});

	function createSelector(): SettingsSelectorComponent {
		return new SettingsSelectorComponent(
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
	}

	it("finds a demoted (collapsed) appearance key by global search under the Appearance heading", () => {
		const comp = createSelector();
		for (const ch of "transparent") comp.handleInput(ch);

		const rendered = comp.render(120).join("\n");
		expect(rendered).toContain("Transparent Status Line");
		expect(rendered).toContain("Appearance");
	});

	it("finds the moved images.blockImages key by global search under its new Providers heading", () => {
		const comp = createSelector();
		for (const ch of "blockimages") comp.handleInput(ch);

		const rendered = comp.render(120).join("\n");
		expect(rendered).toContain("Block Images");
		expect(rendered).toContain("Providers");
	});
});

describe("settings selector — initial item jump (/statusline)", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		resetSettingsForTest();
	});

	function createSelector(initialItemId?: string): SettingsSelectorComponent {
		return new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["dark"],
				availablePersonalities: ["default"],
				providers: [],
				cwd: process.cwd(),
			},
			{ onChange: () => {}, onCancel: () => {} },
			initialItemId,
		);
	}

	it("defaults to the first appearance item when no initial item is given", () => {
		const comp = createSelector();
		expect(comp.getSelectedSettingId()).toBe("theme.dark");
	});

	it("pre-selects statusLine.preset when opened via /statusline", () => {
		const comp = createSelector("statusLine.preset");
		expect(comp.getSelectedSettingId()).toBe("statusLine.preset");
		// Cursor row renders the Status Line group's preset item, not the default Theme item.
		comp.render(70);
	});

	it("falls back to the default selection for an unknown initial item id", () => {
		const comp = createSelector("no.such.setting");
		expect(comp.getSelectedSettingId()).toBe("theme.dark");
	});
});

describe("appearance advanced fold — persistence", () => {
	it("round-trips a demoted setting through a config.yml overlay — demotion changes panel placement only, never persistence", async () => {
		const testDir = path.join(os.tmpdir(), "settings-advanced-fold-roundtrip", Snowflake.next());
		const overlayPath = path.join(testDir, "overlay.yml");
		try {
			resetSettingsForTest();
			fs.mkdirSync(testDir, { recursive: true });
			fs.writeFileSync(overlayPath, "statusLine:\n  transparent: true\n");

			const scoped = await Settings.init({ cwd: testDir, inMemory: true, configFiles: [overlayPath] });
			expect(scoped.get("statusLine.transparent")).toBe(true);
		} finally {
			resetSettingsForTest();
			if (fs.existsSync(testDir)) removeSyncWithRetries(testDir);
		}
	});
});

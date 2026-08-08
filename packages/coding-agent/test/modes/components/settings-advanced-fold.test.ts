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
import { removeSyncWithRetries } from "@veyyon/utils";

type MutableTerminalInfo = { imageProtocol: ImageProtocol | null };
const terminal = TERMINAL as unknown as MutableTerminalInfo;

// The keys SPEC-SETTINGS-SIMPLIFICATION demoted from appearance's flat list into
// the collapsed fold. These are the ORIGINAL appearance keys, tracked separately
// from later additions so the "26 original keys / placement-only" spec below stays
// exact.
//
// `subagent.showResolvedModelBadge` was one of them and is not any more: it moved
// to the Subagents tab, beside the models and per-agent rows whose resolution it
// displays. A subagent question answered on the Appearance tab is a second place to
// look, which is the whole reason that area exists.
// `statusLine.transparent` was one of them and is not any more: nothing paints a
// status-line background since the editor's top border was deleted, so the key
// kept its default but lost its row. A setting with no UI is on no tab, advanced
// or otherwise, which is why it leaves this list rather than moving between them.
const DEMOTED_APPEARANCE_PATHS = [
	"statusLine.sessionAccent",
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
] as const;

// Keys added to the Advanced fold AFTER the spec: new toggles that default
// into Advanced (advanced: true) so the simplified 12-row appearance view
// stays stable as the product grows. `tui.scrollIsolation` pins the prompt
// while the wheel scrolls the transcript, off by default because holding the
// mouse costs the terminal's own drag-to-select.
// `display.toolOutputExpanded` remembers the in-session expand-tool-output
// toggle across sessions; it lands here rather than in the visible set because
// the toggle is already how people reach it, and this row only persists the
// choice they made with it.
const EXTRA_ADVANCED_APPEARANCE_PATHS = ["tui.scrollIsolation", "display.toolOutputExpanded"] as const;

// Everything the collapsed Advanced fold holds today: the spec-demoted originals
// still on this tab, plus any post-spec experimental additions. Drives the heading
// count, so it is derived rather than written out as a number.
const ALL_ADVANCED_APPEARANCE_PATHS = [...DEMOTED_APPEARANCE_PATHS, ...EXTRA_ADVANCED_APPEARANCE_PATHS] as const;
const ADVANCED_COUNT = ALL_ADVANCED_APPEARANCE_PATHS.length;

// The 13 keys that stay visible in appearance's default (collapsed) view.
// `display.transitions` joined the visible set with the TOUCH-5 overlay
// unfold: it is the reduced-motion switch for structural chrome animation, a
// first-class taste choice like Shimmer, not an experimental toggle.
// `statusLine.enabled` joined it as the composer footline's master toggle: the
// footline ships off, so this is the row that turns it on, and a master toggle
// folded away behind Advanced would strand the feature.
const KEPT_APPEARANCE_PATHS = [
	"statusLine.enabled",
	"theme.dark",
	"theme.light",
	"symbolPreset",
	"colorBlindMode",
	"statusLine.preset",
	// `statusLine.separator` used to sit here. The seven separator styles belonged
	// to the deleted powerline bar, so the row changed nothing on screen and was
	// removed; the key survives only for the readers named in appearance.ts.
	"terminal.showImages",
	"tui.hyperlinks",
	"tui.paintGround",
	"display.transitions",
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

	it("keeps exactly the 13 curated non-advanced rows in appearance, with 3 groups and no Images group", () => {
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
		// statusLine.transparent defaults to true since the 2026-07-24 slab-class
		// fix (the inline TUI paints no backgrounds by default) — an intentional
		// product change, not a demotion side effect. The lock for that default
		// lives in status-line-transparent.test.ts; this row just tracks it.
		expect(settings.get("statusLine.transparent")).toBe(true);
		expect(settings.get("images.blockImages")).toBe(false);
		expect(settings.get("display.collapseCompacted")).toBe(true);
	});
});

describe("appearance advanced fold — panel rendering", () => {
	const originalProtocol = TERMINAL.imageProtocol;

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		// Two appearance rows are conditional; satisfy both so the tab renders its whole
		// inventory and the fold counts below are about the fold rather than about a
		// condition. `terminal.showImages` needs an image protocol, and `statusLine.preset`
		// plus `statusLine.compactThinkingLevel` need the composer footline switched on
		// (it ships off, and a preset for a row that is not on screen is hidden).
		terminal.imageProtocol = ImageProtocol.Kitty;
		await Settings.instance.set("statusLine.enabled", true);
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
		expect(rendered).not.toContain("Session Accent");
		expect(rendered).not.toContain("Tight Layout");
		expect(rendered).not.toContain("Render Mermaid Diagrams");
	});

	it("expands the Advanced fold on Enter to reveal the demoted rows, keeping the count stable", () => {
		const comp = createSelector();
		// The kept rows precede the Advanced toggle in tab order; that many Down presses lands
		// selection on the toggle row itself.
		for (let i = 0; i < KEPT_APPEARANCE_PATHS.length; i++) comp.handleInput("\x1b[B");
		comp.handleInput("\n");

		const rendered = comp.render(FLAT_WIDTH).join("\n");
		expect(rendered).toContain(`Advanced (${ADVANCED_COUNT})`);
		// A kept row still paints above the open fold: expanding adds rows rather than replacing
		// the list. It is the LAST kept row rather than an early one, because the viewport follows
		// the selection and the rows at the top of the tab have scrolled out by now.
		expect(rendered).toContain("Show Token Usage");
		expect(rendered).toContain("Render Mermaid Diagrams");
		expect(rendered).toContain("Session Accent");
		// Demoted rows below the floating viewport are reachable by scroll; the
		// fold is open when the early advanced rows paint under the toggle.
		// (The sticky "Theme" header pinned above — its own section scrolled
		// out of view — costs one row of the visible window.)
		expect(rendered).toContain(`▾ Advanced (${ADVANCED_COUNT})`);
		expect(rendered).toContain("Theme");
	});

	/**
	 * Advanced rows keep their schema group in the visible heading, otherwise
	 * scrolling made Status Line settings look like members of Display.
	 */
	it("labels expanded advanced rows with their original group", () => {
		const comp = createSelector();
		for (let i = 0; i < KEPT_APPEARANCE_PATHS.length; i++) comp.handleInput("\x1b[B");
		comp.handleInput("\n");
		expect(comp.selectSetting("statusLine.sessionAccent")).toBe(true);

		const lines = comp.render(FLAT_WIDTH);
		const heading = lines.findIndex(line => line.includes("Advanced · Status Line"));
		const selected = lines.findIndex(line => line.includes("Session Accent"));

		expect(heading).toBeGreaterThanOrEqual(0);
		expect(selected).toBeGreaterThan(heading);
		expect(lines.slice(heading, selected + 1).join("\n")).not.toContain("◆ Display");
	});

	it("surfaces a non-default advanced value even while the fold stays collapsed, without inflating the heading count", () => {
		// Session Accent defaults to on, so turning it off is the change worth
		// surfacing out of a collapsed fold.
		settings.set("statusLine.sessionAccent", false);
		const comp = createSelector();
		const rendered = comp.render(FLAT_WIDTH).join("\n");

		// Changed value is surfaced...
		expect(rendered).toContain("Session Accent");
		// ...but the heading count still reflects every advanced def, and
		// other (still-default) advanced rows stay hidden.
		expect(rendered).toContain(`Advanced (${ADVANCED_COUNT})`);
		expect(rendered).not.toContain("Tight Layout");
		expect(rendered).not.toContain("Render Mermaid Diagrams");
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
		for (const ch of "accent") comp.handleInput(ch);

		const rendered = comp.render(120).join("\n");
		expect(rendered).toContain("Session Accent");
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

	it("pre-selects the footline toggle when opened via /statusline", () => {
		const comp = createSelector("statusLine.enabled");
		expect(comp.getSelectedSettingId()).toBe("statusLine.enabled");
		// Cursor row renders the Status Line group's toggle item, not the default Theme item.
		comp.render(70);
	});

	/**
	 * A jump to a row a condition is hiding falls back to the tab's default rather than selecting
	 * something invisible. `statusLine.preset` is exactly that row while the footline is off, which
	 * is why `/statusline` names the toggle instead.
	 */
	it("falls back to the default selection for a row a condition hides", () => {
		const comp = createSelector("statusLine.preset");
		expect(comp.getSelectedSettingId()).toBe("theme.dark");
	});

	it("falls back to the default selection for an unknown initial item id", () => {
		const comp = createSelector("no.such.setting");
		expect(comp.getSelectedSettingId()).toBe("theme.dark");
	});
});

describe("appearance advanced fold — persistence", () => {
	it("round-trips a demoted setting through a config.yml overlay — demotion changes panel placement only, never persistence", async () => {
		const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-advanced-fold-roundtrip-"));
		const overlayPath = path.join(testDir, "overlay.yml");
		try {
			resetSettingsForTest();
			fs.writeFileSync(overlayPath, "statusLine:\n  transparent: true\n");

			const scoped = await Settings.init({ cwd: testDir, inMemory: true, configFiles: [overlayPath] });
			expect(scoped.get("statusLine.transparent")).toBe(true);
		} finally {
			resetSettingsForTest();
			if (fs.existsSync(testDir)) removeSyncWithRetries(testDir);
		}
	});
});

/**
 * The wizard's theme step picks a THEME, and its two modifiers compose with it.
 *
 * WHY THIS SUITE EXISTS. Found by dogfooding the shipped install. The curated
 * list presented "Colorblind colors" and "ANSI-safe" as rows among the themes,
 * and selecting either one FINISHED the scene: the config came out with
 * `colorBlindMode: true` and `theme.dark` left at whatever it already was, or
 * with `symbolPreset: ascii` and `theme.dark` forced to `dark-terminal`. Neither
 * is a theme choice. A user who wanted colourblind-safe colours on the LIGHT
 * theme, or ASCII glyphs on Titanium, could not say so at all, and a user who
 * picked a theme afterwards had their modifier silently reverted, because the
 * theme rows restored the ORIGINAL modifier state on commit.
 *
 * The two are now toggles that stay in the scene, and every commit writes both
 * of them alongside the theme. These tests drive the scene through its real
 * `handleInput` and assert the settings that come out, because the defect was
 * never in what the list looked like: it was in what selecting a row wrote.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { themeSetupScene } from "@veyyon/coding-agent/modes/setup-wizard/scenes/theme";
import type { SetupSceneController, SetupSceneResult } from "@veyyon/coding-agent/modes/setup-wizard/scenes/types";
import { initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";
import { visibleWidth } from "@veyyon/tui";
import { getProjectAgentDir, TempDir } from "@veyyon/utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../../helpers/settings-test-state";

const ENTER = "\r";
const WIDTH = 90;

/** Row order in the curated list, which the key drives below depend on. */
const ROW = { auto: 0, titanium: 1, light: 2, browse: 3, colorblind: 4, ascii: 5 } as const;

let settingsState: SettingsTestState | undefined;
let tempDir: TempDir;

beforeEach(async () => {
	await initTheme(false);
	settingsState = beginSettingsTest();
	tempDir = TempDir.createSync("@veyyon-theme-scene-");
	fs.mkdirSync(tempDir.join("agent"), { recursive: true });
	fs.mkdirSync(getProjectAgentDir(tempDir.join("project")), { recursive: true });
});

afterEach(async () => {
	restoreSettingsTestState(settingsState);
	await tempDir.remove();
});

interface Driven {
	controller: SetupSceneController;
	settings: Settings;
	finished: SetupSceneResult[];
	render(): string[];
	renderAt(width: number): string[];
}

/** Mount the real scene against a real `Settings` backed by a temp profile. */
async function mount(): Promise<Driven> {
	const settings = await Settings.init({ cwd: tempDir.join("project"), agentDir: tempDir.join("agent") });
	const finished: SetupSceneResult[] = [];
	const controller = themeSetupScene.mount({
		ctx: { settings, ui: { invalidate: () => {} } } as never,
		requestRender: () => {},
		finish: result => finished.push(result),
		skipSetup: () => {},
		setFocus: () => {},
		restoreFocus: () => {},
	});
	return {
		controller,
		settings,
		finished,
		render: () => controller.render(WIDTH).map(line => Bun.stripANSI(line)),
		renderAt: width => controller.render(width).map(line => Bun.stripANSI(line)),
	};
}

/**
 * Put the cursor on `index` and press enter.
 *
 * The digit shortcut, not a run of arrows: the scene opens with the cursor on
 * whichever row matches the CURRENT theme, so counting keys from the top lands
 * somewhere else depending on what the profile already had.
 */
function chooseRow(controller: SetupSceneController, index: number): void {
	controller.handleInput?.(String(index + 1));
	controller.handleInput?.(ENTER);
}

/**
 * Settle the scene's async select/commit handlers, which are fire-and-forget.
 *
 * `onSelect` returns void and the work behind it reloads a theme from disk, so
 * a microtask drain is not enough: the assertions have to wait for real I/O.
 */
async function settle(): Promise<void> {
	for (let tick = 0; tick < 20; tick++) {
		await new Promise(resolve => setTimeout(resolve, 5));
	}
}

describe("The curated list", () => {
	/** Four themes and two toggles, in that order, with the toggles marked. */
	it("shows the themes first and the modifiers as marked toggles", async () => {
		const driven = await mount();
		const text = driven.render().join("\n");

		expect(text).toContain("Match terminal");
		expect(text).toContain("Titanium");
		expect(text).toContain("Light");
		expect(text).toContain("Browse all…");
		expect(text).toContain("Colorblind colors");
		expect(text).toContain("ASCII glyphs");
	});

	/**
	 * A toggle says what it currently is. That is what tells the reader it is not
	 * an alternative to a theme, and it is what the old rows could not say.
	 */
	it("marks both modifiers off on a fresh profile", async () => {
		const driven = await mount();
		const rows = driven.render().filter(line => line.includes("Colorblind colors") || line.includes("ASCII glyphs"));

		expect(rows).toHaveLength(2);
		// The theme's own glyph, not a literal: the ASCII preset draws `[x]` and
		// the unicode one `■`, and asserting one of them passes vacuously under
		// the other, which is how this read green while the toggle did nothing.
		for (const row of rows) expect(row).not.toContain(theme.checkbox.checked);
		for (const row of rows) expect(row).toContain(theme.checkbox.unchecked);
	});
});

describe("The toggle rows at every ordinary width", () => {
	/** The widths a wizard is realistically drawn at, narrow to wide. */
	const WIDTHS = [80, 90, 100, 120, 140];

	/**
	 * No row may be wider than the width it was asked for.
	 *
	 * The wizard has no scroll pane to clip an overlong row: whatever the scene
	 * returns is written to the terminal, so a row that overruns wraps and pushes
	 * every row under it down by one, which desynchronises the mouse hit-test the
	 * scene does from `#listRowStart`.
	 */
	it("never returns a row wider than the width it was rendered at", async () => {
		const driven = await mount();

		for (const width of WIDTHS) {
			const tooWide = driven.controller.render(width).filter(line => visibleWidth(line) > width);
			expect({ width, tooWide: tooWide.map(line => Bun.stripANSI(line)) }).toEqual({ width, tooWide: [] });
		}
	});

	/**
	 * A shown description is shown WHOLE.
	 *
	 * `SelectList` cuts a description that does not fit with `Ellipsis.Omit`, so
	 * an overlong one ends mid-word with nothing saying it was cut: "Applies to
	 * whichev". That is what these two rows did, and it is why their text is
	 * short. Below the column minimum the list drops the description instead of
	 * cutting it, which is also fine, so the contract is whole-or-absent.
	 */
	it("shows each modifier description whole or not at all", async () => {
		const driven = await mount();
		const descriptions = ["Red/green contrast, on any theme", "Plain ASCII box drawing and icons"];

		for (const width of WIDTHS) {
			const text = driven.renderAt(width).join("\n");
			for (const description of descriptions) {
				const cut = description.slice(0, description.lastIndexOf(" "));
				const shown = text.includes(description);
				expect({ width, description, shown, cutOnly: !shown && text.includes(cut) }).toEqual({
					width,
					description,
					shown,
					cutOnly: false,
				});
			}
		}
	});
});

describe("Selecting a modifier", () => {
	/** The exact regression: it must NOT finish the scene. */
	it("does not end the step", async () => {
		const driven = await mount();
		chooseRow(driven.controller, ROW.colorblind);
		await settle();

		expect(driven.finished).toEqual([]);
	});

	/** And nothing is written yet: the scene commits when a theme is picked. */
	it("writes nothing until a theme is chosen", async () => {
		const driven = await mount();
		chooseRow(driven.controller, ROW.colorblind);
		await settle();

		expect(driven.settings.get("colorBlindMode")).toBe(false);
	});

	/** The row's mark follows the toggle, so the list stays legible. */
	it("marks the row on and leaves the cursor on it", async () => {
		const driven = await mount();
		chooseRow(driven.controller, ROW.colorblind);
		await settle();
		const row = driven.render().find(line => line.includes("Colorblind colors"));

		expect(row).toContain(theme.checkbox.checked);
		expect(row).toContain(theme.nav.cursor);
	});

	/**
	 * The mark is drawn in the glyph set the ASCII toggle itself controls.
	 *
	 * Found in a render proof. With ASCII glyphs on, every glyph on screen became
	 * plain text, the status icons and the box drawing in the live preview
	 * included, and the two checkboxes stayed unicode `■`: the rows were built
	 * once, before the preset had been applied, and never rebuilt after it. The
	 * one glyph that did not follow the setting was the glyph reporting it.
	 */
	it("redraws its own mark in the glyph set the ascii toggle just turned on", async () => {
		const driven = await mount();
		chooseRow(driven.controller, ROW.ascii);
		await settle();
		const row = driven.render().find(line => line.includes("ASCII glyphs"));

		expect(theme.checkbox.checked).toBe("[x]");
		expect(row).toContain("[x]");
	});

	/** And back to the unicode mark when it is turned off again. */
	it("redraws its mark in unicode when the ascii toggle is turned back off", async () => {
		const driven = await mount();
		chooseRow(driven.controller, ROW.ascii);
		await settle();
		driven.controller.handleInput?.(ENTER);
		await settle();
		const row = driven.render().find(line => line.includes("ASCII glyphs"));

		expect(theme.checkbox.unchecked).toBe("□");
		expect(row).toContain("□");
	});

	/** Selecting it again turns it back off: it is a toggle, not a latch. */
	it("turns back off when selected twice", async () => {
		const driven = await mount();
		chooseRow(driven.controller, ROW.colorblind);
		await settle();
		driven.controller.handleInput?.(ENTER);
		await settle();
		const row = driven.render().find(line => line.includes("Colorblind colors"));

		expect(row).toContain(theme.checkbox.unchecked);
		expect(row).not.toContain(theme.checkbox.checked);
	});
});

describe("Committing a theme", () => {
	/**
	 * The combination the old list made impossible: a colourblind-safe LIGHT
	 * theme. The modifier is flipped, then a theme is chosen, and both survive.
	 */
	it("writes the colorblind modifier together with the light theme", async () => {
		const driven = await mount();
		chooseRow(driven.controller, ROW.colorblind);
		await settle();
		chooseRow(driven.controller, ROW.light);
		await settle();

		expect(driven.finished).toEqual(["done"]);
		expect(driven.settings.get("theme.light")).toBe("light");
		expect(driven.settings.get("colorBlindMode")).toBe(true);
	});

	/**
	 * ASCII glyphs no longer drag a theme along. `dark-terminal` was forced by
	 * the old ANSI-safe row, which is why choosing it meant giving up Titanium.
	 */
	it("writes the ascii preset together with Titanium, not with dark-terminal", async () => {
		const driven = await mount();
		chooseRow(driven.controller, ROW.ascii);
		await settle();
		chooseRow(driven.controller, ROW.titanium);
		await settle();

		expect(driven.finished).toEqual(["done"]);
		expect(driven.settings.get("symbolPreset")).toBe("ascii");
		expect(driven.settings.get("theme.dark")).toBe("titanium");
	});

	/** Both modifiers at once, which is two independent toggles by construction. */
	it("writes both modifiers together with a theme", async () => {
		const driven = await mount();
		chooseRow(driven.controller, ROW.colorblind);
		await settle();
		chooseRow(driven.controller, ROW.ascii);
		await settle();
		chooseRow(driven.controller, ROW.titanium);
		await settle();

		expect(driven.settings.get("colorBlindMode")).toBe(true);
		expect(driven.settings.get("symbolPreset")).toBe("ascii");
		expect(driven.settings.get("theme.dark")).toBe("titanium");
	});

	/**
	 * A theme chosen with no modifier touched writes them off rather than leaving
	 * them unstated, so the config says what the wizard showed.
	 */
	it("writes both modifiers off when neither was toggled", async () => {
		const driven = await mount();
		chooseRow(driven.controller, ROW.titanium);
		await settle();

		expect(driven.settings.get("colorBlindMode")).toBe(false);
		expect(driven.settings.get("symbolPreset")).not.toBe("ascii");
		expect(driven.settings.get("theme.dark")).toBe("titanium");
	});

	/** Match terminal sets both ends of the pair and keeps the modifiers. */
	it("writes both ends of the pair for Match terminal, with the modifiers", async () => {
		const driven = await mount();
		chooseRow(driven.controller, ROW.colorblind);
		await settle();
		chooseRow(driven.controller, ROW.auto);
		await settle();

		expect(driven.settings.get("theme.dark")).toBe("titanium");
		expect(driven.settings.get("theme.light")).toBe("light");
		expect(driven.settings.get("colorBlindMode")).toBe(true);
	});
});

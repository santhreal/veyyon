// WHY THIS SUITE EXISTS.
//
// The live status row replaces its settings wholesale on every `updateSettings`, and each site that
// called it built the object by hand from the settings store, listing the keys it remembered. The
// settings card's two sites, the preview it paints after an appearance flip and the restore it runs
// on close, left out `statusLine.segmentOptions`. Opening /settings and pressing Escape, or flipping
// any appearance toggle, reset every configured segment option (the clock's 12h format, the path's
// display roots, the git branch toggle) to the preset's until an unrelated resync.
//
// The class this closes: a route through the settings card that hands the row a status-line
// settings object short of the configured one. Each route is driven through the real controller,
// and the row left behind is compared whole against the row the configuration resolves to, so a
// field added to `statusLineSettingsFromConfig` is covered with no line here. The effect sweep is
// enumerated from the schema, so a new `statusLine.*` setting with an effect joins it on arrival.
//
// WHAT IT DOES NOT CATCH: a status-line setting `statusLineSettingsFromConfig` itself does not read,
// an effect outside the `statusLine.*` namespace that redraws the row (`git.enabled`), and the
// interactive mode's own resync, which no route here reaches.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@veyyon/coding-agent/config/settings";
import { settingsSchemaPaths } from "@veyyon/coding-agent/config/settings-schema";
import type { SettingsSelectorComponent } from "@veyyon/coding-agent/modes/terminal/components/selectors/settings-selector";
import { StatusLineComponent } from "@veyyon/coding-agent/modes/terminal/components/status-line/component";
import { getPreset } from "@veyyon/coding-agent/modes/terminal/components/status-line/presets";
import {
	effectiveStatusLineSettings,
	statusLineSettingsFromConfig,
} from "@veyyon/coding-agent/modes/terminal/components/status-line/quiet-row";
import type { EffectiveStatusLineSettings } from "@veyyon/coding-agent/modes/terminal/components/status-line/types";
import { SelectorController } from "@veyyon/coding-agent/modes/terminal/controllers/selector-controller";
import { settingEffect } from "@veyyon/coding-agent/modes/terminal/controllers/setting-effects";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/terminal/types";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { makeStatusLineProducer } from "../../../helpers/status-line-session";
import { type StubbedStdoutGeometry, stubStdoutGeometry } from "../../../helpers/stdout-geometry";

const WIDTH = 160;

/** The configured segment options, away from every preset's, so a route that drops them shows. */
const TIME_OPTIONS = { format: "12h", showSeconds: true } as const;

let geometry: StubbedStdoutGeometry | undefined;

interface Host {
	controller: SelectorController;
	statusLine: StatusLineComponent;
	/** The card the controller shows, once it has built it. */
	card: Promise<SettingsSelectorComponent>;
	closed: () => boolean;
}

/** The real controller and the real row, with only the host's paint calls reduced to no-ops. */
function makeHost(): Host {
	const statusLine = new StatusLineComponent(makeStatusLineProducer());
	statusLine.updateSettings(statusLineSettingsFromConfig());
	let hidden = false;
	const shown = Promise.withResolvers<SettingsSelectorComponent>();
	const noop = (): void => {};
	const ctx = {
		ui: {
			showOverlay: (component: SettingsSelectorComponent) => {
				shown.resolve(component);
				return {
					hide: () => {
						hidden = true;
					},
				};
			},
			setFocus: noop,
			requestRender: noop,
			invalidate: noop,
			imageBudget: undefined,
			terminal: { columns: WIDTH },
		},
		session: {
			getAvailableThinkingLevels: () => [],
			thinkingLevel: undefined,
			getAvailableModels: () => [],
			model: undefined,
			modelRegistry: undefined,
		},
		statusLine,
		editorContainer: { children: [{}] },
		editor: { getTopBorderAvailableWidth: () => WIDTH },
		showWarning: noop,
		showError: noop,
	};
	const controller = new SelectorController(ctx as unknown as InteractiveModeContext);
	return { controller, statusLine, card: shown.promise, closed: () => hidden };
}

async function openSettings(): Promise<Host & { opened: SettingsSelectorComponent }> {
	const host = makeHost();
	host.controller.showSettingsSelector();
	const opened = await host.card;
	opened.render(WIDTH);
	return { ...host, opened };
}

function type(card: SettingsSelectorComponent, text: string): void {
	for (const char of text) card.handleInput(char);
}

/** The row the live status line lays out, and the one the configuration resolves to. */
function rows(statusLine: StatusLineComponent): {
	live: EffectiveStatusLineSettings;
	configured: EffectiveStatusLineSettings;
} {
	return {
		live: statusLine.getEffectiveSettingsForTest(),
		configured: effectiveStatusLineSettings(statusLineSettingsFromConfig()),
	};
}

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme(false);
	geometry = stubStdoutGeometry({ columns: WIDTH, rows: 40 });
	// Every status-line field away from its default, so a route that drops one leaves a row that
	// differs from the configured one.
	settings.set("statusLine.segmentOptions", { time: TIME_OPTIONS });
	settings.set("statusLine.compactThinkingLevel", true);
	settings.set("statusLine.showHookStatus", false);
});

afterEach(() => {
	geometry?.restore();
	geometry = undefined;
	resetSettingsForTest();
});

describe("the status row keeps its configured settings through the settings card", () => {
	it("keeps them when the card closes on Escape", async () => {
		const { opened, statusLine, closed } = await openSettings();

		opened.handleInput("\x1b");

		expect(closed()).toBe(true);
		const { live, configured } = rows(statusLine);
		expect(live.segmentOptions.time).toEqual(TIME_OPTIONS);
		expect(live).toEqual(configured);
	});

	it("keeps them when an appearance toggle flips inline, and after the card closes", async () => {
		const { opened, statusLine, closed } = await openSettings();

		type(opened, "session accent");
		opened.handleInput("\r");

		expect(settings.get("statusLine.sessionAccent")).toBe(false);
		const flipped = rows(statusLine);
		expect(flipped.live.sessionAccent).toBe(false);
		expect(flipped.live.segmentOptions.time).toEqual(TIME_OPTIONS);
		expect(flipped.live).toEqual(flipped.configured);

		opened.handleInput("\x1b");
		opened.handleInput("\x1b");

		expect(closed()).toBe(true);
		const { live, configured } = rows(statusLine);
		expect(live).toEqual(configured);
	});

	it("shows a hovered preset over the configured settings, and restores them when the menu closes", async () => {
		const { opened, statusLine, closed } = await openSettings();

		type(opened, "status line preset");
		opened.handleInput("\r");
		opened.handleInput("\x1b[B");

		// The preview names the preset and its segment lists; every other field is the configured one.
		const previewed = statusLine.getEffectiveSettingsForTest();
		expect(previewed.preset).toBe("minimal");
		expect(previewed.leftSegments).toEqual(getPreset("minimal").leftSegments);
		expect(previewed.segmentOptions.time).toMatchObject(TIME_OPTIONS);
		expect(previewed.compactThinkingLevel).toBe(true);
		expect(previewed.showHookStatus).toBe(false);

		opened.handleInput("\x1b");
		expect(statusLine.getEffectiveSettingsForTest().preset).toBe("default");
		opened.handleInput("\x1b");
		opened.handleInput("\x1b");

		expect(closed()).toBe(true);
		const { live, configured } = rows(statusLine);
		expect(live).toEqual(configured);
	});

	it("keeps them when a status-line setting's own effect redraws the row", async () => {
		const { controller, statusLine } = makeHost();
		const redrawing = settingsSchemaPaths().filter(
			path => path.startsWith("statusLine.") && settingEffect(path) !== undefined,
		);
		// Non-vacuity: the sweep reads the schema and the effect table, and an empty result would pass.
		expect(redrawing.length).toBeGreaterThanOrEqual(5);

		for (const path of redrawing) {
			// Start each flip from a row that holds nothing configured, so an effect that redraws it
			// short, or does not redraw it at all, leaves a row that differs from the configured one.
			statusLine.updateSettings({});
			await controller.handleSettingChange(path, settings.get(path));
			const { live, configured } = rows(statusLine);
			expect(live, path).toEqual(configured);
		}
	});
});

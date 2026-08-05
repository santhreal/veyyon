/**
 * "NOTHING SAVES UNTIL YOU CONFIRM" HAS TO BE TRUE OF THE SCREEN TOO.
 *
 * The theme and glyph steps preview live: moving the highlight repaints the
 * whole running UI in the candidate theme or glyph preset, which is the point,
 * because you judge a theme by looking at it. Nothing is written to config
 * until Enter, and the theme step's subtitle says so.
 *
 * What was NOT true is the other half. Every way out of those steps — Esc, the
 * `→` skip, the `←` back, ctrl+c, the wizard being disposed — left the
 * last-hovered theme and glyph preset applied for the rest of the session. A
 * user who arrowed past ASCII and skipped the step ran in ASCII while
 * `symbolPreset` in their config still said otherwise, so `/settings`
 * disagreed with the screen and nothing on either explained why.
 *
 * The theme step even had the restore written (`#restorePreview`), reachable
 * only from a `SelectList.onCancel` the wizard intercepts before the list can
 * ever see the key. In the shipped wizard it never ran once.
 *
 * WHAT IS PINNED: the exact rendered bytes of the theme's accent colour, and
 * the symbol preset, before the preview, after it, and after the step ends
 * without a confirmation. The middle assertion is what stops this suite from
 * passing on a preview that never happened.
 */
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { glyphSetupScene } from "@veyyon/coding-agent/modes/setup-wizard/scenes/glyph";
import { themeSetupScene } from "@veyyon/coding-agent/modes/setup-wizard/scenes/theme";
import type {
	SetupSceneController,
	SetupSceneHost,
	SetupWizardContext,
} from "@veyyon/coding-agent/modes/setup-wizard/scenes/types";
import {
	getCurrentThemeName,
	initTheme,
	previewTheme,
	type SymbolPreset,
	setSymbolPreset,
	theme,
} from "@veyyon/coding-agent/modes/theme/theme";
import { useTempHome } from "./helpers/temp-home";

useTempHome();

/**
 * The active theme and glyph preset are PROCESS state, and the confirm cases
 * below deliberately change them. Put back exactly what the file inherited, or
 * a later suite in the same process renders in a theme it never asked for.
 */
let baselineTheme: string | undefined;
let baselinePreset: SymbolPreset;

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	await initTheme(false);
	baselineTheme = getCurrentThemeName();
	baselinePreset = theme.getSymbolPreset();
});

afterEach(async () => {
	await setSymbolPreset(baselinePreset);
	if (baselineTheme) await previewTheme(baselineTheme);
});

interface SceneHarness {
	host: SetupSceneHost;
	/** Resolves on the next repaint the scene asks for, which is what a landed preview does. */
	nextPaint(): Promise<void>;
	/** Resolves when the scene reports the step complete, which a commit does. */
	nextFinish(): Promise<string>;
	finished: string[];
}

function makeHarness(): SceneHarness {
	const finished: string[] = [];
	let paint: PromiseWithResolvers<void> | undefined;
	let done: PromiseWithResolvers<string> | undefined;
	const ctx = {
		settings: Settings.isolated(),
		session: { modelRegistry: { authStorage: { hasAuth: () => false, has: () => false }, getAvailable: () => [] } },
		openInBrowser: () => {},
		showError: () => {},
		ui: { terminal: { rows: 30 }, setFocus: () => {}, requestRender: () => {}, invalidate: () => {} },
	} as unknown as SetupWizardContext;
	return {
		finished,
		nextPaint: () => {
			paint = Promise.withResolvers<void>();
			return paint.promise;
		},
		nextFinish: () => {
			done = Promise.withResolvers<string>();
			return done.promise;
		},
		host: {
			ctx,
			requestRender: () => paint?.resolve(),
			finish: result => {
				finished.push(result);
				done?.resolve(result);
			},
			skipSetup: () => finished.push("skipped-setup"),
			setFocus: () => {},
			restoreFocus: () => {},
		},
	};
}

describe("the theme step hands its preview back when it ends without a choice", () => {
	/**
	 * `onUnmount` is the hook every exit passes through, so the assertion is on
	 * it rather than on one key: Esc, `→`, `←` and a disposed wizard all reach
	 * the same place, and pinning one key would leave the other three open.
	 */
	it("restores the exact accent bytes the step started with", async () => {
		const original = theme.getFgAnsi("accent");
		const harness = makeHarness();
		const scene: SetupSceneController = themeSetupScene.mount(harness.host);
		scene.render(76, 20);

		const painted = harness.nextPaint();
		scene.handleInput?.("3"); // the "Light" row
		await painted;
		const previewed = theme.getFgAnsi("accent");
		expect(previewed).not.toBe(original);

		await scene.onUnmount?.();
		expect(theme.getFgAnsi("accent")).toBe(original);
		scene.dispose?.();
	});

	/**
	 * A confirmed choice is not a preview, and the restore must not undo it. The
	 * two share one flag, so this is the case that would break if the flag were
	 * set in the wrong place.
	 */
	it("keeps a confirmed theme through the unmount that follows it", async () => {
		const original = theme.getFgAnsi("accent");
		const harness = makeHarness();
		const scene: SetupSceneController = themeSetupScene.mount(harness.host);
		scene.render(76, 20);

		const painted = harness.nextPaint();
		scene.handleInput?.("3");
		await painted;
		const chosen = theme.getFgAnsi("accent");
		expect(chosen).not.toBe(original);

		const committed = harness.nextFinish();
		scene.handleInput?.("\r"); // Enter: confirm the highlighted row
		expect(await committed).toBe("done");
		await scene.onUnmount?.();
		expect(theme.getFgAnsi("accent")).toBe(chosen);
		scene.dispose?.();
	});
});

describe("the glyph step hands its preview back when it ends without a choice", () => {
	it("restores the preset the step started with", async () => {
		const original = theme.getSymbolPreset();
		const harness = makeHarness();
		const scene: SetupSceneController = glyphSetupScene.mount(harness.host);
		scene.render(76, 20);

		// Whichever preset is not the current one, so the preview is a real change.
		const key = original === "ascii" ? "2" : "3";
		const painted = harness.nextPaint();
		scene.handleInput?.(key);
		await painted;
		expect(theme.getSymbolPreset()).not.toBe(original);

		await scene.onUnmount?.();
		expect(theme.getSymbolPreset()).toBe(original);
		scene.dispose?.();
	});

	it("keeps a confirmed preset through the unmount that follows it", async () => {
		const original = theme.getSymbolPreset();
		const harness = makeHarness();
		const scene: SetupSceneController = glyphSetupScene.mount(harness.host);
		scene.render(76, 20);

		const key = original === "ascii" ? "2" : "3";
		const painted = harness.nextPaint();
		scene.handleInput?.(key);
		await painted;
		const chosen = theme.getSymbolPreset();
		expect(chosen).not.toBe(original);

		const committed = harness.nextFinish();
		scene.handleInput?.("\r");
		expect(await committed).toBe("done");
		await scene.onUnmount?.();
		expect(theme.getSymbolPreset()).toBe(chosen);
		scene.dispose?.();
	});
});

import type { Settings } from "../../config/settings";
import { CURRENT_SETUP_VERSION } from "../setup-version";
import { glyphSetupScene } from "./scenes/glyph";
import { importSetupScene } from "./scenes/import";
import { providersSetupScene } from "./scenes/providers";
import { themeSetupScene } from "./scenes/theme";
import type { SetupScene, SetupWizardContext } from "./scenes/types";
import { SetupWizardComponent } from "./wizard-overlay";

export type { SetupScene, SetupSceneController, SetupSceneHost, SetupSceneResult } from "./scenes/types";

export { runStartupSplash } from "./startup-splash";
export { CURRENT_SETUP_VERSION };

export const ALL_SCENES = [
	providersSetupScene,
	glyphSetupScene,
	themeSetupScene,
	importSetupScene,
] as const satisfies readonly SetupScene[];

export interface SetupSceneSelectionOptions {
	resuming?: boolean;
	isTTY?: boolean;
	skipEnv?: string;
	setupWizardEnabled?: boolean;
	force?: boolean;
	/**
	 * The current onboarding generation. Defaults to
	 * {@link CURRENT_SETUP_VERSION} (a fixed integer); injectable so tests can
	 * exercise the generic gate at an arbitrary generation.
	 */
	currentVersion?: number;
}

function setupSkipEnvEnabled(value: string | undefined): boolean {
	if (value === undefined) return false;
	const normalized = value.trim().toLowerCase();
	return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no";
}

/**
 * Scenes to run for onboarding, or `[]` to skip it.
 *
 * Onboarding runs in full (every eligible scene) only on a FIRST install, where
 * the stored generation (default 0) is behind the current one
 * ({@link CURRENT_SETUP_VERSION}, a fixed integer). Once a user has onboarded,
 * their stored generation is at or above the current one, so every later launch —
 * including after any update, patch/minor/major — runs nothing. `minVersion` is a
 * per-scene floor (the generation a scene was introduced in), so a scene staged
 * for a future generation stays hidden until the gate advances to it. `force`
 * (the `veyyon setup` command) ignores the generation gate but still requires a
 * TTY.
 */
export async function selectSetupScenes(
	storedVersion: number,
	scenes: readonly SetupScene[],
	ctx?: SetupWizardContext,
	options: SetupSceneSelectionOptions = {},
): Promise<SetupScene[]> {
	const isTTY = options.isTTY ?? (process.stdin.isTTY && process.stdout.isTTY);
	if (!isTTY) return [];
	const currentVersion = options.currentVersion ?? CURRENT_SETUP_VERSION;
	if (!options.force) {
		if (options.resuming) return [];
		if (setupSkipEnvEnabled(options.skipEnv ?? Bun.env.VEYYON_SKIP_SETUP)) return [];
		if (options.setupWizardEnabled === false) return [];
		// Onboard only when the stored generation is behind the current one — i.e.
		// a first install. An onboarded user (stored >= current) never re-onboards,
		// and because the current generation is fixed, no update moves it.
		if (storedVersion >= currentVersion) return [];
	}

	const selected: SetupScene[] = [];
	for (const scene of scenes) {
		if (!options.force && scene.minVersion > currentVersion) continue;
		if (scene.shouldRun) {
			if (!ctx) continue;
			if (!(await scene.shouldRun(ctx))) continue;
		}
		selected.push(scene);
	}
	return selected;
}

export async function markSetupWizardComplete(
	settings: Settings,
	version: number = CURRENT_SETUP_VERSION,
): Promise<void> {
	settings.set("setupVersion", version);
	await settings.flush();
}

export interface RunSetupWizardOptions {
	markComplete?: boolean;
	playWelcomeIntro?: boolean;
}

export async function runSetupWizard(
	ctx: SetupWizardContext,
	scenes: readonly SetupScene[] = ALL_SCENES,
	options: RunSetupWizardOptions = {},
): Promise<void> {
	if (scenes.length === 0) return;
	const component = new SetupWizardComponent(ctx, scenes);
	const overlay = ctx.ui.showOverlay(component, {
		width: "100%",
		maxHeight: "100%",
		anchor: "top-left",
		margin: 0,
		fullscreen: true,
	});
	try {
		await component.run();
		if (options.markComplete !== false) {
			await markSetupWizardComplete(ctx.settings);
		}
	} finally {
		component.dispose();
		ctx.ui.setFocus(component);
		overlay.hide();
	}
	if (options.playWelcomeIntro !== false) {
		ctx.playWelcomeIntro();
	}
}

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
	 * The current onboarding generation (app major). Defaults to
	 * {@link CURRENT_SETUP_VERSION}; injectable so tests can simulate a major
	 * bump without rebuilding the app version.
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
 * Onboarding runs in full (every eligible scene) only when the stored generation
 * is behind the current app major — a fresh install (stored 0) or a MAJOR update
 * (1.x -> 2.0). A minor/patch update leaves `storedVersion === currentVersion`,
 * so nothing runs. `minVersion` is a per-scene floor: the app major the scene was
 * introduced in, so a scene staged for a future major stays hidden until then.
 * `force` (the `veyyon setup` command) ignores the generation gate but still
 * requires a TTY.
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
		// Onboard only when the stored generation is behind the current app major.
		// A minor/patch update (stored === current) never re-onboards.
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

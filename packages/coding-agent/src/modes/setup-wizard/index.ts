import type { Settings } from "../../config/settings";
import { CURRENT_SETUP_VERSION } from "../setup-version";
import { agentsSetupScene } from "./scenes/agents";
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
	agentsSetupScene,
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
	/**
	 * True when a settings file this session needed exists but could not be read
	 * or parsed. Skips onboarding: the stored generation fell back to the schema
	 * default 0, which is indistinguishable from a fresh install, so a corrupt
	 * config used to hand an onboarded user the full wizard. `force` still wins,
	 * because `veyyon setup` is the user asking for it outright.
	 */
	settingsUnreadable?: boolean;
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
 *
 * `storedVersion` is machine-wide and comes from `resolveOnboardingGeneration`,
 * whose `unreadable` flag belongs in `settingsUnreadable`: a config that could
 * not be parsed yields the same 0 a fresh install does, and onboarding a
 * long-running machine because its YAML broke is worse than skipping a wizard.
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
		if (options.settingsUnreadable) return [];
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

/**
 * Record that this machine has completed onboarding, and report whether it landed.
 *
 * Writes the machine-wide generation, which the global binding persists to
 * `~/.veyyon/config.yml` synchronously under its own file lock. The previous
 * write went to the per-profile store through the debounced save queue, so a
 * process that ended before the flush lost the fact entirely and the next launch
 * re-onboarded. Idempotent: a machine already at or past `version` is left alone.
 */
export function markSetupWizardComplete(settings: Settings, version: number = CURRENT_SETUP_VERSION): boolean {
	if (settings.get("onboardingVersion") >= version) return true;
	settings.set("onboardingVersion", version);
	// Read back rather than assume: `set` swallows a rejected global write (it
	// logs and returns), and a caller that treats a lost write as success has no
	// way to retry it.
	return settings.get("onboardingVersion") >= version;
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
	// Persisted BEFORE the run, not after it.
	//
	// The overlay is on screen by this line, so nobody who has not seen the wizard
	// is marked as having seen it. Everything after this line is an ending, and
	// the product rule is that a user who was SHOWN onboarding never gets it
	// again (`veyyon setup` re-runs it on demand). Marking completion only after
	// `run()` resolved made that rule depend on ONE ending: a throw out of `run()`,
	// a SIGINT or SIGTERM, or a closed terminal all left nothing on disk while the
	// `finally` still tore the overlay down, so the user who had just walked
	// through onboarding was walked through it again on the next launch.
	const persisted = options.markComplete === false || markSetupWizardComplete(ctx.settings);
	try {
		await component.run();
	} finally {
		// One retry for a write that did not land, so a transient lock or IO failure
		// at presentation time does not cost the user their completion.
		if (!persisted) markSetupWizardComplete(ctx.settings);
		component.dispose();
		ctx.ui.setFocus(component);
		overlay.hide();
	}
	if (options.playWelcomeIntro !== false) {
		ctx.playWelcomeIntro();
	}
}

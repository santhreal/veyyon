import type { Settings } from "../../config/settings";
import { CURRENT_SETUP_VERSION } from "../setup-version";
import { agentsSetupScene } from "./scenes/agents";
import { approvalsSetupScene } from "./scenes/approvals";
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
	// Before subagents and cosmetics: it is the one answer that changes what the
	// agent may do to the machine, and the one a user should not discover later.
	approvalsSetupScene,
	agentsSetupScene,
	glyphSetupScene,
	themeSetupScene,
	importSetupScene,
] as const satisfies readonly SetupScene[];

export interface SetupSceneSelectionOptions {
	/** True when this launch is restoring a session (`--continue`, `--resume`, `--fork`). Defers a re-onboard, never a FIRST install; see */
	resuming?: boolean;
	isTTY?: boolean;
	skipEnv?: string;
	setupWizardEnabled?: boolean;
	force?: boolean;
	/** The current onboarding generation. Defaults to {@link CURRENT_SETUP_VERSION} (a fixed integer); injectable so tests can */
	currentVersion?: number;
	/** True when a settings file this session needed exists but could not be read or parsed. Skips onboarding: the stored generation fell back to the schema */
	settingsUnreadable?: boolean;
}

function setupSkipEnvEnabled(value: string | undefined): boolean {
	if (value === undefined) return false;
	const normalized = value.trim().toLowerCase();
	return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no";
}

/** Scenes to run for onboarding, or `[]` to skip it. Onboarding runs in full (every eligible scene) only on a FIRST install, where */
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
		// Resuming defers a RE-onboard. It must never defer a first install. `resuming` used to skip onboarding outright, and nothing else on that
		if (options.resuming && storedVersion > 0) return [];
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

/** Record that this machine has completed onboarding, and report whether it landed. Writes the machine-wide generation, which the global binding persists to */
export function markSetupWizardComplete(settings: Settings, version: number = CURRENT_SETUP_VERSION): boolean {
	if (settings.get("onboardingVersion") >= version) return true;
	settings.set("onboardingVersion", version);
	// Read back rather than assume: `set` does not throw on a rejected global
	// write, and a caller that treats a lost write as success has no way to retry
	// it.
	return settings.get("onboardingVersion") >= version;
}

export interface RunSetupWizardOptions {
	markComplete?: boolean;
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
	// Persisted BEFORE the run, not after it. The overlay is on screen by this line, so nobody who has not seen the wizard
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
}

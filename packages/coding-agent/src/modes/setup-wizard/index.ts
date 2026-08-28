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
	approvalsSetupScene,
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
	currentVersion?: number;
	settingsUnreadable?: boolean;
}

function setupSkipEnvEnabled(value: string | undefined): boolean {
	if (value === undefined) return false;
	const normalized = value.trim().toLowerCase();
	return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "no";
}

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
		if (options.resuming && storedVersion > 0) return [];
		if (options.settingsUnreadable) return [];
		if (setupSkipEnvEnabled(options.skipEnv ?? Bun.env.VEYYON_SKIP_SETUP)) return [];
		if (options.setupWizardEnabled === false) return [];
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

export function markSetupWizardComplete(settings: Settings, version: number = CURRENT_SETUP_VERSION): boolean {
	if (settings.get("onboardingVersion") >= version) return true;
	settings.set("onboardingVersion", version);
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
	const persisted = options.markComplete === false || markSetupWizardComplete(ctx.settings);
	try {
		await component.run();
	} finally {
		if (!persisted) markSetupWizardComplete(ctx.settings);
		component.dispose();
		ctx.ui.setFocus(component);
		overlay.hide();
	}
}

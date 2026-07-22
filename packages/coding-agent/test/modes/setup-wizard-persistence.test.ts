import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { Settings } from "@veyyon/coding-agent/config/settings";
import {
	CURRENT_SETUP_VERSION,
	markSetupWizardComplete,
	selectSetupScenes,
} from "@veyyon/coding-agent/modes/setup-wizard";
import { ALL_SCENES } from "@veyyon/coding-agent/modes/setup-wizard/index";
import type { SetupScene } from "@veyyon/coding-agent/modes/setup-wizard/scenes/types";
import { getProjectAgentDir, TempDir } from "@veyyon/utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

// DOG-R2-11: the setup/welcome wizard was reported showing after EVERY update but
// NOT on first install. The chosen contract (semver): onboard on first install and
// re-onboard in full only after a MAJOR version bump; minor/patch updates run
// nothing. These tests lock that gate AND its persistence through the real profile
// store, so a regression that fails to persist `setupVersion` (re-onboarding every
// launch) or fails to onboard a fresh install is caught here. No prior test covered
// the setupVersion round-trip.

/** Minimal scenes for the gate: `selectSetupScenes` only reads `minVersion`/`shouldRun`/`id`. */
function scene(id: string, minVersion: number): SetupScene {
	return { id, title: id, minVersion } as unknown as SetupScene;
}
// Both ship in major 1 (floor 1); majors are simulated via the currentVersion option.
const SCENE_A = scene("scene-a", 1);
const SCENE_B = scene("scene-b", 1);

function ids(scenes: readonly SetupScene[]): string[] {
	return scenes.map(s => s.id);
}

describe("setup wizard version gate and persistence (DOG-R2-11)", () => {
	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-setup-wizard-persist-");
		agentDir = tempDir.join("agent");
		projectDir = tempDir.join("project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
	});

	afterEach(async () => {
		restoreSettingsTestState(settingsState);
		await tempDir.remove();
	});

	it("shows onboarding on a fresh install (stored setupVersion defaults to 0)", async () => {
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		expect(settings.get("setupVersion")).toBe(0);

		const selected = await selectSetupScenes(settings.get("setupVersion"), [SCENE_A, SCENE_B], undefined, {
			isTTY: true,
			currentVersion: 1,
		});
		// A fresh install (stored 0, behind major 1) runs every eligible scene.
		expect(ids(selected)).toEqual(["scene-a", "scene-b"]);
	});

	it("persists setupVersion so the next launch and a minor/patch update show nothing", async () => {
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		await markSetupWizardComplete(settings);
		expect(settings.get("setupVersion")).toBe(CURRENT_SETUP_VERSION);

		// The heart of the bug: a brand-new Settings instance reading the SAME
		// profile store on the next launch must see the advanced generation. If it
		// reads 0, the wizard re-fires every launch/update (the reported failure).
		const reloaded = await Settings.loadIsolated({ cwd: projectDir, agentDir });
		expect(reloaded.get("setupVersion")).toBe(CURRENT_SETUP_VERSION);

		// Same major (a minor/patch update leaves stored === current): nothing runs.
		const nextLaunch = await selectSetupScenes(reloaded.get("setupVersion"), [SCENE_A, SCENE_B], undefined, {
			isTTY: true,
			currentVersion: CURRENT_SETUP_VERSION,
		});
		expect(nextLaunch).toEqual([]);
	});

	it("on a MAJOR version bump, re-onboards in full (every eligible scene)", async () => {
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		await markSetupWizardComplete(settings); // stored == CURRENT_SETUP_VERSION (app major)

		const reloaded = await Settings.loadIsolated({ cwd: projectDir, agentDir });
		// The app advances one major past the stored generation: full onboarding,
		// not a delta — both scenes run again.
		const afterMajor = await selectSetupScenes(reloaded.get("setupVersion"), [SCENE_A, SCENE_B], undefined, {
			isTTY: true,
			currentVersion: CURRENT_SETUP_VERSION + 1,
		});
		expect(ids(afterMajor)).toEqual(["scene-a", "scene-b"]);
	});

	it("uses the real ALL_SCENES: onboarding non-empty when fresh, empty once completed", async () => {
		const fresh = await selectSetupScenes(0, ALL_SCENES, undefined, { isTTY: true });
		// providers/glyph/theme (minVersion 1) run without a ctx; import (minVersion
		// 2) needs ctx and is skipped here — the point is fresh install onboards.
		expect(fresh.length).toBeGreaterThan(0);

		const completed = await selectSetupScenes(CURRENT_SETUP_VERSION, ALL_SCENES, undefined, { isTTY: true });
		expect(completed).toEqual([]);
	});

	it("does not run the wizard in a non-TTY environment regardless of stored version", async () => {
		const selected = await selectSetupScenes(0, [SCENE_A, SCENE_B], undefined, { isTTY: false });
		expect(selected).toEqual([]);
	});
});

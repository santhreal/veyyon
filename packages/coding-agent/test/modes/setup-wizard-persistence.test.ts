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
// NOT on first install. The chosen contract: onboard on the FIRST install and
// NEVER again — no update, patch/minor/major, re-fires it. This is enforced by a
// FIXED onboarding generation (CURRENT_SETUP_VERSION) that the app version can't
// move, so an onboarded user's persisted generation never falls behind. These
// tests lock the gate AND its persistence through the real profile store, so a
// regression that fails to persist `setupVersion` (re-onboarding every launch), or
// that re-couples the gate to the app version (re-onboarding on an update), or that
// fails to onboard a fresh install, is caught here.

/** Minimal scenes for the gate: `selectSetupScenes` only reads `minVersion`/`shouldRun`/`id`. */
function scene(id: string, minVersion: number): SetupScene {
	return { id, title: id, minVersion } as unknown as SetupScene;
}
// Both ship in generation 1 (floor 1); the gate generation is injected via the
// currentVersion option so these tests don't depend on the shipped constant.
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
		// A fresh install (stored 0, behind generation 1) runs every eligible scene.
		expect(ids(selected)).toEqual(["scene-a", "scene-b"]);
	});

	it("persists setupVersion so the next launch shows nothing", async () => {
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		await markSetupWizardComplete(settings);
		expect(settings.get("setupVersion")).toBe(CURRENT_SETUP_VERSION);

		// The heart of the bug: a brand-new Settings instance reading the SAME
		// profile store on the next launch must see the persisted generation. If it
		// reads 0, the wizard re-fires every launch/update (the reported failure).
		const reloaded = await Settings.loadIsolated({ cwd: projectDir, agentDir });
		expect(reloaded.get("setupVersion")).toBe(CURRENT_SETUP_VERSION);

		// The onboarded generation is stored, so the very next launch runs nothing.
		const nextLaunch = await selectSetupScenes(reloaded.get("setupVersion"), [SCENE_A, SCENE_B], undefined, {
			isTTY: true,
			currentVersion: CURRENT_SETUP_VERSION,
		});
		expect(nextLaunch).toEqual([]);
	});

	it("never re-onboards an onboarded user, because the gate generation is fixed", async () => {
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		await markSetupWizardComplete(settings); // stored == CURRENT_SETUP_VERSION
		const reloaded = await Settings.loadIsolated({ cwd: projectDir, agentDir });

		// The production gate is CURRENT_SETUP_VERSION, a fixed integer the app
		// version can't advance. So no matter how many times the user updates, the
		// current generation stays equal to their stored generation and onboarding
		// stays empty — this is the first-install-only guarantee. Run the gate at the
		// real (unbumped) generation repeatedly to stand in for a series of updates.
		for (let update = 0; update < 3; update++) {
			const afterUpdate = await selectSetupScenes(reloaded.get("setupVersion"), [SCENE_A, SCENE_B], undefined, {
				isTTY: true,
				currentVersion: CURRENT_SETUP_VERSION,
			});
			expect(afterUpdate).toEqual([]);
		}
	});

	it("uses the real ALL_SCENES: onboarding non-empty when fresh, empty once completed", async () => {
		const fresh = await selectSetupScenes(0, ALL_SCENES, undefined, { isTTY: true });
		// The ctx-free scenes (providers/glyph/theme) run; scenes with a shouldRun
		// guard are skipped without a ctx — the point is a fresh install onboards.
		expect(fresh.length).toBeGreaterThan(0);

		const completed = await selectSetupScenes(CURRENT_SETUP_VERSION, ALL_SCENES, undefined, { isTTY: true });
		expect(completed).toEqual([]);
	});

	it("does not run the wizard in a non-TTY environment regardless of stored version", async () => {
		const selected = await selectSetupScenes(0, [SCENE_A, SCENE_B], undefined, { isTTY: false });
		expect(selected).toEqual([]);
	});
});

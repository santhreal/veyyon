import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { resolveOnboardingGeneration } from "@veyyon/coding-agent/modes/setup-version";
import {
	CURRENT_SETUP_VERSION,
	markSetupWizardComplete,
	selectSetupScenes,
} from "@veyyon/coding-agent/modes/setup-wizard";
import { ALL_SCENES } from "@veyyon/coding-agent/modes/setup-wizard/index";
import type { SetupScene } from "@veyyon/coding-agent/modes/setup-wizard/scenes/types";
import { getProjectAgentDir, TempDir } from "@veyyon/utils";
import { enterIsolatedConfigRoot, type IsolatedConfigRoot } from "../../../utils/test/helpers/isolated-config-root";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

// DOG-R2-11: the setup/welcome wizard was reported showing after EVERY update but
// NOT on first install. The chosen contract: onboard on the FIRST install and
// NEVER again — no update, patch/minor/major, re-fires it. This is enforced by a
// FIXED onboarding generation (CURRENT_SETUP_VERSION) that the app version can't
// move, so an onboarded user's persisted generation never falls behind. These
// tests lock the gate AND its persistence through the real config files, so a
// regression that fails to persist the generation (re-onboarding every launch), or
// that re-couples the gate to the app version (re-onboarding on an update), or that
// fails to onboard a fresh install, is caught here.
//
// The config ROOT is isolated because completion now persists to the machine-wide
// `~/.veyyon/config.yml`. Without it these tests would write onboarding state into
// the developer's real config.

// `selectSetupScenes` only reads `minVersion`/`shouldRun`/`id`, and both scenes ship
// in generation 1 (floor 1). The gate generation is injected via the currentVersion
// option so these tests don't depend on the shipped constant.
const SCENE_A = { id: "scene-a", title: "scene-a", minVersion: 1 } as unknown as SetupScene;
const SCENE_B = { id: "scene-b", title: "scene-b", minVersion: 1 } as unknown as SetupScene;

describe("setup wizard version gate and persistence (DOG-R2-11)", () => {
	let settingsState: SettingsTestState | undefined;
	let isolated: IsolatedConfigRoot | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		settingsState = beginSettingsTest();
		isolated = enterIsolatedConfigRoot("setup-wizard-persistence");
		tempDir = TempDir.createSync("@pi-setup-wizard-persist-");
		agentDir = tempDir.join("agent");
		projectDir = tempDir.join("project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
	});

	afterEach(async () => {
		isolated?.restore();
		isolated = undefined;
		restoreSettingsTestState(settingsState);
		await tempDir.remove();
	});

	it("shows onboarding on a fresh install (nothing stored in either scope)", async () => {
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		const onboarding = resolveOnboardingGeneration(settings);
		expect(onboarding).toEqual({ version: 0, unreadable: false });

		const selected = await selectSetupScenes(onboarding.version, [SCENE_A, SCENE_B], undefined, {
			isTTY: true,
			currentVersion: 1,
			settingsUnreadable: onboarding.unreadable,
		});
		// A fresh install (stored 0, behind generation 1) runs every eligible scene.
		expect(selected.map(scene => scene.id)).toEqual(["scene-a", "scene-b"]);
	});

	it("persists the generation so the next launch shows nothing", async () => {
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		expect(markSetupWizardComplete(settings)).toBe(true);
		expect(settings.get("onboardingVersion")).toBe(CURRENT_SETUP_VERSION);

		// The heart of the bug: a brand-new Settings instance on the next launch must
		// see the persisted generation. If it reads 0, the wizard re-fires every
		// launch/update (the reported failure).
		const reloaded = await Settings.loadIsolated({ cwd: projectDir, agentDir });
		expect(resolveOnboardingGeneration(reloaded)).toEqual({
			version: CURRENT_SETUP_VERSION,
			unreadable: false,
		});

		// The onboarded generation is stored, so the very next launch runs nothing.
		const nextLaunch = await selectSetupScenes(CURRENT_SETUP_VERSION, [SCENE_A, SCENE_B], undefined, {
			isTTY: true,
			currentVersion: CURRENT_SETUP_VERSION,
		});
		expect(nextLaunch).toEqual([]);
	});

	it("never re-onboards an onboarded user, because the gate generation is fixed", async () => {
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		markSetupWizardComplete(settings); // stored == CURRENT_SETUP_VERSION
		const reloaded = await Settings.loadIsolated({ cwd: projectDir, agentDir });

		// The production gate is CURRENT_SETUP_VERSION, a fixed integer the app
		// version can't advance. So no matter how many times the user updates, the
		// current generation stays equal to their stored generation and onboarding
		// stays empty — this is the first-install-only guarantee. Run the gate at the
		// real (unbumped) generation repeatedly to stand in for a series of updates.
		for (let update = 0; update < 3; update++) {
			const onboarding = resolveOnboardingGeneration(reloaded);
			expect(onboarding.version).toBe(CURRENT_SETUP_VERSION);
			const afterUpdate = await selectSetupScenes(onboarding.version, [SCENE_A, SCENE_B], undefined, {
				isTTY: true,
				currentVersion: CURRENT_SETUP_VERSION,
				settingsUnreadable: onboarding.unreadable,
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

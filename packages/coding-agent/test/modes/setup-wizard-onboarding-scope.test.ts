import { afterEach, beforeEach, describe, expect, it, mock, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { resolveOnboardingGeneration } from "@veyyon/coding-agent/modes/setup-version";
import {
	ALL_SCENES,
	CURRENT_SETUP_VERSION,
	markSetupWizardComplete,
	runSetupWizard,
	type SetupScene,
	selectSetupScenes,
} from "@veyyon/coding-agent/modes/setup-wizard";
import { SetupWizardComponent } from "@veyyon/coding-agent/modes/setup-wizard/wizard-overlay";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/types";
import { getAgentDir, getGlobalConfigRootDir, setProfile, TempDir } from "@veyyon/utils";
import { isRecord } from "@veyyon/utils/type-guards";
import { YAML } from "bun";
import { enterIsolatedConfigRoot, type IsolatedConfigRoot } from "../../../utils/test/helpers/isolated-config-root";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

/**
 * The onboarding wizard reappearing for people who had already finished it.
 *
 * Three independent causes, each of which alone was enough to re-onboard a
 * completed install, and each pinned by its own case below:
 *
 *  1. SCOPE. Completion was written to the ACTIVE PROFILE's `agent/config.yml`.
 *     A different `--profile` reads a different file, finds nothing, and gets
 *     the schema default 0, which the gate cannot tell from a fresh install.
 *  2. NON-COMPLETING EXITS. Completion was written only after `component.run()`
 *     resolved, so a throw out of the run, or the process ending first, left
 *     nothing on disk while the user had plainly just been through onboarding.
 *  3. DEFAULT ON READ FAILURE. A settings file that exists but cannot be parsed
 *     also produces 0, so a broken config re-ran the wizard rather than saying
 *     the value was unknown.
 *
 * Every case drives the real gate: `resolveOnboardingGeneration` for the stored
 * state and `selectSetupScenes` for the decision, with the concrete value read
 * back out of the config file on disk.
 */

/**
 * A config file's top-level keys, or `{}` when it is absent or not a mapping.
 *
 * `isRecord` rather than a cast: this reads a file the code under test wrote, and
 * an assertion would report a passing shape whatever the writer actually produced.
 */
function configRecord(filePath: string): Record<string, unknown> {
	if (!fs.existsSync(filePath)) return {};
	const parsed: unknown = YAML.parse(fs.readFileSync(filePath, "utf8"));
	return isRecord(parsed) ? parsed : {};
}

describe("onboarding runs once per machine", () => {
	let settingsState: SettingsTestState | undefined;
	let isolated: IsolatedConfigRoot | undefined;
	let tempDir: TempDir;
	let projectDir: string;
	let otherProjectDir: string;
	/** `~/.veyyon/config.yml` for this test, inside the isolated root. */
	let globalConfigPath: string;

	beforeEach(() => {
		settingsState = beginSettingsTest();
		isolated = enterIsolatedConfigRoot("onboarding-scope", { defaultProfile: true });
		globalConfigPath = path.join(getGlobalConfigRootDir(), "config.yml");
		tempDir = TempDir.createSync("@pi-onboarding-scope-");
		projectDir = tempDir.join("project");
		otherProjectDir = tempDir.join("other-project");
		fs.mkdirSync(projectDir, { recursive: true });
		fs.mkdirSync(otherProjectDir, { recursive: true });
	});

	afterEach(async () => {
		isolated?.restore();
		isolated = undefined;
		restoreSettingsTestState(settingsState);
		await tempDir.remove();
	});

	/** The agent dir a real launch under `profile` resolves to, created on disk. */
	function profileAgentDir(profile: string | undefined): string {
		setProfile(profile);
		const dir = getAgentDir();
		fs.mkdirSync(dir, { recursive: true });
		return dir;
	}

	/**
	 * Cause 1, the reported one: the user runs `--profile veybot`.
	 *
	 * Completion used to be written to the ACTIVE profile's config.yml, so the
	 * named profile's store had no `setupVersion`, the gate read the default 0,
	 * and a machine that had been onboarded was onboarded again. Onboarding state
	 * is machine-wide now, so the second profile reads the same completed value.
	 */
	it("does not re-onboard after a profile change", async () => {
		const defaultAgentDir = profileAgentDir(undefined);
		const first = await Settings.init({ cwd: projectDir, agentDir: defaultAgentDir });
		expect(markSetupWizardComplete(first)).toBe(true);

		// Second launch, `--profile veybot`: a different profile store entirely.
		const veybotAgentDir = profileAgentDir("veybot");
		expect(veybotAgentDir).not.toBe(defaultAgentDir);
		// `loadIsolated`, not `init`: `init` hands back the singleton the first
		// launch already installed, which would read the first profile's store and
		// make this pass without proving anything about the second.
		const second = await Settings.loadIsolated({ cwd: projectDir, agentDir: veybotAgentDir });

		expect(resolveOnboardingGeneration(second)).toEqual({ version: CURRENT_SETUP_VERSION, unreadable: false });
		expect(second.get("onboardingVersion")).toBe(CURRENT_SETUP_VERSION);
		expect(await selectSetupScenes(CURRENT_SETUP_VERSION, ALL_SCENES, undefined, { isTTY: true })).toEqual([]);

		// The value is in the one machine-wide file, and the named profile's own
		// store never received a copy that a third profile would again miss.
		expect(configRecord(globalConfigPath).onboardingVersion).toBe(CURRENT_SETUP_VERSION);
		const veybotStored = configRecord(path.join(veybotAgentDir, "config.yml"));
		expect(veybotStored.onboardingVersion).toBeUndefined();
		expect(veybotStored.setupVersion).toBeUndefined();
	});

	/**
	 * Cause 1 again, from the other direction: launching in another directory.
	 *
	 * Project-scoped config is merged into every read, so anything that put
	 * onboarding state on a per-directory path would onboard the user afresh in
	 * each new repository they opened.
	 */
	it("does not re-onboard when the working directory changes", async () => {
		const agentDir = profileAgentDir(undefined);
		const first = await Settings.init({ cwd: projectDir, agentDir });
		expect(markSetupWizardComplete(first)).toBe(true);

		const elsewhere = await Settings.loadIsolated({ cwd: otherProjectDir, agentDir });
		expect(resolveOnboardingGeneration(elsewhere)).toEqual({ version: CURRENT_SETUP_VERSION, unreadable: false });
		expect(elsewhere.get("onboardingVersion")).toBe(CURRENT_SETUP_VERSION);
		expect(await selectSetupScenes(CURRENT_SETUP_VERSION, ALL_SCENES, undefined, { isTTY: true })).toEqual([]);
		expect(configRecord(globalConfigPath).onboardingVersion).toBe(CURRENT_SETUP_VERSION);
	});

	/**
	 * Moving the value must not itself be a re-onboarding event.
	 *
	 * Every existing user holds a completed `setupVersion` in their profile store
	 * and nothing in the global one. Reading only the new location would onboard
	 * the entire installed base exactly once, which is the same defect wearing a
	 * new hat. The read falls back to the retired key and promotes it, so the
	 * fallback is consulted once per machine and never again.
	 */
	it("promotes a profile-onboarded user to the machine-wide store instead of re-onboarding", async () => {
		const agentDir = profileAgentDir(undefined);
		fs.writeFileSync(path.join(agentDir, "config.yml"), YAML.stringify({ setupVersion: CURRENT_SETUP_VERSION }));

		const settings = await Settings.init({ cwd: projectDir, agentDir });
		// Precisely the pre-migration state: onboarded per profile, unset globally.
		expect(settings.get("setupVersion")).toBe(CURRENT_SETUP_VERSION);
		expect(configRecord(globalConfigPath).onboardingVersion).toBeUndefined();

		expect(resolveOnboardingGeneration(settings)).toEqual({ version: CURRENT_SETUP_VERSION, unreadable: false });
		expect(await selectSetupScenes(CURRENT_SETUP_VERSION, ALL_SCENES, undefined, { isTTY: true })).toEqual([]);

		// Promoted, so the next profile does not depend on the fallback at all.
		expect(configRecord(globalConfigPath).onboardingVersion).toBe(CURRENT_SETUP_VERSION);
		const veybot = await Settings.loadIsolated({ cwd: projectDir, agentDir: profileAgentDir("veybot") });
		expect(veybot.get("setupVersion")).toBe(0);
		expect(resolveOnboardingGeneration(veybot)).toEqual({ version: CURRENT_SETUP_VERSION, unreadable: false });
	});

	/**
	 * Cause 2: a run that ends in a throw.
	 *
	 * `markSetupWizardComplete` used to sit after `await component.run()` inside
	 * the try, so any rejection skipped persistence entirely while the `finally`
	 * still tore the overlay down. The user had seen and worked through the
	 * wizard, nothing was written, and the next launch onboarded them again.
	 * Completion is recorded when the overlay goes UP, which is the moment the
	 * user has been shown onboarding, so no ending can lose it.
	 */
	it("leaves the user onboarded when the wizard run rejects", async () => {
		const agentDir = profileAgentDir(undefined);
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		const hideOverlay = mock(() => {});
		const scene: SetupScene = {
			id: "providers",
			title: "providers",
			minVersion: 1,
			mount: () => ({ title: "providers", render: () => [], invalidate: () => {} }),
		};
		const ctx = {
			settings,
			playWelcomeIntro: mock(() => {}),
			ui: {
				terminal: { rows: 24 },
				showOverlay: () => ({ hide: hideOverlay }),
				setFocus: mock((_component: unknown) => {}),
				requestRender: mock(() => {}),
			},
			refreshComposerShortcuts: vi.fn(),
			dismissWelcome: vi.fn(),
		} as unknown as InteractiveModeContext;

		spyOn(SetupWizardComponent.prototype, "run").mockImplementation(() =>
			Promise.reject(new Error("scene mount blew up")),
		);

		await expect(runSetupWizard(ctx, [scene])).rejects.toThrow("scene mount blew up");

		// On disk, not merely in memory: a crashed process has no flush left to run.
		expect(configRecord(globalConfigPath).onboardingVersion).toBe(CURRENT_SETUP_VERSION);
		expect(hideOverlay).toHaveBeenCalledTimes(1);

		const nextLaunch = await Settings.loadIsolated({ cwd: projectDir, agentDir });
		expect(resolveOnboardingGeneration(nextLaunch)).toEqual({ version: CURRENT_SETUP_VERSION, unreadable: false });
		expect(await selectSetupScenes(CURRENT_SETUP_VERSION, ALL_SCENES, undefined, { isTTY: true })).toEqual([]);
	});

	/**
	 * Cause 3: an unparseable profile settings file.
	 *
	 * The schema default is 0, byte-identical to a genuine fresh install, so a
	 * config that failed to parse used to hand the gate a confident "this user is
	 * new" and run the whole wizard against a machine set up months ago. The
	 * quarantine list is the signal that the answer is unknown, and unknown is
	 * not a first install.
	 */
	it("does not onboard when the profile settings file cannot be parsed", async () => {
		const agentDir = profileAgentDir(undefined);
		fs.writeFileSync(path.join(agentDir, "config.yml"), "startup:\n  quiet: [unclosed\n");

		const settings = await Settings.init({ cwd: projectDir, agentDir });
		expect(settings.quarantinedFiles).toHaveLength(1);
		// The raw value really is the fresh-install default; only the flag separates them.
		expect(settings.get("onboardingVersion")).toBe(0);

		const onboarding = resolveOnboardingGeneration(settings);
		expect(onboarding).toEqual({ version: 0, unreadable: true });
		expect(
			await selectSetupScenes(onboarding.version, ALL_SCENES, undefined, {
				isTTY: true,
				settingsUnreadable: onboarding.unreadable,
			}),
		).toEqual([]);
	});

	/**
	 * Cause 3, for the file onboarding state now actually lives in. A corrupt
	 * `~/.veyyon/config.yml` cannot reach the quarantine list, because the
	 * settings layer never parses it; its reader reports the failure instead.
	 */
	it("does not onboard when the machine-wide config cannot be parsed", async () => {
		fs.writeFileSync(globalConfigPath, "onboardingVersion: [1\n");

		const settings = await Settings.init({ cwd: projectDir, agentDir: profileAgentDir(undefined) });
		expect(settings.quarantinedFiles).toEqual([]);

		const onboarding = resolveOnboardingGeneration(settings);
		expect(onboarding).toEqual({ version: 0, unreadable: true });
		expect(
			await selectSetupScenes(onboarding.version, ALL_SCENES, undefined, {
				isTTY: true,
				settingsUnreadable: onboarding.unreadable,
			}),
		).toEqual([]);
	});

	/**
	 * The control the three cases above need to mean anything: with both files
	 * readable and neither holding a generation, this really is a first install
	 * and the wizard really does run. Without it, a gate that never onboarded
	 * anyone would satisfy every other case in this file.
	 */
	it("still onboards a genuine first install", async () => {
		const settings = await Settings.init({ cwd: projectDir, agentDir: profileAgentDir(undefined) });
		const onboarding = resolveOnboardingGeneration(settings);
		expect(onboarding).toEqual({ version: 0, unreadable: false });

		const selected = await selectSetupScenes(onboarding.version, ALL_SCENES, undefined, {
			isTTY: true,
			settingsUnreadable: onboarding.unreadable,
		});
		expect(selected.map(scene => scene.id)).toEqual(["providers", "glyph-mode", "theme"]);
	});
});

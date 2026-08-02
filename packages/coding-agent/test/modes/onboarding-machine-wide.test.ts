/**
 * Onboarding is a fact about the MACHINE, and two separate defects let a machine
 * that had been onboarded for months be handed the full setup wizard again.
 *
 *  1. THE LEGACY PROMOTION READ ONE PROFILE. When the machine-wide
 *     `onboardingVersion` is absent, the gate falls back to the retired
 *     per-profile `setupVersion` through `settings.get`, which resolves from
 *     the ACTIVE profile only. The reporting user's disk held
 *     `defaultProfile: work` in the global config, `setupVersion: 1` in
 *     `profiles/work/agent/config.yml`, and no config at all for `oss-work`.
 *     Launching `--profile oss-work` first looked at `oss-work`, found nothing,
 *     and declared a fresh install.
 *  2. RESUMING SKIPPED ONBOARDING AND RECORDED NOTHING. `--continue`/`--resume`/
 *     `--fork` returned no scenes, and no other path writes the generation, so
 *     the machine stayed byte-identical to a fresh install forever. Someone who
 *     habitually launches with `-c` was never onboarded, and the wizard then
 *     ambushed them on whatever later launch happened to omit the flag.
 *
 * Every case drives the real gate (`resolveOnboardingGeneration` for the stored
 * state, `selectSetupScenes` for the decision) and reads the concrete value back
 * out of the config file on disk.
 */
import { afterEach, beforeEach, describe, expect, it, mock, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings, type SettingsSaveFailure } from "@veyyon/coding-agent/config/settings";
import { type OnboardingGeneration, resolveOnboardingGeneration } from "@veyyon/coding-agent/modes/setup-version";
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

/** The ids the gate selects for a first install with no wizard context supplied. */
const FIRST_INSTALL_SCENE_IDS = ["providers", "glyph-mode", "theme"];

describe("onboarding is resolved from the whole machine", () => {
	let settingsState: SettingsTestState | undefined;
	let isolated: IsolatedConfigRoot | undefined;
	let tempDir: TempDir;
	let projectDir: string;
	/** `~/.veyyon/config.yml` for this test, inside the isolated root. */
	let globalConfigPath: string;

	beforeEach(() => {
		settingsState = beginSettingsTest();
		isolated = enterIsolatedConfigRoot("onboarding-machine-wide", { defaultProfile: true });
		globalConfigPath = path.join(getGlobalConfigRootDir(), "config.yml");
		tempDir = TempDir.createSync("@pi-onboarding-machine-wide-");
		projectDir = tempDir.join("project");
		fs.mkdirSync(projectDir, { recursive: true });
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

	/** Give `profile` the retired per-profile completion marker, as a pre-migration install has. */
	function recordLegacySetupVersion(profile: string | undefined, version: number): string {
		const agentDir = profileAgentDir(profile);
		fs.writeFileSync(path.join(agentDir, "config.yml"), `setupVersion: ${version}\n`);
		return agentDir;
	}

	/**
	 * The reporting user's exact disk state, reproduced.
	 *
	 * Global config holding ONLY `defaultProfile: work`; `profiles/work/agent/config.yml`
	 * holding `setupVersion: 1`; `oss-work` with no config file at all. Launching
	 * `--profile oss-work` FIRST, with no prior launch under `work`, showed the full
	 * wizard (`step 1 of 4`, `Set up your providers`) on a machine onboarded long ago,
	 * because the promotion asked the ACTIVE profile and nothing else.
	 */
	it("does not onboard a non-default profile on a machine another profile already onboarded", async () => {
		fs.writeFileSync(globalConfigPath, "defaultProfile: work\n");
		recordLegacySetupVersion("work", 1);
		const ossAgentDir = profileAgentDir("oss-work");
		// The premise: this profile records nothing at all, in either location.
		expect(fs.existsSync(path.join(ossAgentDir, "config.yml"))).toBe(false);

		const settings = await Settings.init({ cwd: projectDir, agentDir: ossAgentDir });
		expect(settings.get("setupVersion")).toBe(0);
		expect(settings.get("onboardingVersion")).toBe(0);

		const onboarding = resolveOnboardingGeneration(settings);
		expect(onboarding).toEqual({ version: 1, unreadable: false });
		expect(
			await selectSetupScenes(onboarding.version, ALL_SCENES, undefined, {
				isTTY: true,
				settingsUnreadable: onboarding.unreadable,
			}),
		).toEqual([]);

		// Promoted into the machine-wide file, so the scan happens once per machine,
		// and `defaultProfile` survived the write rather than being replaced by it, which
		// is why this asserts the bytes and not just the parsed keys.
		expect(fs.readFileSync(globalConfigPath, "utf8")).toBe("defaultProfile: work\nonboardingVersion: 1\n");
		// The named profile's own store did NOT receive a copy that a third profile
		// would again miss.
		expect(configRecord(path.join(ossAgentDir, "config.yml"))).toEqual({});
	});

	/**
	 * The general property behind the case above: the answer belongs to the machine,
	 * so it cannot change with `--profile`. Reading the active profile alone made
	 * `default` and `oss-work` report 0 while `veybot` reported 2, which is the same
	 * defect wearing a different profile name.
	 */
	it("resolves the same generation whichever profile is active", async () => {
		recordLegacySetupVersion("work", 1);
		recordLegacySetupVersion("veybot", 2);
		profileAgentDir("oss-work");

		const resolved: OnboardingGeneration[] = [];
		for (const profile of [undefined, "oss-work", "veybot"]) {
			// Back to the pre-promotion state, so every profile exercises the fallback
			// rather than reading what the previous iteration promoted.
			fs.writeFileSync(globalConfigPath, "defaultProfile: work\n");
			const settings = await Settings.loadIsolated({ cwd: projectDir, agentDir: profileAgentDir(profile) });
			resolved.push(resolveOnboardingGeneration(settings));
		}

		// The highest generation any profile recorded, three times over.
		expect(resolved).toEqual([
			{ version: 2, unreadable: false },
			{ version: 2, unreadable: false },
			{ version: 2, unreadable: false },
		]);
		expect(configRecord(globalConfigPath)).toEqual({ defaultProfile: "work", onboardingVersion: 2 });
	});

	/**
	 * The control the cross-profile scan needs to mean anything.
	 *
	 * Several profiles exist and NONE records a setup version, which really is a
	 * first install. A scan that returned a positive for a profile dir that merely
	 * exists would satisfy every other case in this file and quietly never onboard
	 * anyone again.
	 */
	it("still onboards when no profile on the machine records a setup version", async () => {
		profileAgentDir("work");
		profileAgentDir("oss-work");
		profileAgentDir("veybot");

		const settings = await Settings.init({ cwd: projectDir, agentDir: profileAgentDir(undefined) });
		const onboarding = resolveOnboardingGeneration(settings);
		expect(onboarding).toEqual({ version: 0, unreadable: false });

		const selected = await selectSetupScenes(onboarding.version, ALL_SCENES, undefined, {
			isTTY: true,
			settingsUnreadable: onboarding.unreadable,
		});
		expect(selected.map(scene => scene.id)).toEqual(FIRST_INSTALL_SCENE_IDS);
		// Nothing was promoted, because there was nothing to promote.
		expect(configRecord(globalConfigPath)).toEqual({});
	});

	/**
	 * A profile config that exists but cannot be parsed is unknown, not absent.
	 *
	 * The retired key's absence and an unreadable file both produce "no version
	 * found". Collapsing them would hand the gate a confident "this user is new"
	 * for a machine whose only record of onboarding is the file that just failed
	 * to parse.
	 */
	it("does not onboard when another profile's config exists but cannot be read", async () => {
		const workAgentDir = profileAgentDir("work");
		fs.writeFileSync(path.join(workAgentDir, "config.yml"), "setupVersion: [1\n");

		const settings = await Settings.init({ cwd: projectDir, agentDir: profileAgentDir("oss-work") });
		// The active profile parses fine, so the quarantine list cannot carry this.
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
	 * A zero-byte `~/.veyyon/config.yml` is present-but-unusable, not absent.
	 *
	 * It parsed to `null`, which the reader turned into an empty record, so the
	 * gate saw the same "no generation recorded" a genuine fresh install produces
	 * and re-ran the whole wizard against an onboarded machine. It is not a
	 * hypothetical state either: the global writer deliberately leaves an empty
	 * file behind when it deletes the last key and the unlink fails.
	 */
	it("does not onboard when the machine-wide config exists but holds nothing", async () => {
		fs.writeFileSync(globalConfigPath, "");

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
		// Nothing was promoted over the top of a file whose contents are unknown.
		expect(fs.readFileSync(globalConfigPath, "utf8")).toBe("");
	});

	/**
	 * The ambush: `--continue` on a fresh machine used to show no wizard AND write
	 * no record, leaving the machine indistinguishable from a fresh install for
	 * ever. The wizard then fired on some later ordinary launch, days or weeks on,
	 * with nothing the user could connect it to. A machine that has never onboarded
	 * has no session of its own to resume either, so there was nothing to protect.
	 */
	it("onboards a resuming first launch instead of deferring it to an unpredictable one", async () => {
		const agentDir = profileAgentDir(undefined);
		const settings = await Settings.init({ cwd: projectDir, agentDir });

		// Launch one: `veyyon --continue` on a machine that has never onboarded.
		const firstLaunch = resolveOnboardingGeneration(settings);
		expect(firstLaunch).toEqual({ version: 0, unreadable: false });
		const resumingScenes = await selectSetupScenes(firstLaunch.version, ALL_SCENES, undefined, {
			isTTY: true,
			resuming: true,
		});
		expect(resumingScenes.map(scene => scene.id)).toEqual(FIRST_INSTALL_SCENE_IDS);
		// Running the wizard is what records the generation, exactly as the cold-launch
		// gate does once it has scenes to run.
		expect(markSetupWizardComplete(settings)).toBe(true);
		expect(fs.readFileSync(globalConfigPath, "utf8")).toBe(`onboardingVersion: ${CURRENT_SETUP_VERSION}\n`);

		// Launch two, days later, without the flag: no surprise, and no second write.
		const secondLaunch = await Settings.loadIsolated({ cwd: projectDir, agentDir });
		const later = resolveOnboardingGeneration(secondLaunch);
		expect(later).toEqual({ version: CURRENT_SETUP_VERSION, unreadable: false });
		expect(await selectSetupScenes(later.version, ALL_SCENES, undefined, { isTTY: true, resuming: false })).toEqual(
			[],
		);
		expect(fs.readFileSync(globalConfigPath, "utf8")).toBe(`onboardingVersion: ${CURRENT_SETUP_VERSION}\n`);
	});

	/**
	 * Resuming still defers a RE-onboard, which is the only thing the flag was ever
	 * good for: the machine already has a record, the deferral is one launch long,
	 * and dropping someone into a wholesale re-onboard while their session is being
	 * restored is worse than waiting.
	 */
	it("defers a re-onboard while resuming, because that machine already has a record", async () => {
		const onboardedAtGeneration = 1;
		const scenes = await selectSetupScenes(onboardedAtGeneration, ALL_SCENES, undefined, {
			isTTY: true,
			resuming: true,
			currentVersion: 2,
		});
		expect(scenes).toEqual([]);

		// Same machine, same stale generation, an ordinary launch: it runs.
		const ordinary = await selectSetupScenes(onboardedAtGeneration, ALL_SCENES, undefined, {
			isTTY: true,
			resuming: false,
			currentVersion: 2,
		});
		expect(ordinary.map(scene => scene.id)).toEqual(FIRST_INSTALL_SCENE_IDS);
	});
});

describe("a completion the filesystem refuses", () => {
	let settingsState: SettingsTestState | undefined;
	let isolated: IsolatedConfigRoot | undefined;
	let tempDir: TempDir;
	let configRoot: string;
	let globalConfigPath: string;

	beforeEach(() => {
		settingsState = beginSettingsTest();
		isolated = enterIsolatedConfigRoot("onboarding-unwritable", { defaultProfile: true });
		configRoot = getGlobalConfigRootDir();
		globalConfigPath = path.join(configRoot, "config.yml");
		tempDir = TempDir.createSync("@pi-onboarding-unwritable-");
	});

	afterEach(async () => {
		// Before restore(): a read-only root cannot be deleted.
		fs.chmodSync(configRoot, 0o700);
		isolated?.restore();
		isolated = undefined;
		restoreSettingsTestState(settingsState);
		await tempDir.remove();
	});

	/**
	 * A machine that cannot persist the onboarding record re-ran the whole wizard on
	 * every launch and said nothing: `Settings.set` caught the refused global write,
	 * called `logger.warn` and returned, never touching the save-failure listeners
	 * that `main.ts` already turns into a user-visible notice. And the wizard marks
	 * completion twice (once when the overlay goes up, once more in its `finally`
	 * when the first write did not land), so the report has to be once per file
	 * rather than once per attempt.
	 */
	it("tells the user once, naming the unwritable file, however many times the wizard retries", async () => {
		const agentDir = tempDir.join("agent");
		fs.mkdirSync(agentDir, { recursive: true });
		const settings = await Settings.loadIsolated({ agentDir });
		const reported: SettingsSaveFailure[] = [];
		settings.onSaveFailure(failure => reported.push(failure));
		// Sealed after the load, so this is a failure to WRITE the global config and
		// not a failure to start up.
		// The log directory a real machine already has, so the `logger.warn` inside the
		// failing write does not print its own rebind warning about the sealed root.
		fs.mkdirSync(path.join(configRoot, "profiles", "default", "logs"), { recursive: true });
		fs.chmodSync(configRoot, 0o500);

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
		spyOn(SetupWizardComponent.prototype, "run").mockImplementation(() => Promise.resolve());

		await runSetupWizard(ctx, [scene]);

		// The wizard tried twice (the mark before the run and the retry in `finally`)
		// and the user hears about it exactly once.
		expect(reported).toHaveLength(1);
		expect(reported[0]?.path).toBe(globalConfigPath);
		expect(reported[0]?.attempts).toBe(1);
		expect(reported[0]?.reason).toMatch(/EACCES|EPERM|permission denied|read-only/i);
		expect(Object.keys(reported[0] as SettingsSaveFailure).sort()).toEqual(["attempts", "path", "reason"]);

		// Nothing landed, and every further attempt stays quiet rather than repeating.
		expect(fs.existsSync(globalConfigPath)).toBe(false);
		expect(markSetupWizardComplete(settings)).toBe(false);
		expect(markSetupWizardComplete(settings)).toBe(false);
		expect(reported).toHaveLength(1);
	});
});

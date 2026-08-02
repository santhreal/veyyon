/**
 * A refused write to the machine-wide `~/.veyyon/config.yml` used to be invisible.
 *
 * `Settings.set` routes a `scope: "global"` path through its binding instead of
 * the profile store, and it caught the binding's throw, called
 * `logger.warn("Settings: global write rejected; value not saved")` and returned.
 * It never touched `#saveFailure` or the save-failure listeners, which only the
 * PROFILE save path fired, even though `main.ts` already wires
 * `settings.onSaveFailure` to a user-visible notice. The result was a machine
 * that could not persist `onboardingVersion` re-running the whole setup wizard on
 * every launch while telling the user nothing about why (Law 10).
 *
 * These tests drive real writes against a real unwritable config root, because a
 * mocked filesystem cannot reproduce the binding's own lock-and-write path, and
 * they assert the reported PATH and ATTEMPT COUNT exactly rather than merely that
 * something was reported.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings, type SettingsSaveFailure } from "@veyyon/coding-agent/config/settings";
import { getGlobalConfigRootDir, TempDir } from "@veyyon/utils";
import { YAML } from "bun";
import { enterIsolatedConfigRoot, type IsolatedConfigRoot } from "../../../utils/test/helpers/isolated-config-root";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

describe("a global config that cannot be written", () => {
	let settingsState: SettingsTestState | undefined;
	let isolated: IsolatedConfigRoot | undefined;
	let tempDir: TempDir;
	let configRoot: string;
	let globalConfigPath: string;
	let agentDir: string;

	beforeEach(() => {
		settingsState = beginSettingsTest();
		isolated = enterIsolatedConfigRoot("global-write-failure", { defaultProfile: true });
		configRoot = getGlobalConfigRootDir();
		globalConfigPath = path.join(configRoot, "config.yml");
		tempDir = TempDir.createSync("@pi-global-write-failure-");
		agentDir = tempDir.join("agent");
		fs.mkdirSync(agentDir, { recursive: true });
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
	 * Loaded first, then sealed: `Settings` must come up normally so the test is
	 * about a failure to WRITE the global config rather than a failure to start.
	 */
	async function sealedAfterLoad(): Promise<{ settings: Settings; reported: SettingsSaveFailure[] }> {
		const settings = await Settings.loadIsolated({ agentDir });
		const reported: SettingsSaveFailure[] = [];
		settings.onSaveFailure(failure => reported.push(failure));
		// The log directory a real machine already has. Without it the first
		// `logger.warn` inside the failing write tries to create it under the sealed
		// root and prints its own rebind warning, which is noise about the test setup
		// rather than about the behaviour under test.
		fs.mkdirSync(path.join(configRoot, "profiles", "default", "logs"), { recursive: true });
		fs.chmodSync(configRoot, 0o500);
		return { settings, reported };
	}

	it("reaches the save-failure listener naming the global config file", async () => {
		const { settings, reported } = await sealedAfterLoad();

		settings.set("onboardingVersion", 1);

		expect(reported).toHaveLength(1);
		expect(reported[0]?.path).toBe(globalConfigPath);
		// One attempt, not three: a global binding writes synchronously under its own
		// lock and nothing retries it, so there is no later attempt to wait for.
		expect(reported[0]?.attempts).toBe(1);
		expect(reported[0]?.reason).toMatch(/EACCES|EPERM|permission denied|read-only/i);
		expect(Object.keys(reported[0] as SettingsSaveFailure).sort()).toEqual(["attempts", "path", "reason"]);
		// `set` stays non-throwing, and the value genuinely did not persist.
		expect(settings.get("onboardingVersion")).toBe(0);
		expect(fs.existsSync(globalConfigPath)).toBe(false);
	});

	it("reports once per file rather than once per attempt", async () => {
		const { settings, reported } = await sealedAfterLoad();

		settings.set("onboardingVersion", 1);
		settings.set("onboardingVersion", 1);
		settings.set("defaultProfile", "work");

		expect(reported).toHaveLength(1);
		expect(reported[0]?.attempts).toBe(1);
	});

	it("reports a refused unset too, not only a refused write", async () => {
		// `unset` had the identical swallow-and-log, so clearing a global value on a
		// read-only home reported success and silently kept the old value.
		fs.writeFileSync(globalConfigPath, "defaultProfile: work\n");
		const { settings, reported } = await sealedAfterLoad();

		settings.unset("defaultProfile");

		expect(reported).toHaveLength(1);
		expect(reported[0]?.path).toBe(globalConfigPath);
		expect(reported[0]?.attempts).toBe(1);
		expect(fs.readFileSync(globalConfigPath, "utf8")).toBe("defaultProfile: work\n");
	});

	/**
	 * The onboarding promotion writes the global config during startup, before the
	 * interactive mode exists to subscribe. Announcing to an empty listener set and
	 * then forgetting is the same silence this path exists to end, so a listener
	 * that arrives afterwards is told what it missed.
	 */
	it("replays a failure announced before anyone was listening", async () => {
		const settings = await Settings.loadIsolated({ agentDir });
		fs.mkdirSync(path.join(configRoot, "profiles", "default", "logs"), { recursive: true });
		fs.chmodSync(configRoot, 0o500);
		settings.set("onboardingVersion", 1);

		const late: SettingsSaveFailure[] = [];
		settings.onSaveFailure(failure => late.push(failure));

		expect(late).toHaveLength(1);
		expect(late[0]?.path).toBe(globalConfigPath);
		expect(late[0]?.attempts).toBe(1);
	});

	it("stops replaying once the file takes a write", async () => {
		const { settings } = await sealedAfterLoad();
		settings.set("onboardingVersion", 1);

		fs.chmodSync(configRoot, 0o700);
		settings.set("onboardingVersion", 1);

		const late: SettingsSaveFailure[] = [];
		settings.onSaveFailure(failure => late.push(failure));
		expect(late).toEqual([]);
		expect(settings.lastSaveError).toBeUndefined();
		// The write that cleared the failure is the one that actually landed.
		expect(YAML.parse(fs.readFileSync(globalConfigPath, "utf8"))).toEqual({ onboardingVersion: 1 });
	});
});

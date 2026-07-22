import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { KeybindingsManager } from "@veyyon/coding-agent/config/keybindings";
import { isSettingsInitialized, Settings } from "@veyyon/coding-agent/config/settings";
import {
	getActiveProfile,
	getAgentDir,
	getProjectDir,
	removeSyncWithRetries,
	Snowflake,
	setAgentDir,
	setProfile,
	setProjectDir,
} from "@veyyon/utils";
import {
	beginSettingsTest,
	currentKeybindingsForTest,
	installKeybindingsForTest,
	restoreSettingsTestState,
	type SettingsTestState,
} from "./settings-test-state";

/**
 * Locks the isolation contract of beginSettingsTest / restoreSettingsTestState.
 * If restore leaves cwd, agent dir, profile, env, or keybindings dirty, later
 * suites in the same bun test process fail nondeterministically
 * (FINDING-FULL-SUITE-ORDER-DEPENDENT-POLLUTION).
 */
describe("settings-test-state isolation", () => {
	let state: SettingsTestState | undefined;
	const temps: string[] = [];
	/** Profiles setProfile may create under the real config root — always remove. */
	const profileCleanups: string[] = [];

	afterEach(() => {
		if (state) {
			restoreSettingsTestState(state);
			state = undefined;
		}
		// Belt-and-suspenders after proving tests that poison keybindings.
		restoreSettingsTestState(undefined);
		for (const dir of temps.splice(0)) {
			if (fs.existsSync(dir)) removeSyncWithRetries(dir);
		}
		for (const dir of profileCleanups.splice(0)) {
			if (fs.existsSync(dir)) removeSyncWithRetries(dir);
		}
	});

	function makeTemp(label: string): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), `settings-iso-${label}-${Snowflake.next()}-`));
		temps.push(dir);
		return dir;
	}

	it("restores project dir, agent dir, profile, env config keys, and clears Settings", async () => {
		state = beginSettingsTest();
		const before = {
			projectDir: state.projectDir,
			agentDir: state.agentDir,
			profile: state.profile,
			cwd: state.cwd,
			configDir: state.env.VEYYON_CONFIG_DIR,
		};

		const temp = makeTemp("mutate");
		const agent = path.join(temp, "agent");
		const project = path.join(temp, "project");
		fs.mkdirSync(agent, { recursive: true });
		fs.mkdirSync(project, { recursive: true });

		// setAgentDir relocates without requiring a named profile on disk.
		// setProfile is also exercised so restore must clear active profile.
		setAgentDir(agent);
		setProfile("iso-profile-test");
		// Track the profile dir that setProfile may have created under the real
		// config root (Bun caches os.homedir at process start, so HOME mutation
		// alone does not relocate it).
		const profileDir = path.dirname(getAgentDir());
		if (profileDir.includes("iso-profile-test")) {
			profileCleanups.push(path.dirname(profileDir)); // profiles/iso-profile-test
		}
		setProjectDir(project);
		const leakedConfig = path.join(temp, "cfg-name");
		process.env.VEYYON_CONFIG_DIR = leakedConfig;
		Bun.env.VEYYON_CONFIG_DIR = leakedConfig;

		await Settings.init({ cwd: project, agentDir: getAgentDir(), inMemory: true });
		expect(isSettingsInitialized()).toBe(true);
		expect(getProjectDir()).toBe(path.resolve(project));
		expect(getActiveProfile()).toBe("iso-profile-test");
		expect(process.cwd()).toBe(path.resolve(project));
		expect(getAgentDir()).not.toBe(before.agentDir);

		restoreSettingsTestState(state);
		state = undefined;

		expect(isSettingsInitialized()).toBe(false);
		expect(getProjectDir()).toBe(before.projectDir);
		expect(getAgentDir()).toBe(before.agentDir);
		expect(getActiveProfile()).toBe(before.profile);
		expect(process.cwd()).toBe(before.cwd);
		expect(process.env.VEYYON_CONFIG_DIR).toBe(before.configDir);
		expect(Bun.env.VEYYON_CONFIG_DIR).toBe(before.configDir);
	});

	it("restores env keys the suite deleted and removes keys the suite added", () => {
		state = beginSettingsTest();
		const originalHome = state.env.HOME;
		const markerKey = `VEYYON_TEST_ISO_${Snowflake.next()}`;

		delete process.env.HOME;
		delete Bun.env.HOME;
		process.env[markerKey] = "leaked";
		Bun.env[markerKey] = "leaked";

		restoreSettingsTestState(state);
		state = undefined;

		expect(process.env.HOME).toBe(originalHome);
		expect(Bun.env.HOME).toBe(originalHome);
		expect(process.env[markerKey]).toBeUndefined();
		expect(Bun.env[markerKey]).toBeUndefined();
	});

	it("falls back to the snapshotted cwd when the project dir no longer exists", () => {
		state = beginSettingsTest();
		const beforeCwd = state.cwd;
		const doomed = makeTemp("doomed");
		setProjectDir(doomed);
		expect(process.cwd()).toBe(path.resolve(doomed));

		const snap: SettingsTestState = {
			...state,
			projectDir: doomed,
			cwd: beforeCwd,
		};
		setProjectDir(beforeCwd);
		removeSyncWithRetries(doomed);

		restoreSettingsTestState(snap);
		state = undefined;

		expect(process.cwd()).toBe(beforeCwd);
		expect(getProjectDir()).toBe(beforeCwd);
	});

	it("clears a leaked setKeybindings singleton so later suites see defaults", () => {
		state = beginSettingsTest();
		const poisoned = KeybindingsManager.inMemory({ "tui.select.cancel": "ctrl+z" });
		installKeybindingsForTest(poisoned);
		expect(currentKeybindingsForTest()).toBe(poisoned);

		restoreSettingsTestState(state);
		state = undefined;

		// A fresh default manager — not the poisoned instance.
		expect(currentKeybindingsForTest()).not.toBe(poisoned);
	});

	it("adversarial: begin clears a prior suite's poisoned keybindings before the suite body runs", () => {
		const priorPoison = KeybindingsManager.inMemory({ "tui.select.cancel": "f9" });
		installKeybindingsForTest(priorPoison);
		expect(currentKeybindingsForTest()).toBe(priorPoison);

		// begin must wipe the poison so this suite never observes the prior map.
		state = beginSettingsTest();
		expect(currentKeybindingsForTest()).not.toBe(priorPoison);

		restoreSettingsTestState(state);
		state = undefined;
	});

	it("adversarial: restore(undefined) still clears a poisoned keybindings singleton", () => {
		const poisoned = KeybindingsManager.inMemory({ "app.tools.expand": "alt+z" });
		installKeybindingsForTest(poisoned);
		expect(currentKeybindingsForTest()).toBe(poisoned);

		restoreSettingsTestState(undefined);

		expect(currentKeybindingsForTest()).not.toBe(poisoned);
	});

	it("adversarial: restore does not throw when the snapshotted projectDir was deleted by another suite", () => {
		// Reproduces the canonicalize → service-tier cascade from fulltest.log:
		// begin snapshots a path that no longer exists on disk; restore must fall
		// back instead of throwing ENOENT from setProjectDir.
		state = beginSettingsTest();
		const safeCwd = state.cwd;
		const ghost = path.join(os.tmpdir(), `settings-iso-ghost-${Snowflake.next()}`);
		const snap: SettingsTestState = {
			...state,
			projectDir: ghost,
			cwd: safeCwd,
		};
		expect(fs.existsSync(ghost)).toBe(false);

		expect(() => restoreSettingsTestState(snap)).not.toThrow();
		state = undefined;
		expect(getProjectDir()).toBe(safeCwd);
		expect(process.cwd()).toBe(safeCwd);
	});
});

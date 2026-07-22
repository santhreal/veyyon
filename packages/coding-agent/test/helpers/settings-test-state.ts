import { vi } from "bun:test";
import * as fs from "node:fs";
import { resetSettingsForTest } from "@veyyon/coding-agent/config/settings";
import { isTuiTight, resetKeybindingsForTests, setTuiTight } from "@veyyon/tui";
import {
	__resetDirsFromEnvForTests,
	getActiveProfile,
	getAgentDir,
	getProjectDir,
	setAgentDir,
	setProfile,
	setProjectDir,
} from "@veyyon/utils";

/**
 * Snapshot of every process-global that Settings / dir / profile tests mutate.
 * A suite that only passes in isolation is broken: restore must make the next
 * file see the same env, cwd, agent dir, project dir, and profile as before.
 */
export interface SettingsTestState {
	agentDir: string;
	/** Active named profile at begin, or undefined for the default profile. */
	profile: string | undefined;
	/** process.cwd() at begin — restored via setProjectDir after env restore. */
	cwd: string;
	env: Record<string, string | undefined>;
	projectDir: string;
	tuiTight: boolean;
}

/** Capture globals, clear the Settings singleton, return a restore token. */
export function beginSettingsTest(): SettingsTestState {
	const env: Record<string, string | undefined> = {};
	for (const key in process.env) {
		env[key] = process.env[key];
	}
	for (const key in Bun.env) {
		env[key] = Bun.env[key];
	}
	const state: SettingsTestState = {
		agentDir: getAgentDir(),
		profile: getActiveProfile(),
		cwd: process.cwd(),
		env,
		projectDir: getProjectDir(),
		tuiTight: isTuiTight(),
	};
	resetSettingsForTest();
	return state;
}

/**
 * Undo every mutation from a settings/dir suite. Order matters:
 * 1. mocks off
 * 2. Settings singleton cleared
 * 3. env restored (including VEYYON_ and XDG_ keys)
 * 4. dir resolver rebuilt from that env
 * 5. agent dir / profile / project dir / cwd re-applied to the snapshotted values
 * 6. TUI tight flag restored
 *
 * Project dir restore uses {@link setProjectDir}, which also chdirs, so a suite
 * that deleted its temp tree must restore cwd before the temp path is gone, or
 * call restore while the original project dir still exists.
 */
export function restoreSettingsTestState(state: SettingsTestState | undefined): void {
	vi.restoreAllMocks();
	resetSettingsForTest();
	if (!state) return;

	restoreEnv(state.env);
	// Rebuild profile + DirResolver from the restored env first, then force the
	// exact agent/project/profile the caller had. setAgentDir/setProfile write
	// env vars; re-applying the snapshotted env keys after them would fight the
	// intentional overrides, so we re-set agent/profile after env+resetDirs.
	__resetDirsFromEnvForTests();
	setAgentDir(state.agentDir);
	setProfile(state.profile);
	// Prefer the snapshotted projectDir; fall back to cwd if projectDir is gone
	// (deleted temp) so the process is never left in a removed directory.
	const projectTarget = directoryExists(state.projectDir)
		? state.projectDir
		: directoryExists(state.cwd)
			? state.cwd
			: process.cwd();
	setProjectDir(projectTarget);
	setTuiTight(state.tuiTight);
	// Keybindings are a process-global singleton; suites that call setKeybindings
	// without restoring poison later files in the same bun test process.
	resetKeybindingsForTests();
	// Final env pin for agent-dir keys that setAgentDir/setProfile may have
	// rewritten away from the snapshot when profile was active.
	restoreEnvValue("VEYYON_CODING_AGENT_DIR", state.env.VEYYON_CODING_AGENT_DIR);
	restoreEnvValue("VEYYON_PROFILE", state.env.VEYYON_PROFILE);
	restoreEnvValue("VEYYON_CONFIG_DIR", state.env.VEYYON_CONFIG_DIR);
}

function directoryExists(dir: string): boolean {
	try {
		return fs.statSync(dir).isDirectory();
	} catch {
		return false;
	}
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
	for (const key in process.env) {
		if (!(key in snapshot)) {
			restoreEnvValue(key, undefined);
		}
	}
	for (const key in Bun.env) {
		if (!(key in snapshot)) {
			restoreEnvValue(key, undefined);
		}
	}
	for (const key in snapshot) {
		restoreEnvValue(key, snapshot[key]);
	}
}

function restoreEnvValue(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete Bun.env[key];
		return;
	}
	process.env[key] = value;
	Bun.env[key] = value;
}

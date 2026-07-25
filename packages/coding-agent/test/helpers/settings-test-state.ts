import { vi } from "bun:test";
import * as fs from "node:fs";
import { resetSettingsForTest } from "@veyyon/coding-agent/config/settings";
import {
	getKeybindings,
	isTuiTight,
	type KeybindingsManager,
	resetKeybindingsForTests,
	setKeybindings,
	setTuiTight,
} from "@veyyon/tui";
import { getActiveProfile, getAgentDir, getProjectDir, setProjectDir } from "@veyyon/utils";
import { captureDirOverrides, type DirOverridesSnapshot, restoreDirOverrides } from "@veyyon/utils/dirs";

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
	/**
	 * The dir OVERRIDES — `VEYYON_CODING_AGENT_DIR`, `VEYYON_PROFILE`, the in-memory
	 * profile, and the pre-profile agent-dir baseline — captured by the one owner of that
	 * undo. `agentDir` above is the RESOLVED path, which cannot express whether it came
	 * from a variable, a profile, or a default, and cannot express the baseline at all.
	 */
	dirOverrides: DirOverridesSnapshot;
}

/**
 * Capture globals, clear the Settings singleton and keybindings singleton, return
 * a restore token. Clearing keybindings at begin stops a prior suite that called
 * setKeybindings without restore from poisoning this suite
 * (FINDING-FULL-SUITE-ORDER-DEPENDENT-POLLUTION).
 */
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
		dirOverrides: captureDirOverrides(),
	};
	resetSettingsForTest();
	resetKeybindingsForTests();
	return state;
}

/**
 * Undo every mutation from a settings/dir suite. Order matters:
 * 1. mocks off
 * 2. Settings singleton cleared
 * 3. TUI keybindings singleton cleared (even when state is missing)
 * 4. env restored (including VEYYON_ and XDG_ keys)
 * 5. dir resolver rebuilt from that env
 * 6. agent dir / profile / project dir / cwd re-applied to the snapshotted values
 * 7. TUI tight flag restored
 *
 * Project dir restore uses {@link setProjectDir}, which also chdirs, so a suite
 * that deleted its temp tree must restore cwd before the temp path is gone, or
 * call restore while the original project dir still exists. If the snapshotted
 * projectDir is gone, fall back to cwd (then process.cwd()) so restore never
 * throws ENOENT and leaves getProjectDir pointing at a deleted path for the
 * next file.
 */
export function restoreSettingsTestState(state: SettingsTestState | undefined): void {
	vi.restoreAllMocks();
	resetSettingsForTest();
	// Always clear keybindings — callers may invoke restore(undefined) in afterEach
	// after a failed begin, and a poisoned singleton must not survive.
	resetKeybindingsForTests();
	if (!state) return;

	restoreEnv(state.env);
	// One call for the whole dir/profile undo, instead of `setAgentDir` + `setProfile`
	// here and a hand-rolled env re-pin at the end. Those two setters are not inverses
	// (each writes environment variables the snapshot may say were absent, `setAgentDir`
	// clears the active profile, and `setAgentDir` OVERWRITES the pre-profile baseline),
	// and forcing the RESOLVED agent dir back through `setAgentDir` is what left that
	// baseline pointing at the developer's real `~/.veyyon/profiles/<profile>/agent` in
	// every suite using this helper — invisible in the environment and in the resolved
	// dir, and only caught once the leak tracer grew a probe for it.
	restoreDirOverrides(state.dirOverrides);
	// Prefer the snapshotted projectDir; fall back to cwd if projectDir is gone
	// (deleted temp) so the process is never left trying to enter a removed path.
	// setProjectDir chdirs first and only then assigns the global — a throw leaves
	// getProjectDir unchanged, but a suite that snapshotted a already-deleted
	// path still needs this exists-check or every later begin/restore pair fails.
	const projectTarget = directoryExists(state.projectDir)
		? state.projectDir
		: directoryExists(state.cwd)
			? state.cwd
			: process.cwd();
	setProjectDir(projectTarget);
	setTuiTight(state.tuiTight);
	// `VEYYON_CONFIG_DIR` is not part of the dir-overrides snapshot (it names the config
	// ROOT, a different lever), and `setProjectDir` above can chdir through code that
	// reads it, so it is pinned here.
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

let fileLevelIsolationOwner: string | undefined;

/**
 * Claim the single FILE-LEVEL isolation slot, for helpers that snapshot at
 * `beforeAll` and restore at `afterAll`.
 *
 * Why a claim rather than "just call both helpers": Bun runs `afterAll` callbacks in
 * REGISTRATION order, not in reverse. Two file-level helpers therefore restore
 * outermost-first, and the second one — whose snapshot was taken AFTER the first had
 * already redirected the agent dir — puts that temp redirection back on the way out.
 * `tools/non-interactive-approval-fails-closed.test.ts` stacked
 * `useIsolatedAgentDir()` and `useIsolatedGlobalSettings()` exactly that way and left
 * `VEYYON_CODING_AGENT_DIR` pointing at its own deleted temp dir for every later file
 * in the process. Stacking cannot be made to work by ordering, so it fails loudly
 * here instead, and the legitimate combination is an option on one helper.
 */
export function claimFileLevelIsolation(label: string): void {
	if (fileLevelIsolationOwner !== undefined) {
		throw new Error(
			`${label} cannot be stacked on ${fileLevelIsolationOwner}: two file-level isolation ` +
				`helpers restore in registration order, so the second one reinstates the first one's ` +
				`temp state. Call useIsolatedAgentDir({ globalSettings: true }) instead of calling ` +
				`useIsolatedAgentDir() and useIsolatedGlobalSettings() in the same file.`,
		);
	}
	fileLevelIsolationOwner = label;
}

/** Release the file-level isolation slot. Safe to call when nothing is claimed. */
export function releaseFileLevelIsolation(): void {
	fileLevelIsolationOwner = undefined;
}

/** Test-only: which helper currently holds the file-level slot, if any. */
export function fileLevelIsolationOwnerForTests(): string | undefined {
	return fileLevelIsolationOwner;
}

/** Test-only: install a custom keybindings singleton (for isolation proving tests). */
export function installKeybindingsForTest(manager: KeybindingsManager): void {
	setKeybindings(manager);
}

/** Test-only: identity of the current keybindings singleton. */
export function currentKeybindingsForTest(): KeybindingsManager {
	return getKeybindings();
}

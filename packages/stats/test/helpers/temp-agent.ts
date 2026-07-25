/**
 * Shared test isolation for stats Bun tests.
 *
 * The default profile's stats.db is redirected to `$XDG_DATA_HOME/veyyon/stats.db`
 * by {@link DirResolver} whenever `agentDirOverride === defaultAgent`. Tests
 * that only set `VEYYON_CONFIG_DIR` + `setAgentDir(<home>/<config>/agent)` resolve
 * to that default and silently share `stats.db` across files when an XDG
 * variable is set (e.g. CI's `XDG_DATA_HOME`), producing the cross-test row
 * pollution that fails `db-range`, `behavior-backfill`, `priority-premium-*`,
 * and `agent-type` runs.
 *
 * `installStatsTestIsolation` snapshots and clears `XDG_*_HOME` plus the
 * config-dir env vars for the test, points the agent directory at a fresh
 * `TempDir`, closes the stats DB handle, and tears everything back down in the
 * matching `afterEach`.
 */
import { afterEach, beforeEach } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { closeDb } from "@veyyon/stats/db";
import { setAgentDir, TempDir } from "@veyyon/utils";
import { captureDirOverrides, type DirOverridesSnapshot, restoreDirOverrides } from "@veyyon/utils/dirs";

const XDG_KEYS = ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"] as const;
// VEYYON_CONFIG_DIR is the live resolution key (dirs.ts CONFIG_DIR_ENV_KEYS);
// the legacy names are snapshotted/cleared so stale wrappers can't leak in.
const CONFIG_DIR_KEYS = ["VEYYON_CONFIG_DIR"] as const;

export interface StatsTestIsolation {
	/** Active per-test `TempDir`. Null between tests. */
	current(): TempDir | null;
}

export function installStatsTestIsolation(prefix: string): StatsTestIsolation {
	const originalConfigDirs: Record<string, string | undefined> = {};
	let dirOverrides: DirOverridesSnapshot | undefined;
	const originalXdg: Record<string, string | undefined> = {};
	let tempDir: TempDir | null = null;

	beforeEach(() => {
		// Captured per test, before anything is redirected. `setAgentDir(theOldValue)` is
		// NOT an inverse of `setAgentDir(temp)`: it always WRITES
		// `VEYYON_CODING_AGENT_DIR`, so it cannot express "the variable was absent", and it
		// CLEARS the active profile. Restoring that way made all twelve suites using this
		// helper export the developer's real agent dir and the default profile to every
		// file that ran after them in the same process.
		dirOverrides = captureDirOverrides();
		tempDir = TempDir.createSync(prefix);
		for (const key of CONFIG_DIR_KEYS) {
			originalConfigDirs[key] = process.env[key];
			delete process.env[key];
		}
		for (const key of XDG_KEYS) {
			originalXdg[key] = process.env[key];
			delete process.env[key];
		}
		const configDir = path.relative(os.homedir(), tempDir.join("config"));
		process.env.VEYYON_CONFIG_DIR = configDir;
		setAgentDir(path.join(os.homedir(), configDir, "agent"));
	});

	afterEach(() => {
		closeDb();
		for (const key of CONFIG_DIR_KEYS) {
			const prior = originalConfigDirs[key];
			if (prior === undefined) delete process.env[key];
			else process.env[key] = prior;
		}
		for (const key of XDG_KEYS) {
			const prior = originalXdg[key];
			if (prior === undefined) delete process.env[key];
			else process.env[key] = prior;
		}
		// After the config/XDG variables are back, because the restore rebuilds the dir
		// resolver FROM the environment.
		if (dirOverrides) restoreDirOverrides(dirOverrides);
		dirOverrides = undefined;
		tempDir?.removeSync();
		tempDir = null;
	});

	return {
		current() {
			return tempDir;
		},
	};
}

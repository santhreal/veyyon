import { afterAll, beforeAll } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { AgentStorage } from "@veyyon/coding-agent/session/agent-storage";
import { __resetDirsFromEnvForTests, getWorktreesDir, setAgentDir, setWorktreesDir, TempDir } from "@veyyon/utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./settings-test-state";

/**
 * Isolate the AGENT DIRECTORY for a test file, in one line.
 *
 * The agent dir is the third of veyyon's three independent roots (the other two
 * being the config root and the cache root), and isolating either of the others
 * says nothing about it. It is where `agent.db` lives, so any code that opens
 * `AgentStorage` — sessions, autoresearch experiment storage, auth, and the
 * caches hanging off it — writes into the developer's real
 * `~/.veyyon/profiles/<profile>/agent` unless this is called. The real-data
 * tripwire refuses that write, which turns one un-isolated suite into a wall of
 * unrelated-looking failures.
 *
 * The snapshot and the restore are NOT re-implemented here. `beginSettingsTest`
 * already captures the agent dir along with the profile, the project dir, the
 * cwd, and the whole environment, and `restoreSettingsTestState` puts every one
 * of them back in the order that works; a second hand-rolled restore beside it
 * would be a copy that drifts. All this adds is the temp dir and the
 * `setAgentDir` pointing at it.
 *
 * The `AgentStorage` singleton is reset on the way out because it caches an open
 * handle on the temp database, and a later file that opened storage would keep
 * reading a directory this one already deleted.
 *
 * Call it once at the top level of a suite file, outside any `describe`.
 */
export function useIsolatedAgentDir(): void {
	let state: SettingsTestState | undefined;
	let tempDir: TempDir | undefined;

	beforeAll(() => {
		state = beginSettingsTest();
		tempDir = TempDir.createSync("@veyyon-isolated-agent-dir-");
		setAgentDir(tempDir.path());
	});

	afterAll(async () => {
		AgentStorage.resetInstance();
		restoreSettingsTestState(state);
		state = undefined;
		if (tempDir) {
			try {
				await tempDir.remove();
			} catch {}
			tempDir = undefined;
		}
	});
}

/**
 * Isolate the CONFIG ROOT for a test file or a single describe, in one line, and
 * hand back the temp path so the suite can assert against it.
 *
 * Use this for a test that runs a command IN THIS PROCESS rather than spawning
 * it. A spawned child can be isolated with {@link hermeticSpawnEnv}, but an
 * in-process command reads the config root through this process's own resolver,
 * so only moving the resolver helps.
 *
 * THE TRAP THIS CLOSES, which is why it is a helper and not three lines in each
 * suite. Setting `VEYYON_CONFIG_DIR` and rebuilding looks sufficient and is not:
 * `resolveActiveAgentDirOverride()` reads `VEYYON_CODING_AGENT_DIR` whenever no
 * named profile is active, and in `DirResolver` that override WINS over the
 * config root outright. `setAgentDir` writes that variable into `process.env`
 * and nothing clears it, so any earlier suite in the same process that isolated
 * its agent dir leaves the variable set, and a later suite's careful temp config
 * root is then ignored in favour of the earlier suite's directory.
 *
 * The failure mode is the worst kind: the suite passes when run alone and fails
 * only in a full run, where the culprit is a different file entirely, and the
 * assertion it fails on is the one that was supposed to prove the isolation.
 * `test/cli/ttsr-cli.test.ts` and `test/cli/plain-pipe-output.test.ts` both
 * failed exactly that way. Clearing the agent-dir and profile variables here is
 * what makes the config root actually take effect.
 *
 * `VEYYON_CONFIG_DIR` is resolved relative to `os.homedir()`, so the value
 * written is a relative path. Assigning `HOME` instead would do nothing: Bun
 * fixes `os.homedir()` at process start.
 *
 * @returns An accessor for the temp config root. It is only populated inside
 *   `beforeAll`, so call it from a test body, never at module scope.
 */
export function useIsolatedConfigRoot(): () => string {
	let state: SettingsTestState | undefined;
	let tempDir: TempDir | undefined;
	let configRoot = "";

	beforeAll(() => {
		// Captures and restores the env wholesale, including the two variables
		// cleared below, so no second hand-rolled snapshot is needed here.
		state = beginSettingsTest();
		tempDir = TempDir.createSync("@veyyon-isolated-config-root-");
		configRoot = tempDir.path();
		process.env.VEYYON_CONFIG_DIR = path.relative(os.homedir(), configRoot);
		delete process.env.VEYYON_CODING_AGENT_DIR;
		delete process.env.VEYYON_PROFILE;
		__resetDirsFromEnvForTests();
	});

	afterAll(async () => {
		restoreSettingsTestState(state);
		state = undefined;
		configRoot = "";
		if (tempDir) {
			try {
				await tempDir.remove();
			} catch {}
			tempDir = undefined;
		}
	});

	return () => configRoot;
}

/**
 * Isolate the agent-managed WORKTREES root for a test file, in one line.
 *
 * Worktrees are a fourth location and a separate resolution chain from the agent
 * dir: `getWorktreesDir()` reads `VEYYON_WORKTREE_DIR`, then the `worktree.base`
 * override, then falls back to the profile's `wt/` directory under the CONFIG
 * root. So `useIsolatedAgentDir()` does not cover it, and a task suite that runs
 * an isolated spawn creates (and later removes) checkouts inside the developer's
 * real `~/.veyyon/profiles/<profile>/wt` — an `fs.rm` on real data, which is the
 * one operation there is no recovering from.
 *
 * The override is the right lever rather than the env var: the env var wins over
 * it, so a developer who has `VEYYON_WORKTREE_DIR` set would otherwise silently
 * keep their own location and the isolation would be a no-op. Setting the env
 * var too is what makes this hold for the child processes a spawn starts.
 *
 * Pair it with {@link useIsolatedAgentDir} in any suite that spawns tasks.
 */
export function useIsolatedWorktreesDir(): void {
	let tempDir: TempDir | undefined;
	let previousOverride: string | undefined;
	let previousEnv: string | undefined;

	beforeAll(() => {
		previousEnv = process.env.VEYYON_WORKTREE_DIR;
		// There is no getter for the override alone, so snapshot the RESOLVED value
		// and put that back: it is the same path resolution the next file would see.
		previousOverride = getWorktreesDir();
		tempDir = TempDir.createSync("@veyyon-isolated-worktrees-");
		process.env.VEYYON_WORKTREE_DIR = tempDir.path();
		setWorktreesDir(tempDir.path());
	});

	afterAll(async () => {
		setWorktreesDir(previousOverride);
		if (previousEnv === undefined) delete process.env.VEYYON_WORKTREE_DIR;
		else process.env.VEYYON_WORKTREE_DIR = previousEnv;
		if (tempDir) {
			try {
				await tempDir.remove();
			} catch {}
			tempDir = undefined;
		}
	});
}

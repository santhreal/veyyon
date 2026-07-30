import { afterAll, beforeAll } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentStorage } from "@veyyon/coding-agent/session/agent-storage";
import { getWorktreesDir, setAgentDir, setWorktreesDir, TempDir } from "@veyyon/utils";
import { setTransports } from "@veyyon/utils/logger";
import { enterIsolatedConfigRoot, type IsolatedConfigRoot } from "../../../utils/test/helpers/isolated-config-root";
import {
	beginSettingsTest,
	claimFileLevelIsolation,
	releaseFileLevelIsolation,
	restoreSettingsTestState,
	type SettingsTestState,
} from "./settings-test-state";

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
 *
 * @param options.globalSettings Also initialize the global `Settings` singleton in
 *   memory, which is what {@link useIsolatedGlobalSettings} does on its own. Pass this
 *   instead of calling both helpers: they cannot be stacked, and
 *   {@link claimFileLevelIsolation} explains why and refuses.
 */
export function useIsolatedAgentDir(options: { globalSettings?: boolean } = {}): void {
	let state: SettingsTestState | undefined;
	let tempDir: TempDir | undefined;

	beforeAll(async () => {
		claimFileLevelIsolation("useIsolatedAgentDir()");
		state = beginSettingsTest();
		tempDir = TempDir.createSync("@veyyon-isolated-agent-dir-");
		setAgentDir(tempDir.path());
		// After the redirect, so the in-memory singleton is built against the temp dir
		// rather than the developer's real one.
		if (options.globalSettings) await Settings.init({ inMemory: true });
	});

	afterAll(async () => {
		AgentStorage.resetInstance();
		restoreSettingsTestState(state);
		state = undefined;
		releaseFileLevelIsolation();
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
 * The redirection itself lives in `enterIsolatedConfigRoot`
 * (`packages/utils/test/helpers/isolated-config-root.ts`), which is where the trap this
 * closes is documented: `VEYYON_CODING_AGENT_DIR` wins over the config root outright when
 * no named profile is active, `setAgentDir` writes that variable and nothing clears it, so
 * an earlier suite's agent-dir isolation silently defeats a later suite's config root.
 * `test/cli/ttsr-cli.test.ts` and `test/cli/plain-pipe-output.test.ts` both failed that
 * way. This function is the file-level HOOK shape; suites in other packages, and suites
 * that need a fresh root per test rather than per file, call the imperative form directly.
 * One implementation, two shapes.
 *
 * @returns An accessor for the temp config root. It is only populated inside
 *   `beforeAll`, so call it from a test body, never at module scope.
 */
export function useIsolatedConfigRoot(): () => string {
	let state: SettingsTestState | undefined;
	let isolated: IsolatedConfigRoot | undefined;
	let configRoot = "";

	beforeAll(() => {
		claimFileLevelIsolation("useIsolatedConfigRoot()");
		// Captures and restores the env wholesale, including the variables the imperative
		// helper changes, so no second hand-rolled snapshot is needed here.
		state = beginSettingsTest();
		// `defaultProfile` because a suite using this shape wants a predictable
		// `profiles/default/...` layout whatever the developer's environment says.
		isolated = enterIsolatedConfigRoot("coding-agent-suite", { defaultProfile: true });
		configRoot = isolated.root;
	});

	afterAll(() => {
		// UNBIND THE LOGGER BEFORE THE ROOT IS DELETED, for the same reason
		// `useIsolatedAgentDir` resets `AgentStorage`: it is a process-wide singleton
		// holding a path into a temp tree this hook is about to remove.
		//
		// `makeFileTransport` resolves `getLogsDir()` exactly ONCE, when the shared winston
		// logger is first built, and that build happens on the first log emission from
		// anywhere in the process. A suite that runs a command IN-PROCESS logs as a side
		// effect (`ttsr list`/`ttsr scan` load Settings, which does), so the shared transport
		// ends up bound to `<this temp root>/profiles/default/logs`. That binding used to
		// outlive the suite: the next file to emit a line made `rebindFileTransportIfMoved`
		// try to follow the config root back to the developer's REAL
		// `~/.veyyon/profiles/<profile>/logs`, the real-data tripwire refused that
		// `createWriteStream`, and the failure surfaced as a `VEYYON_LOG_REBIND_FAILED`
		// warning inside whatever innocent file happened to run next —
		// `test/cli/auto-update-outcomes.test.ts` in the run this was found in, which passed
		// alone and only failed after `test/cli/ttsr-cli.test.ts`. The still-live rotator
		// also re-creates the deleted tree on its next open, which is where the 130 stale
		// roots documented in `rebindFileTransportIfMoved` came from.
		//
		// `file: false` rather than a rebuild: rebuilding here would resolve the REAL logs
		// dir and trip the guard inside this hook. It is also the end state the logger's own
		// suites leave behind, and every suite that wants file logging sets its own
		// transports (see `packages/utils/test/logger-file-transport-rebind.test.ts`).
		//
		// None of this is reachable by moving `HOME`: under Bun `os.homedir()` is resolved
		// once at process start, so assigning `process.env.HOME` redirects nothing. The root
		// moves through `VEYYON_CONFIG_DIR` (relative to the real home) plus a resolver
		// refresh, which is what `enterIsolatedConfigRoot` does.
		setTransports({ file: false, console: false });
		isolated?.restore();
		isolated = undefined;
		restoreSettingsTestState(state);
		state = undefined;
		configRoot = "";
		releaseFileLevelIsolation();
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

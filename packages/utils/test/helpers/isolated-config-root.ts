/**
 * One implementation of "give this suite its own config root", for every package.
 *
 * Roughly a dozen suites had each written this by hand, and they had all written the same
 * WRONG version: pick a fresh dot-directory NAME (`.veyyon-<suite>-<id>`) and set
 * `VEYYON_CONFIG_DIR` to it. That is isolated from other suites, which is what each author
 * was thinking about, and it is not isolated from the DEVELOPER: the name is joined onto
 * `os.homedir()`, so the whole config root lands in the real home. Under CI that is
 * harmless because the runner hands each process a disposable `HOME`, but a bare
 * `bun test path/to/file` is how most suites are actually run while working, and there the
 * writes are real. 133 abandoned `~/.veyyon-*` directories, 1.9M, were sitting in a real
 * home when this was found, and the real-data tripwire could not see any of them: it
 * guards `~/.veyyon`, and every one of those is a SIBLING of it. It guards the siblings
 * now too, and names this helper in the refusal.
 *
 * So the root goes under `os.tmpdir()` and is reached the documented way, with a value
 * relative to the real home (`docs/internal/testing.md`). `os.homedir()` is fixed at
 * process start under Bun and does not follow a `HOME` assignment, so walking out of the
 * home with `..` is the only in-process lever there is.
 *
 * This is the imperative form, callable from a `beforeEach` and usable in any package.
 * `useIsolatedConfigRoot()` in `packages/coding-agent/test/helpers/isolated-agent-dir.ts`
 * is the file-level hook form and delegates here — the logic exists once.
 */
import { mkdirSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";
import { __resetDirsFromEnvForTests, refreshDirsFromEnv } from "../../src/dirs";
import { removeSyncWithRetries } from "../../src/temp";

/** An isolated config root in force for the current process, and the way back. */
export interface IsolatedConfigRoot {
	/** The absolute config root, inside the OS temp directory. */
	root: string;
	/** The value `VEYYON_CONFIG_DIR` was set to: relative, and it walks out of the home. */
	envValue: string;
	/** Restore every variable this changed, refresh the resolver, delete the tree. */
	restore: () => void;
}

export interface IsolatedConfigRootOptions {
	/**
	 * Also clear `VEYYON_PROFILE`, so paths resolve under the DEFAULT profile.
	 *
	 * Off by default: an active profile does not defeat the config root, it only decides
	 * which subdirectory of it is used, and several suites set a profile deliberately and
	 * assert the profile path. Turn it on when the suite wants a predictable
	 * `profiles/default/...` shape regardless of the developer's environment.
	 */
	defaultProfile?: boolean;
	/**
	 * Use this absolute directory as the config root instead of a fresh one in `os.tmpdir()`.
	 *
	 * For the caller that has already made a temp tree and wants the config root INSIDE it —
	 * `enterTempHome()` puts it under the temp home so a suite can assert "everything this
	 * process wrote is under here". The tricky parts stay here either way: the value is
	 * relative to the real home, the agent-dir override is cleared, and the resolver is
	 * refreshed. `restore()` does NOT delete a directory it did not create.
	 */
	root?: string;
}

/**
 * The XDG base directories, which OUTRANK the config root for the categories that use them.
 *
 * `DirResolver` resolves `data`, `state` and `cache` subdirectories under `XDG_DATA_HOME`,
 * `XDG_STATE_HOME` and `XDG_CACHE_HOME` when those are set, and only falls back to the config
 * root when they are not. So a developer who runs with `XDG_STATE_HOME` set had every
 * state-category path — `logs/`, `reports/`, `sessions/` — resolve under their REAL home
 * inside a root this helper promised was isolated, and a suite writing a report bundle wrote
 * it there. This is the same hole `VEYYON_CODING_AGENT_DIR` had, in a variable the helper did
 * not know about.
 *
 * Exported because a spawned CHILD process has to have them stripped too, and a second list
 * naming three of the four is how this hole existed in the first place. `hermeticSpawnEnv`
 * imports it.
 */
export const XDG_BASE_DIRS = ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"] as const;

/**
 * The variables that name veyyon's own config root, agent dir, and profile.
 *
 * Exported for the same reason as {@link XDG_BASE_DIRS}: `hermeticSpawnEnv` must remove exactly
 * this set from a child's environment, and keeping its own copy meant the two could disagree
 * about which variables can reach the developer's real tree.
 */
export const CONFIG_ROOT_ENV_KEYS = ["VEYYON_CONFIG_DIR", "VEYYON_CODING_AGENT_DIR", "VEYYON_PROFILE"] as const;

/** Every variable this helper may change, so the snapshot cannot miss one. */
const MANAGED = [...CONFIG_ROOT_ENV_KEYS, ...XDG_BASE_DIRS] as const;

/** Suffix that keeps two roots created in the same millisecond apart. */
let counter = 0;

/** Shared prefix of every root this helper creates, so stale ones can be recognised. */
const ROOT_PREFIX = "veyyon-config-root-";

/** Whether a process id is still running, used to tell a stale root from a live one. */
function pidAlive(pid: number): boolean {
	try {
		// Signal 0 performs the permission and existence check without delivering anything.
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the process exists and belongs to someone else, which still counts.
		return (error as { code?: string }).code === "EPERM";
	}
}

/**
 * Delete roots left by test processes that have since exited.
 *
 * A caller that cannot run `restore()` needs some way to not accumulate. The obvious
 * `process.once("exit", ...)` does NOT work under `bun test` — verified, the handler
 * never runs — so an exit hook is silently dead code, and one abandoned root per run
 * adds up the same way the 133 directories in a real home did. Sweeping on entry is
 * the reliable half: this process cleans up after dead ones, and a live process's root
 * is left alone because its pid still answers.
 *
 * Exported (test-only) because the real call site runs on the first entry in a
 * process, which has already happened by the time any assertion could observe it,
 * and a function with delete power must be provable rather than assumed.
 */
export function __sweepStaleRootsForTests(): void {
	sweepStaleRoots();
}

function sweepStaleRoots(): void {
	const parent = tmpdir();
	let entries: string[];
	try {
		entries = readdirSync(parent);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.startsWith(ROOT_PREFIX)) continue;
		// `veyyon-config-root-<label>-<pid>-<counter>`: the pid is the second-to-last field.
		const parts = entry.split("-");
		const pid = Number(parts[parts.length - 2]);
		if (!Number.isInteger(pid) || pid <= 0) continue;
		if (pid === process.pid || pidAlive(pid)) continue;
		try {
			removeSyncWithRetries(path.join(parent, entry));
		} catch {
			// A root another user owns, or one being removed concurrently. Leaving it is
			// correct: this sweep is opportunistic tidying, never a guarantee anyone relies on.
		}
	}
}

/**
 * Redirect this process's config root into a fresh temp directory.
 *
 * `label` names the suite and appears in the directory name, so a leftover tree in `/tmp`
 * says which suite abandoned it.
 */
export function enterIsolatedConfigRoot(label: string, options: IsolatedConfigRootOptions = {}): IsolatedConfigRoot {
	counter += 1;
	if (counter === 1) sweepStaleRoots();
	const root = options.root ?? path.join(tmpdir(), `${ROOT_PREFIX}${label}-${process.pid}-${counter}`);
	if (!path.isAbsolute(root)) {
		throw new Error(`enterIsolatedConfigRoot("${label}") needs an absolute root, got "${root}"`);
	}
	const ownsRoot = options.root === undefined;
	mkdirSync(root, { recursive: true });
	const previous = new Map<string, string | undefined>(MANAGED.map(key => [key, process.env[key]]));
	// Relative to the REAL home, which is what the variable is joined onto. Computing it
	// from anything else lands the root back inside the home this exists to protect.
	const envValue = path.relative(homedir(), root);
	process.env.VEYYON_CONFIG_DIR = envValue;
	// NOT optional, and the trap that makes this a helper rather than two lines per suite:
	// with no named profile active, `VEYYON_CODING_AGENT_DIR` WINS over the config root
	// outright in `DirResolver`. `setAgentDir` writes that variable and nothing clears it,
	// so any earlier suite in the same process that isolated its agent dir leaves it set
	// and this root is then ignored in favour of that suite's directory. The failure mode
	// is the worst kind: passes alone, fails in a full run, and blames a different file.
	delete process.env.VEYYON_CODING_AGENT_DIR;
	// Same reasoning as the line above, for the variables that outrank the config root per
	// category (see XDG_BASE_DIRS). A suite that WANTS an XDG base sets it after this call and
	// rebuilds the resolver; clearing them here is what makes "isolated" mean isolated for the
	// developer who has them set. `restore()` puts each one back exactly as it was.
	for (const key of XDG_BASE_DIRS) {
		delete process.env[key];
	}
	// The resolver caches every path it has answered, so without this it keeps serving the
	// previous root and the suite is isolated in intention only.
	if (options.defaultProfile) {
		delete process.env.VEYYON_PROFILE;
		// Deleting the variable is not enough on its own: the active profile also lives
		// in module state, and `refreshDirsFromEnv` rebuilds the resolver AROUND that
		// state rather than re-reading it. A profile left active by an earlier suite
		// would survive, and paths would resolve under `profiles/<its name>/` inside the
		// temp root — isolated from the developer, still not the default profile this
		// option promises.
		__resetDirsFromEnvForTests();
	} else {
		refreshDirsFromEnv();
	}
	return {
		root,
		envValue,
		restore: () => {
			for (const [key, value] of previous) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			// Not `refreshDirsFromEnv`: that rebuilds the resolver but keeps the
			// in-memory active profile, so a suite that called `setProfile` inside this
			// window would leave its profile active for the whole rest of the process
			// even with every variable put back. The next suite then resolves
			// `<real home>/.veyyon/profiles/<that suite's profile>/...`, because the
			// root came back and the profile did not. `__resetDirsFromEnvForTests`
			// re-derives the profile from the restored environment, which is the exact
			// "restore point after putting env vars back" it exists for.
			__resetDirsFromEnvForTests();
			// Only what this call created. A caller-supplied root belongs to that caller, which
			// removes it as part of its own tree.
			if (ownsRoot) removeSyncWithRetries(root);
		},
	};
}

/**
 * Run `body` inside an isolated config root and restore afterwards, even if it throws.
 *
 * WHY THIS EXISTS ALONGSIDE {@link enterIsolatedConfigRoot}. Entering and restoring
 * are two calls, and a throw between them skips the second. That is not a
 * hypothetical: a suite whose setup deliberately throws when isolation fails to take
 * leaked its root, `VEYYON_CONFIG_DIR`, `VEYYON_CODING_AGENT_DIR` and the active
 * profile into the whole rest of the process, and every later suite in the run
 * resolved into that suite's temp directory. A `/agents` rendering test failed on
 * wording it never set, pointing at the wrong file entirely, and the run left 42
 * roots in `/tmp`.
 *
 * That failure mode is the worst kind to debug: it passes when the file is run
 * alone, fails only in a full run, and always blames the victim rather than the
 * suite that leaked. So setup that can throw belongs inside this function rather
 * than between a manual enter/restore pair.
 *
 * The root is exposed to `body` for the isolation proofs a careful caller makes:
 * asserting that the paths it cares about really did land inside the temp root, and
 * throwing if they did not, is exactly the kind of check that used to leak.
 */
export function withIsolatedConfigRoot<T>(
	label: string,
	body: (isolated: IsolatedConfigRoot) => T,
	options: IsolatedConfigRootOptions = {},
): T {
	const isolated = enterIsolatedConfigRoot(label, options);
	let restored = false;
	const restoreOnce = () => {
		if (restored) return;
		restored = true;
		isolated.restore();
	};
	let result: T;
	try {
		result = body(isolated);
	} catch (error) {
		restoreOnce();
		throw error;
	}
	// An async body has not finished when it returns, so restoring now would pull the
	// root out from under it. Chain instead, and restore on both settlements.
	if (result instanceof Promise) {
		return result.then(
			value => {
				restoreOnce();
				return value;
			},
			(error: unknown) => {
				restoreOnce();
				throw error;
			},
		) as T;
	}
	restoreOnce();
	return result;
}

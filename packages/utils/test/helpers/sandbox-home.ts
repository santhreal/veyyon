/**
 * The sandboxed HOME every test process starts life with.
 *
 * ## What this fixes
 *
 * `packages/utils/src/env.ts` applies four `.env` layers AT MODULE SCOPE, and
 * `packages/utils/src/dotenv-home.ts` applies `$HOME/.env` earlier still. So merely
 * importing `@veyyon/utils` -- which almost every module in this repository does,
 * usually transitively -- parses the operator's `$HOME/.env`, the config-root `.env`
 * and the agent `.env` before a single test body runs. A report-only fs probe run per
 * test file measured the result: 2,829 of 4,609 test files read the real home, and
 * 2,814 of them read `$HOME/.env` itself. That is the operator's API keys, loaded by
 * a unit test for a string formatter.
 *
 * It is ONE defect with thousands of symptoms, so it gets ONE fix, here: before any
 * test module is imported, `os.homedir()` answers a fresh empty directory under the
 * tmpdir and `HOME` names the same place. Every config, credential, log and `.env`
 * path in this repository is built from one of those two, so none of them can name
 * real data any more. No production code is involved and no test file opts in.
 *
 * ## Why `os.homedir()` is patched and not just `HOME`
 *
 * Bun resolves `os.homedir()` once at process start, so assigning `process.env.HOME`
 * from inside the process moves NOTHING; a suite that believed otherwise is how three
 * rows once landed in the real credential store. The runner (`scripts/ci-test-ts.ts`)
 * can set a sandbox `HOME` at spawn time and does, but the probe above ran the way a
 * developer actually runs a suite, `bun test path/to/file`, where that prevention does
 * not exist at all. So both are done here: the env var for anything that reads `$HOME`
 * (shells, child processes), and the module function for everything in-process.
 *
 * The patch goes on the object `require("node:os")` returns, never on an ESM
 * namespace: the namespace is frozen, and under Bun both spellings hold the same
 * function objects, so patching the mutable one is visible through
 * `import * as os from "node:os"` and through `import { homedir } from "node:os"` in
 * every module loaded afterwards. `temp-dir-janitor.ts` and `real-data-tripwire.ts`
 * patch `node:fs` the same way for the same reason.
 *
 * ## Ordering
 *
 * This module is imported FIRST by `real-data-tripwire.ts`, the single preload entry
 * named by every `bunfig.toml` in the repository and passed to every spawned
 * `bun test` by `scripts/ci-test-ts.ts`. Preloads run before test modules, so the
 * redirect is in place before `@veyyon/utils` can be imported. The tripwire itself
 * must still guard the REAL home, so it takes {@link REAL_HOME} from here rather than
 * asking `os.homedir()` after the patch.
 *
 * ## The escape hatch
 *
 * A few suites are ABOUT the real home: the tripwire's own tests, and the dotenv
 * suites that assert what `$HOME/.env` resolution does. They call
 * {@link enterRealHome} and restore with {@link exitRealHome}, and
 * `scripts/tests-never-touch-real-home.test.ts` refuses that call from any file not on
 * its allowlist, so the exception stays countable and each one carries a reason.
 */

import * as path from "node:path";
import { XDG_BASE_ENV_KEYS } from "../../src/dir-env-keys";

/**
 * `node:os` through `require`, and NEVER through `import * as os from "node:os"`.
 *
 * This is the whole mechanism, so it is worth stating exactly. Under Bun the ESM
 * namespace for a builtin is snapshotted the first time the module is ESM-imported
 * ANYWHERE in the process, and it is frozen. Patch the mutable `require` object first
 * and every later `import * as os` and `import { homedir }` sees the patch; let a
 * single ESM import happen first and the patch is invisible everywhere, silently. An
 * earlier draft of this file wrote `import * as os` purely to read `os.homedir()` for
 * {@link REAL_HOME}, and the redirect did nothing at all: `process.env.HOME` moved and
 * `os.homedir()` still answered the operator's home.
 *
 * That is also why no module in the preload graph may ESM-import `node:os`; the graph
 * walk in `scripts/tests-never-touch-real-home.test.ts` fails when one does.
 */
const osModule = require("node:os") as {
	homedir: () => string;
	tmpdir: () => string;
	userInfo: (options?: unknown) => { homedir: string };
} & Record<string, unknown>;

/** `node:fs` through `require`, for the same reason, and so the janitor's later wrap is seen. */
const fsModule = require("node:fs") as {
	mkdirSync: (dir: string, options: { recursive: boolean }) => void;
	rmSync: (dir: string, options: { recursive: boolean; force: boolean }) => void;
};

/** Env var by which the runner names the real config root it redirected away from. */
const REAL_CONFIG_ROOT_ENV = "VEYYON_TEST_REAL_CONFIG_ROOT";

/** Set to `1` by a disposable CI runner doing a real install, which needs the real home. */
const DISABLE_ENV = "VEYYON_ALLOW_REAL_HOME";

/**
 * The home this process started with, captured BEFORE the redirect below.
 *
 * Read from `os.homedir()` while it is still honest. `scripts/ci-test-ts.ts` may have
 * already handed this process a sandbox `HOME` at spawn time, in which case what is
 * captured is that sandbox and the operator's real home is named by
 * {@link REAL_CONFIG_ROOT_ENV}; the tripwire prefers the declared value for exactly
 * that reason.
 */
export const REAL_HOME: string = path.resolve(osModule.homedir());

/**
 * True when `scripts/ci-test-ts.ts` spawned this process and already redirected `HOME`.
 *
 * It says so by naming the real config root, which is a thing only the runner knows once
 * `HOME` has moved. There is no other producer of this variable.
 */
const RUNNER_REDIRECTED = Boolean(process.env[REAL_CONFIG_ROOT_ENV]);

/**
 * The sandbox this process lives in, or `undefined` when the redirect is disabled.
 *
 * UNDER THE RUNNER THIS IS THE RUNNER'S SANDBOX, not a new directory, and that matters
 * three ways. The runner shares ONE home across every chunk of a run, so minting a
 * per-process home instead would restage the ~290 MB native addon into a few hundred
 * separate directories. `scanLiveVeyyonOwnership` in the runner attributes a child
 * process to the test run by matching `HOME=<its sandbox>` in `/proc`, so moving `HOME`
 * underneath it would make every test-owned process look external. And the runner
 * removes its sandbox itself on exit. Adopting it is also free: Bun resolved
 * `os.homedir()` from that same `HOME` at process start, so the patch below is a no-op
 * in value and still necessary in form, because a suite may have spied on `homedir`.
 *
 * OTHERWISE, which is every bare `bun test path/to/file`, it is one fresh directory per
 * process, named by pid: the process is the isolation unit, because `os.homedir()` is
 * process-wide and `bun test` runs many files in one process. The `veyyon-` prefix is the
 * one `temp-dir-janitor.ts` sweeps, so a home stranded by a hard kill is collected later.
 */
export const TEMP_HOME: string | undefined = ((): string | undefined => {
	if (process.env[DISABLE_ENV] === "1") return undefined;
	if (RUNNER_REDIRECTED) return REAL_HOME;
	const dir = path.join(osModule.tmpdir(), `veyyon-test-home-${process.pid}`);
	fsModule.mkdirSync(dir, { recursive: true });
	return dir;
})();

/** Installed by the block below; no-ops when the redirect is disabled. */
let applyTempHome: (() => void) | undefined;
let applyRealHome: (() => void) | undefined;

/**
 * Point an inherited directory override away from the real home.
 *
 * A developer's environment routinely carries `XDG_CONFIG_HOME=$HOME/.config`, and a
 * redirect that moved `os.homedir()` while leaving those variables alone would send
 * every XDG-derived path back into the real home, including
 * `~/.config/gcloud/application_default_credentials.json`, which the probe caught 13
 * files reading. Only a value that actually sits inside the real home is rewritten; a
 * value already pointing at a temp root is a deliberate choice by the runner.
 */
function redirectInheritedOverride(key: string, tempHome: string): void {
	const value = process.env[key];
	if (!value) return;
	const resolved = path.resolve(value);
	const rel = path.relative(REAL_HOME, resolved);
	if (rel !== "" && (path.isAbsolute(rel) || rel === ".." || rel.startsWith(`..${path.sep}`))) return;
	process.env[key] = rel === "" ? tempHome : path.join(tempHome, rel);
}

if (TEMP_HOME !== undefined) {
	const tempHome = TEMP_HOME;
	const realHomedir = osModule.homedir;
	const realUserInfo = osModule.userInfo;

	applyTempHome = (): void => {
		osModule.homedir = (): string => tempHome;
		// `os.userInfo().homedir` is the second spelling of the same question, and the
		// static gate already treats the two as one.
		osModule.userInfo = (options?: unknown): { homedir: string } => ({
			...realUserInfo.call(osModule, options),
			homedir: tempHome,
		});
		process.env.HOME = tempHome;
		// Windows spelling, harmless elsewhere and cheaper than branching on platform.
		process.env.USERPROFILE = tempHome;
	};
	applyRealHome = (): void => {
		osModule.homedir = realHomedir;
		osModule.userInfo = realUserInfo;
		process.env.HOME = REAL_HOME;
		process.env.USERPROFILE = REAL_HOME;
	};

	// Name the real config root for the tripwire, and for every child process a test
	// spawns, BEFORE `HOME` stops being able to answer the question. Without this a
	// child started from a sandboxed home would guard the sandbox and let a real write
	// through.
	if (!process.env[REAL_CONFIG_ROOT_ENV]) {
		process.env[REAL_CONFIG_ROOT_ENV] = path.join(REAL_HOME, ".veyyon");
	}

	// Only when this module minted the sandbox. Under the runner these were already done
	// at spawn time, against the same values, and the sandbox is the runner's to remove.
	if (!RUNNER_REDIRECTED) {
		for (const key of XDG_BASE_ENV_KEYS) redirectInheritedOverride(key, tempHome);
		// Not an XDG base, but the same hazard: an operator with this exported points the
		// agent dir at the real tree whatever `os.homedir()` now says.
		redirectInheritedOverride("VEYYON_CODING_AGENT_DIR", tempHome);

		process.on("exit", () => {
			try {
				fsModule.rmSync(tempHome, { recursive: true, force: true });
			} catch {
				// A sandbox that cannot be removed is not worth noise at the very end of a run;
				// the janitor's age-bounded sweep collects it on the next one.
			}
		});
	}

	applyTempHome();
}

/**
 * Put the operator's real home back for the duration of one suite.
 *
 * ONLY for suites whose subject IS the real home: the tripwire's own tests, which have
 * to prove a write into it is refused, and the dotenv suites, which assert what
 * `$HOME/.env` resolution does. Every caller must appear on the allowlist in
 * `scripts/tests-never-touch-real-home.test.ts` with a stated reason, and must pair
 * this with {@link exitRealHome}. Reads only: the tripwire is still installed and
 * still refuses every write.
 */
export function enterRealHome(): void {
	applyRealHome?.();
}

/** Undo {@link enterRealHome}, returning the process to its sandbox home. */
export function exitRealHome(): void {
	applyTempHome?.();
}

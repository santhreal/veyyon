/**
 * The tripwire that makes it IMPOSSIBLE for the test suite to write to the
 * developer's real veyyon data, rather than merely asking it not to.
 *
 * This file is loaded by `bunfig.toml`'s `[test] preload`, so it runs in EVERY
 * test process before a single test module is imported. Nothing opts in, and
 * nothing can forget to call it. That property is the entire point: the previous
 * protection was a helper each suite had to remember to invoke, and a suite that
 * did not invoke it wrote three rows into the real credential store while every
 * assertion passed.
 *
 * ## Why a tripwire is needed on top of a sandboxed HOME
 *
 * The test runner already hands every child process a disposable `HOME`
 * (`scripts/ci-test-ts.ts`, `buildChildEnv`), which is the real prevention: with
 * a temp home, `os.homedir()` — the value every config path is built from —
 * cannot name real data in the first place. The tripwire covers what prevention
 * cannot:
 *
 *  - a test that hardcodes an absolute path into the real home,
 *  - a test process started WITHOUT the runner (a bare `bun test path/to/file`,
 *    which is how most of them are actually run during development),
 *  - a test that restores the real `HOME` from a saved value in `afterEach`.
 *
 * In all three, prevention is gone and only detection is left. So this fails
 * CLOSED and LOUDLY at the moment of the write, naming the offending path, with
 * the write NOT performed.
 *
 * ## What is intercepted
 *
 * Every mutating `node:fs` entry point (sync, callback and promise forms) plus
 * `bun:sqlite`'s `Database`, because the incident's damage went through SQLite's
 * NATIVE file handling and never touched a JS `fs` call at all. A tripwire that
 * only wrapped `fs` would have watched the exact write it was built to stop.
 *
 * Reads are deliberately NOT blocked: a test reading the real home is at worst
 * non-hermetic, and blocking reads would break legitimate suites that inspect
 * the developer's git config. Only mutation is forbidden.
 *
 * ## Why the temp-directory janitor is imported here
 *
 * It is the second protection that has to run in every test process and must not be
 * opt-in, and this file is the only entry the preload list names. Bun reads `bunfig.toml`
 * from the cwd only, so each of the eighteen packages carries its own pointer to this
 * path and `scripts/ci-test-ts.ts` passes it with `--preload`; a second preload entry
 * would be twenty more places to keep in step and one more thing to forget. It is
 * imported FIRST so it captures `fs.rmSync` before the wrapping below replaces it.
 */

import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { installTempDirJanitor } from "./temp-dir-janitor";

// Capture the read-only primitives before the CJS export object is patched below.
// Importing `node:fs` as an ESM namespace here would cache unguarded bindings for
// every test module that imports it later.
const unpatchedFs = require("node:fs") as {
	constants: {
		O_CREAT: number;
		O_RDWR: number;
		O_TRUNC: number;
		O_WRONLY: number;
	};
	lstatSync(target: string): { isSymbolicLink(): boolean };
	readlinkSync(target: string): string;
	realpathSync: { native(target: string): string };
};
const rawLstatSync = unpatchedFs.lstatSync;
const rawReadlinkSync = unpatchedFs.readlinkSync;
const rawRealpathSync = unpatchedFs.realpathSync.native;
const NUMERIC_OPEN_MUTATION_FLAGS =
	unpatchedFs.constants.O_WRONLY |
	unpatchedFs.constants.O_RDWR |
	unpatchedFs.constants.O_CREAT |
	unpatchedFs.constants.O_TRUNC;

/** Env var by which the test runner names the real config root it redirected away from. */
export const REAL_CONFIG_ROOT_ENV = "VEYYON_TEST_REAL_CONFIG_ROOT";

/** Escape hatch for the one legitimate case: a disposable CI runner doing a real install. */
const DISABLE_ENV = "VEYYON_ALLOW_REAL_DATA_WRITES";

/**
 * Directories no test may write into, resolved absolute.
 *
 * The runner passes the pre-redirect value explicitly, because once `HOME` is a
 * sandbox the process can no longer work out what the real home was: Bun's
 * `os.homedir()` AND `os.userInfo().homedir` both follow `HOME`, so there is no
 * in-process way back to it. When the var is absent (a bare `bun test`), the
 * current home is the real one and is used directly.
 */
function forbiddenRoots(): string[] {
	const roots = new Set<string>();
	const declared = process.env[REAL_CONFIG_ROOT_ENV];
	if (declared) roots.add(path.resolve(declared));
	else {
		const home = os.homedir();
		if (home) roots.add(path.resolve(home, ".veyyon"));
	}
	return [...roots];
}

const FORBIDDEN = forbiddenRoots();
const ENABLED = process.env[DISABLE_ENV] !== "1" && FORBIDDEN.length > 0;

/**
 * The real home directory, for the sibling rule below.
 *
 * Derived from the declared config root rather than from `os.homedir()` whenever the
 * runner provided one, for the reason above: with a sandboxed `HOME` there is no
 * in-process way back to the real home.
 */
const REAL_HOME = ((): string | undefined => {
	const declared = process.env[REAL_CONFIG_ROOT_ENV];
	if (declared) return path.dirname(path.resolve(declared));
	const home = os.homedir();
	return home ? path.resolve(home) : undefined;
})();

/** True when `candidate` is inside `root` (or is `root` itself). */
function isInside(candidate: string, root: string): boolean {
	const rel = path.relative(root, candidate);
	return rel === "" || (!path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`));
}

/**
 * Resolve an fs path argument to an absolute path, or `undefined` when it is a
 * form we cannot evaluate (a file descriptor, say, which cannot name a new path).
 */
function resolveTarget(target: unknown): string | undefined {
	if (typeof target === "string") return path.resolve(target);
	if (target instanceof URL) return path.resolve(fileURLToPath(target));
	if (Buffer.isBuffer(target)) return path.resolve(target.toString());
	return undefined;
}

/**
 * Errors that prove the current leaf cannot be resolved but say nothing unsafe
 * about its nearest existing ancestor.
 *
 * `ENAMETOOLONG` belongs here for the same reason as `ENOENT`: the kernel cannot
 * look up that leaf, so peel it into the preserved suffix and keep resolving the
 * parent. This does not allow a symlink bypass. Every accessible ancestor is
 * still canonicalized before the suffix is reattached, while the original
 * mutation still reaches the kernel and receives its native `ENAMETOOLONG`.
 */
function isUnresolvedLeaf(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException).code;
	return code === "ENOENT" || code === "ENAMETOOLONG";
}

/**
 * Resolve symlinks while preserving a suffix whose entries do not exist yet.
 *
 * `realpath` alone cannot resolve a dangling symlink aimed at a missing protected
 * descendant. When that happens, inspect the symlink itself, follow its target,
 * and resume with the missing suffix. Unexpected filesystem errors propagate so
 * callers can fail closed.
 */
function resolveForContainment(target: string): string {
	let cursor = path.resolve(target);
	let suffix: string[] = [];
	let symlinkExpansions = 0;
	let concurrentRetries = 0;
	for (;;) {
		try {
			const resolved = rawRealpathSync(cursor);
			return path.join(resolved, ...suffix);
		} catch (error) {
			if (!isUnresolvedLeaf(error)) throw error;
		}

		try {
			const stat = rawLstatSync(cursor);
			if (!stat.isSymbolicLink()) {
				concurrentRetries += 1;
				if (concurrentRetries > 8) {
					throw Object.assign(new Error(`path kept changing while resolving "${cursor}"`), {
						code: "EBUSY",
					});
				}
				continue;
			}
			concurrentRetries = 0;
			symlinkExpansions += 1;
			if (symlinkExpansions > 40) {
				throw Object.assign(new Error(`too many symlink expansions while resolving "${target}"`), {
					code: "ELOOP",
				});
			}
			const link = rawReadlinkSync(cursor);
			cursor = path.join(path.resolve(path.dirname(cursor), link), ...suffix);
			suffix = [];
			concurrentRetries = 0;
		} catch (error) {
			if (!isUnresolvedLeaf(error)) throw error;
			const parent = path.dirname(cursor);
			if (parent === cursor) throw error;
			suffix.unshift(path.basename(cursor));
			cursor = parent;
			concurrentRetries = 0;
		}
	}
}

/** Lexical containment plus filesystem-resolved containment for symlink aliases. */
function isInsideResolved(candidate: string, root: string): boolean {
	if (isInside(candidate, root)) return true;
	return isInside(resolveForContainment(candidate), resolveForContainment(root));
}

/**
 * Whether `resolved` is a `.veyyon`-SIBLING directory sitting directly in the real home.
 *
 * Checked after the forbidden roots, not before: `~/.veyyon` itself matches this shape, and
 * a write there deserves the original message about resolving through a temp root, not the
 * one below about inventing a config-dir name.
 *
 * The forbidden-roots check above guards `~/.veyyon` and nothing else, and about a dozen
 * suites used to isolate themselves by inventing a SIBLING of it: set
 * `VEYYON_CONFIG_DIR` to a fresh `.veyyon-<suite>-<id>` name, which is joined onto
 * `os.homedir()`. That isolates them from each other and not from the developer, and the
 * tripwire could not see a single one of those writes. 133 abandoned directories, 1.9M,
 * were found in a real home this way.
 *
 * They all use `enterIsolatedConfigRoot` now, and this closes the door behind them: any
 * `~/.veyyon*` path is refused, so the pattern cannot be reintroduced by someone copying
 * an older suite. Only the FIRST segment under the home is examined, so a temp root that
 * merely happens to contain the word is unaffected.
 */
function isVeyyonSiblingInRealHome(resolved: string): boolean {
	if (!REAL_HOME) return false;
	const rel = path.relative(REAL_HOME, resolved);
	if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return false;
	const first = rel.split(path.sep)[0] ?? "";
	return first.startsWith(".veyyon");
}

/** Throw if `target` names anything inside a forbidden root. */
function assertNotRealData(operation: string, target: unknown): void {
	if (!ENABLED) return;
	let resolved: string | undefined;
	try {
		resolved = resolveTarget(target);
	} catch (cause) {
		throw new Error(`REAL-DATA TRIPWIRE: refusing ${operation} because its target could not be resolved safely.`, {
			cause,
		});
	}
	if (!resolved) return;
	for (const root of FORBIDDEN) {
		let inside: boolean;
		try {
			inside = isInsideResolved(resolved, root);
		} catch (cause) {
			throw new Error(
				`REAL-DATA TRIPWIRE: refusing ${operation} on "${resolved}" because symlink containment could not be verified safely.`,
				{ cause },
			);
		}
		if (!inside) continue;
		throw new Error(
			`REAL-DATA TRIPWIRE: refusing ${operation} on "${resolved}".\n` +
				`That path is inside the real veyyon data directory ("${root}"), which no test may modify — ` +
				`this is the guard that exists because a test once wrote credentials into it.\n` +
				`Fix the TEST, never this guard: resolve paths through a temp root (see destructive-guard.ts), ` +
				`and remember that assigning process.env.HOME does NOT redirect os.homedir() in Bun — ` +
				`it is resolved once at process start.`,
		);
	}
	let isSibling: boolean;
	try {
		isSibling = isVeyyonSiblingInRealHome(resolved) || isVeyyonSiblingInRealHome(resolveForContainment(resolved));
	} catch (cause) {
		throw new Error(
			`REAL-DATA TRIPWIRE: refusing ${operation} on "${resolved}" because its real-home containment could not be verified safely.`,
			{ cause },
		);
	}
	if (isSibling) {
		throw new Error(
			`REAL-DATA TRIPWIRE: refusing ${operation} on "${resolved}".\n` +
				`That is a veyyon config root in the real home directory ("${REAL_HOME}"). Setting ` +
				`VEYYON_CONFIG_DIR to a fresh directory NAME isolates a suite from other suites and not ` +
				`from the developer: the name is joined onto os.homedir(), which does not follow a HOME ` +
				`assignment in Bun. It left 133 abandoned directories in a real home.\n` +
				`Fix the TEST: call enterIsolatedConfigRoot() from ` +
				`packages/utils/test/helpers/isolated-config-root.ts, which puts the root in a temp ` +
				`directory and reaches it with a relative value.`,
		);
	}
}

/** Mutating `node:fs` functions whose FIRST argument is the path being changed. */
const FIRST_ARG_MUTATORS = [
	"writeFile",
	"writeFileSync",
	"appendFile",
	"appendFileSync",
	"truncate",
	"truncateSync",
	"unlink",
	"unlinkSync",
	"rm",
	"rmSync",
	"rmdir",
	"rmdirSync",
	"mkdir",
	"mkdirSync",
	"mkdtemp",
	"mkdtempSync",
	"chmod",
	"chmodSync",
	"chown",
	"chownSync",
	"utimes",
	"utimesSync",
	"createWriteStream",
] as const;

/** Operations that mutate or remove both paths. */
const BOTH_PATH_MUTATORS = ["rename", "renameSync", "link", "linkSync"] as const;

/** Copy/link operations whose source is read-only and only destination mutates. */
const DESTINATION_MUTATORS = ["copyFile", "copyFileSync", "cp", "cpSync", "symlink", "symlinkSync"] as const;

/**
 * Marker set on every wrapped function.
 *
 * Callers need to distinguish "the tripwire module was loaded" from "the function
 * I am about to call is actually guarded", and those are NOT the same thing. The
 * patch rewrites the `node:fs` CJS exports, so a module that already evaluated
 * `import * as fs from "node:fs"` before the patch ran keeps binding the original
 * functions. That happens whenever the tripwire loads late instead of as a
 * preload, and it makes the guard silently ineffective. Anything that performs a
 * deliberate probe must check this marker on the exact function it will call.
 */
export const GUARDED_MARKER = "__veyyonRealDataGuarded";

/** True when `candidate` is the wrapped, guarding version of an fs function. */
export function isGuarded(candidate: unknown): boolean {
	return typeof candidate === "function" && (candidate as unknown as Record<string, unknown>)[GUARDED_MARKER] === true;
}

/** Wrap one function on `target` so the guarded argument is checked first. */
function wrap(target: Record<string, unknown>, name: string, argIndexes: number[]): void {
	const original = target[name];
	if (typeof original !== "function") return;
	const fn = original as (...args: unknown[]) => unknown;
	const guarded = function guarded(this: unknown, ...args: unknown[]) {
		for (const index of argIndexes) assertNotRealData(`fs.${name}`, args[index]);
		return fn.apply(this, args);
	};
	(guarded as unknown as Record<string, unknown>)[GUARDED_MARKER] = true;
	target[name] = guarded;
}

/**
 * `fs.open`/`openSync` are only a mutation when opened with a writing flag, so
 * they are checked separately — blocking read opens would break suites that
 * legitimately inspect real files.
 */
function wrapOpen(target: Record<string, unknown>, name: string): void {
	const original = target[name];
	if (typeof original !== "function") return;
	const fn = original as (...args: unknown[]) => unknown;
	const numericMutationFlags = NUMERIC_OPEN_MUTATION_FLAGS;
	const guarded = function guardedOpen(this: unknown, ...args: unknown[]) {
		const flags = args[1];
		const writing =
			typeof flags === "number"
				? (flags & numericMutationFlags) !== 0
				: typeof flags !== "string" || /[wax+]/.test(flags);
		if (writing) assertNotRealData(`fs.${name}`, args[0]);
		return fn.apply(this, args);
	};
	(guarded as unknown as Record<string, unknown>)[GUARDED_MARKER] = true;
	target[name] = guarded;
}

function installFsTripwire(): void {
	const fs = require("node:fs") as Record<string, unknown>;
	for (const name of FIRST_ARG_MUTATORS) wrap(fs, name, [0]);
	for (const name of BOTH_PATH_MUTATORS) wrap(fs, name, [0, 1]);
	for (const name of DESTINATION_MUTATORS) wrap(fs, name, [1]);
	wrapOpen(fs, "open");
	wrapOpen(fs, "openSync");

	const promises = fs.promises as Record<string, unknown> | undefined;
	if (promises) {
		for (const name of FIRST_ARG_MUTATORS) wrap(promises, name, [0]);
		for (const name of BOTH_PATH_MUTATORS) wrap(promises, name, [0, 1]);
		for (const name of DESTINATION_MUTATORS) wrap(promises, name, [1]);
		wrapOpen(promises, "open");
	}
}

/**
 * Guard `bun:sqlite`. This is the one that matters most: the incident's writes
 * were SQLite `INSERT`s through a native handle, invisible to any `fs` wrapper.
 * Opening a database is treated as a mutation because SQLite creates the file
 * (and its `-wal`/`-shm` siblings) on open unless explicitly read-only.
 */
function installSqliteTripwire(): void {
	if (!ENABLED) return;
	const sqlite = require("bun:sqlite") as { Database?: new (...args: never[]) => unknown };
	const Original = sqlite.Database;
	if (typeof Original !== "function") return;

	class GuardedDatabase extends (Original as new (...args: unknown[]) => object) {
		constructor(...args: unknown[]) {
			const [filename, options] = args;
			const readonly =
				options === true ||
				(typeof options === "object" && options !== null && (options as { readonly?: boolean }).readonly === true);
			if (!readonly) assertNotRealData("sqlite open (creates/writes the db)", filename);
			super(...args);
		}
	}
	sqlite.Database = GuardedDatabase as unknown as new (...args: never[]) => unknown;
}

// Before the wrapping below, so the janitor captures the real `fs.rmSync`, and OUTSIDE the
// `ENABLED` gate: a run with the tripwire disabled still has to clean up after itself.
installTempDirJanitor();

if (ENABLED) {
	installFsTripwire();
	installSqliteTripwire();
}

/** Exported for the tripwire's own tests; the preload path calls it via module load. */
export const __tripwire = {
	assertNotRealData,
	forbiddenRoots,
	isInside,
	resolveTarget,
	resolveForContainment,
	isInsideResolved,
	isGuarded,
	ENABLED,
	FORBIDDEN,
};

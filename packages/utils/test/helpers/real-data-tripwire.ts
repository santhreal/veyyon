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
 * Every test process now starts with a disposable `HOME`, and that is the real
 * prevention: with a temp home, `os.homedir()` -- the value every config path is
 * built from -- cannot name real data in the first place. It comes from two places.
 * `scripts/ci-test-ts.ts` (`buildChildEnv`) sets it at spawn time for a full run, and
 * `./sandbox-home`, imported below, sets it in-process for every other way a suite gets
 * started, including the bare `bun test path/to/file` that is how most of them are
 * actually run during development. That second one used not to exist, and its absence
 * is what let 2,829 of 4,609 test files read the operator's real home.
 *
 * The tripwire covers what prevention cannot:
 *
 *  - a test that hardcodes an absolute path into the real home,
 *  - a test that restores the real `HOME` from a saved value in `afterEach`,
 *  - a suite on the `enterRealHome` allowlist, which is deliberately back in the real
 *    home and must still be unable to write to it.
 *
 * In all three, prevention is gone or suspended and only detection is left. So this
 * fails CLOSED and LOUDLY at the moment of the write, naming the offending path, with
 * the write NOT performed.
 *
 * ## What is intercepted
 *
 * Every mutating `node:fs` entry point (sync, callback and promise forms) plus
 * `bun:sqlite`'s `Database`, because the incident's damage went through SQLite's
 * NATIVE file handling and never touched a JS `fs` call at all. A tripwire that
 * only wrapped `fs` would have watched the exact write it was built to stop.
 *
 * Reads are NOT blocked, and the reason has changed. It used to be argued that a
 * test reading the real home is "at worst non-hermetic". That was wrong, and it is
 * why nobody went looking: `$HOME/.env` is a READ, and it holds the operator's API
 * keys. A probe measured 2,814 test files parsing it, every one of them through the
 * module-scope dotenv load in `packages/utils/src/env.ts`. What makes reads safe to
 * permit now is not their nature but PREVENTION: `./sandbox-home`, imported below, has
 * already moved `os.homedir()` and `HOME` to an empty per-process sandbox by the time
 * any test module loads, so a path built from home does not name real data and there
 * is nothing to read. Blocking reads outright would still be wrong, because it would
 * break the suites that legitimately inspect the developer's git config, and because
 * failing a read is worse feedback than reading an empty sandbox. What is forbidden
 * here remains mutation, which prevention cannot cover: a hardcoded absolute path
 * into the real home reaches it whatever `os.homedir()` says.
 *
 * ## Why the home redirect and the temp-directory janitor are imported here
 *
 * They are the other two protections that have to run in every test process and must
 * not be opt-in, and this file is the only entry the preload list names. Bun reads
 * `bunfig.toml` from the cwd only, so each of the eighteen packages carries its own
 * pointer to this path and `scripts/ci-test-ts.ts` passes it with `--preload`; a
 * second preload entry would be twenty more places to keep in step and one more thing
 * to forget.
 *
 * ORDER AMONG THE FOUR IMPORTS BELOW does not matter, and that is an invariant rather
 * than a happy accident. `./sandbox-home` moves `os.homedir()` by patching the object
 * `require("node:os")` returns, and under Bun that patch is only visible to later
 * importers if it happens before the FIRST `import * as os from "node:os"` anywhere in
 * this graph -- the namespace is materialized for the whole graph up front and frozen.
 * `./temp-dir-janitor` used to contain exactly that import, and it silently disabled
 * the redirect: `HOME` moved, `os.homedir()` did not, and every config path is built
 * from `os.homedir()`. It now takes `node:os` through `require` like everything else
 * here, so no module in this graph holds an ESM `node:os` binding and the formatter is
 * free to sort. `scripts/tests-never-touch-real-home.test.ts` walks this graph and
 * fails if one reappears, which is what keeps the invariant from being re-broken.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
// For its side effect as much as its export: `os.homedir()` and `HOME` name an empty
// per-process sandbox from here on, so nothing loaded afterwards can build a path into
// real data. The export is the home as it was BEFORE that move, which is the one thing
// this file cannot ask `os` for once the move has happened.
import { REAL_HOME as PRE_REDIRECT_HOME } from "./sandbox-home";
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
 * NEVER from `os.homedir()`, which `./sandbox-home` has already redirected by the time
 * this runs, and which the runner may have redirected at spawn time before that. Both
 * spellings, `os.homedir()` and `os.userInfo().homedir`, answer the sandbox, so there
 * is no in-process way back to the real home once either redirect has happened. The
 * value comes from the runner's `REAL_CONFIG_ROOT_ENV` when it set one, and otherwise
 * from the home `./sandbox-home` captured before moving it.
 */
function forbiddenRoots(): string[] {
	const roots = new Set<string>();
	const declared = process.env[REAL_CONFIG_ROOT_ENV];
	if (declared) roots.add(path.resolve(declared));
	else if (PRE_REDIRECT_HOME) roots.add(path.resolve(PRE_REDIRECT_HOME, ".veyyon"));
	return [...roots];
}

const FORBIDDEN = forbiddenRoots();
const ENABLED = process.env[DISABLE_ENV] !== "1" && FORBIDDEN.length > 0;

/**
 * The real home directory, for the sibling rule below.
 *
 * Derived from the declared config root when the runner provided one, and otherwise
 * from the pre-redirect home, for the reason above.
 */
const REAL_HOME = ((): string | undefined => {
	const declared = process.env[REAL_CONFIG_ROOT_ENV];
	if (declared) return path.dirname(path.resolve(declared));
	return PRE_REDIRECT_HOME ? path.resolve(PRE_REDIRECT_HOME) : undefined;
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

/**
 * Guard Bun's OWN write surface, which does not go through `node:fs` at all.
 *
 * Measured against the version of this file that hooked only `node:fs` and `bun:sqlite`:
 * `Bun.write`, `Bun.file(p).write()` and `Bun.file(p).writer()` each created a file
 * inside the forbidden root with no error raised. A tripwire that watches one door is
 * theatre, and these three are the doors this repository's own code reaches for most --
 * `Bun.write` is the idiomatic spelling here, so the guard was blind to the writes most
 * likely to be written.
 *
 * `BunFile.write`/`writer` are patched on the PROTOTYPE, which is where they live: there
 * is no constructor to subclass the way `bun:sqlite`'s `Database` allows, and `Bun.file`
 * itself only names the file. Both properties are writable and non-configurable, so
 * assignment is the only available move; `Object.defineProperty` on them throws.
 */
function installBunWriteTripwire(): void {
	// Named consts, not inline assertions: both are the "compiler lost track of a
	// well-known in-process value" case. `Bun` is typed as a namespace with no index
	// signature, and `BunFile`'s prototype is not a declared type at all.
	const bun: Record<string, unknown> = Bun as unknown as Record<string, unknown>;
	const originalWrite = bun.write;
	if (typeof originalWrite === "function") {
		const fn = originalWrite as (...args: unknown[]) => unknown;
		const guarded = function guardedBunWrite(this: unknown, ...args: unknown[]) {
			assertNotRealData("Bun.write", args[0]);
			return fn.apply(this, args);
		};
		(guarded as unknown as Record<string, unknown>)[GUARDED_MARKER] = true;
		bun.write = guarded;
	}

	// `Bun.file` only NAMES a path; it neither opens nor creates, so this probe touches
	// nothing on disk and exists solely to reach the prototype the write methods live on.
	const proto: Record<string, unknown> = Object.getPrototypeOf(Bun.file("/veyyon-tripwire-probe"));
	for (const name of ["write", "writer", "unlink", "delete"] as const) {
		const original = proto[name];
		if (typeof original !== "function") continue;
		const fn = original as (...args: unknown[]) => unknown;
		const guarded = function guardedBunFile(this: { name?: string }, ...args: unknown[]) {
			// The path is on the RECEIVER, not in the arguments: `Bun.file(p).write(data)`
			// puts `p` in `this.name`. Reading it off the argument list, as every other
			// wrapper here does, would guard nothing at all.
			assertNotRealData(`Bun.file().${name}`, this?.name);
			return fn.apply(this, args);
		};
		(guarded as unknown as Record<string, unknown>)[GUARDED_MARKER] = true;
		proto[name] = guarded;
	}
}

/**
 * Guard child processes, which reach the filesystem with none of this process's patches.
 *
 * `sh -c 'printf x > ~/.veyyon/leaked'` was measured writing straight through every
 * guard above, and so were `Bun.spawn`, `Bun.spawnSync`, `Bun.$` and all six
 * `node:child_process` entry points. A child gets a fresh address space; nothing patched
 * here travels into it.
 *
 * BE CLEAR ABOUT WHAT THIS IS. It inspects the argv, the shell string and the `cwd` for a
 * forbidden path and refuses the spawn before it happens. That catches the realistic
 * shape -- a test that names the path it means to write -- and it CANNOT catch a child
 * that computes the path itself, reads it from a file, or expands `$HOME` in its own
 * shell. Containment of a child process is not something a JS wrapper can promise; that
 * is the kernel boundary's job, and `packages/utils/test/helpers/sandbox-gate.ts` refuses
 * to start without one. This layer exists so the common case fails at the call site with
 * a message naming the test, rather than silently succeeding on a machine whose sandbox
 * turned out to be weaker than believed.
 */
function installSpawnTripwire(): void {
	// The needles, precomputed once. NOT the real home itself: this repository's own test
	// children are spawned as `<realHome>/.bun/bin/bun`, so refusing every argument that
	// merely mentions the home would refuse every spawn in the suite. What is forbidden is
	// a path into veyyon DATA, which is the config roots and their siblings, plus the
	// unexpanded `~/.veyyon` a shell string would carry.
	const needles = [...FORBIDDEN];
	if (REAL_HOME) needles.push(path.join(REAL_HOME, ".veyyon"));
	needles.push("~/.veyyon");

	const inspect = (operation: string, args: readonly unknown[]): void => {
		for (const arg of args) {
			if (typeof arg === "string") {
				for (const needle of needles) if (arg.includes(needle)) assertNotRealData(operation, needle);
				continue;
			}
			if (Array.isArray(arg)) {
				inspect(operation, arg);
				continue;
			}
			if (typeof arg !== "object" || arg === null) continue;
			// Narrowed with `in` rather than asserted: these are ordinary spawn options
			// objects whose shape differs between Bun and node:child_process, and the two
			// fields read here are the only ones that can name a path.
			if ("cwd" in arg && typeof arg.cwd === "string") assertNotRealData(`${operation} cwd`, arg.cwd);
			if ("cmd" in arg && Array.isArray(arg.cmd)) inspect(operation, arg.cmd);
		}
	};

	/**
	 * `node:util.promisify` does not use the callback convention on these. Each
	 * `child_process` entry point carries a `util.promisify.custom` hook that
	 * resolves to `{ stdout, stderr }`, and a wrapper that does not carry it
	 * forward sends `promisify` down the callback path instead, where it resolves
	 * with the first callback value alone. Production code written as
	 *
	 *     const { stdout } = await promisify(execFile)(...)
	 *
	 * then destructures `stdout` off a bare string and gets `undefined`, silently,
	 * only under test. `scripts/release-ship.ts` is written exactly that way, and
	 * its `JSON.parse(stdout)` failed with `Unexpected identifier "undefined"`
	 * against a stub that had printed valid JSON.
	 *
	 * So the hook is re-created rather than copied. Copying the original's hook
	 * would restore the behaviour and lose the guard, because `promisify` would
	 * then call the UNWRAPPED original and no argument would ever be inspected.
	 */
	const guardSpawns = (target: Record<string, unknown>, label: string, names: readonly string[]): void => {
		for (const name of names) {
			const original = target[name];
			if (typeof original !== "function") continue;
			const fn = original as (...args: unknown[]) => unknown;
			const guarded = function guardedSpawn(this: unknown, ...args: unknown[]) {
				inspect(`${label}.${name}`, args);
				return fn.apply(this, args);
			};
			const custom = (fn as unknown as Record<symbol, unknown>)[promisify.custom];
			if (typeof custom === "function") {
				const customFn = custom as (...args: unknown[]) => unknown;
				(guarded as unknown as Record<symbol, unknown>)[promisify.custom] = function guardedPromisified(
					this: unknown,
					...args: unknown[]
				) {
					inspect(`${label}.${name}`, args);
					return customFn.apply(this, args);
				};
			}
			(guarded as unknown as Record<string, unknown>)[GUARDED_MARKER] = true;
			target[name] = guarded;
		}
	};

	guardSpawns(Bun as unknown as Record<string, unknown>, "Bun", ["spawn", "spawnSync"]);
	guardSpawns(require("node:child_process") as Record<string, unknown>, "child_process", [
		"spawn",
		"spawnSync",
		"exec",
		"execSync",
		"execFile",
		"execFileSync",
		"fork",
	]);

	// `Bun.$` is a tagged template, so its argument is the template's string parts plus the
	// interpolated values. Both halves can carry the path, and both are inspected.
	//
	// Called through `Reflect.apply` rather than `fn.apply(...)`, because `Bun.$` carries an
	// own `apply` property that is not `Function.prototype.apply`, so the ordinary spelling
	// throws "fn.apply is not a function" on every command the guard ALLOWS. That broke every
	// `Bun.$` call in the repository and the door test did not catch it: the test only ever
	// drove a FORBIDDEN path, so `inspect` threw first and the call was never reached.
	// `Reflect.apply` goes through the internal call slot and ignores the property entirely.
	// The properties are copied onto the wrapper so `$.braces`, `$.escape`, `$.env` and
	// `$.cwd` keep working, which is also how that stray `apply` gets there.
	const bun = Bun as unknown as Record<string, unknown>;
	const shell = bun.$;
	if (typeof shell === "function") {
		const fn = shell as (...args: unknown[]) => unknown;
		const guarded = function guardedShell(this: unknown, strings: unknown, ...values: unknown[]) {
			inspect("Bun.$", [strings, ...values]);
			return Reflect.apply(fn, this, [strings, ...values]);
		};
		Object.assign(guarded, shell);
		(guarded as unknown as Record<string, unknown>)[GUARDED_MARKER] = true;
		bun.$ = guarded;
	}
}

// Before the wrapping below, so the janitor captures the real `fs.rmSync`, and OUTSIDE the
// `ENABLED` gate: a run with the tripwire disabled still has to clean up after itself.
installTempDirJanitor();

if (ENABLED) {
	installFsTripwire();
	installSqliteTripwire();
	installBunWriteTripwire();
	installSpawnTripwire();
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

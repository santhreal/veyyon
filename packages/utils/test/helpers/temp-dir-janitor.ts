/**
 * Removes the temp directories a test run creates, without any suite having to ask.
 *
 * ## The incident
 *
 * `/tmp` held 38,600 leaked `veyyon-*` directories totalling 240 GB, and the root
 * filesystem reached 100% full with 18 MB free. At that point nothing on the machine
 * works: builds fail, `bun test` fails, and the shell itself cannot write. The
 * directories came from this test suite. 233 test files call `mkdtempSync` across 405
 * call sites, and 102 of those files never call `rm` at all, so a full run leaks over
 * 1,700 directories. The largest were about 290 MB each, because a CLI spawned with a
 * fresh `HOME` stages the native addon into it.
 *
 * ## Why this is a preload and not a helper
 *
 * The same reason as `real-data-tripwire.ts`, which this module is loaded alongside: a
 * protection each suite has to remember to call is a protection 102 suites forgot. Asking
 * 233 files to add an `afterAll` fixes today's leak and not tomorrow's, because the next
 * suite is written by copying one of the ones that never cleaned up. Recording the path
 * at the moment `mkdtemp` hands it out cannot be forgotten and needs no test to change.
 *
 * ## What it records, and what it refuses to touch
 *
 * Only paths this process actually created, and only when they resolve inside
 * `os.tmpdir()`. Both halves matter. Recording what `mkdtemp` returned rather than the
 * caller's prefix means the janitor deletes a directory this process was handed and never a
 * directory it merely guessed the name of. The `os.tmpdir()` bound means a test that points
 * `mkdtemp` at a repository path keeps its output: removing that would be deleting the
 * developer's files, which is a far worse failure than the leak.
 *
 * `mkdir` is recorded on the same terms, because most test files build their scratch path by
 * hand instead of calling `mkdtemp`. The "actually created" half does the work there: see
 * {@link recordCreatedDirectory}.
 *
 * Cleanup runs from a `bun:test` `afterAll` registered in the preload, which bun runs once
 * per test FILE, so a long run never holds more than one file's worth of scratch. A process
 * killed with `SIGKILL` runs no hook at all and still leaks, so a stale-directory sweep
 * before a run is the other half: this module keeps a healthy run clean, and the sweep
 * recovers from the unhealthy ones.
 */

import * as os from "node:os";
import * as path from "node:path";

/**
 * `node:fs` through `require`, NEVER through `import * as fs from "node:fs"`.
 *
 * The ESM namespace object is FROZEN: `namespace.mkdtempSync = wrapped` throws
 * `Attempted to assign to readonly property`, so a wrapper cannot be installed on it at
 * all. `require` returns the mutable module object, and under `bun test` the namespace and
 * the module object hold the same functions, so patching the second is visible through the
 * first. `real-data-tripwire.ts` does the same thing for the same reason. Whether the
 * `require` sits at the top level or inside a function makes no difference; it is written
 * as a function only so every caller reads the module as it stands now.
 */
function fsModule(): Record<string, unknown> {
	return require("node:fs") as Record<string, unknown>;
}

/**
 * Every spelling of the tmpdir a `mkdtemp` result can carry.
 *
 * BOTH SPELLINGS, because on macOS `/tmp` is a symlink to `/private/tmp`: `os.tmpdir()`
 * reports one, `realpathSync` reports the other, and `mkdtemp` returns whichever its
 * caller passed in. Checking only the resolved form would silently record nothing on that
 * platform, which is the quietest possible way for this module to stop working.
 */
const TMP_ROOTS = ((): string[] => {
	const raw = path.resolve(os.tmpdir());
	const roots = new Set([raw]);
	try {
		roots.add((fsModule().realpathSync as (target: string) => string)(raw));
	} catch {
		// An unreadable tmpdir leaves the unresolved spelling, which is still a bound.
	}
	return [...roots];
})();

/**
 * This process's home directory, which is NOT scratch this test file owns.
 *
 * `scripts/ci-test-ts.ts` points `HOME` at one sandbox under `os.tmpdir()` and shares it
 * across every chunk of a run, so without this the tmpdir bound swallows it whole: a test
 * that made `<HOME>/.veyyon/cache/mupdf` had it recorded, and the janitor removed it at the
 * end of THAT file while other chunk processes were still reading it. The failure that
 * followed named neither the janitor nor the directory, it was `convertBufferWithMarkit`
 * answering `ok: false` in one chunk of a 4,186-file run and passing in every isolated
 * rerun.
 *
 * A directory belongs to a test file when that file created it for itself. Everything under
 * the home directory belongs to the RUN, and the run removes its own sandbox on exit.
 */
const HOME = ((): string => {
	const home = path.resolve(os.homedir());
	try {
		return (fsModule().realpathSync as (target: string) => string)(home);
	} catch {
		return home;
	}
})();

/**
 * The real `rmSync`, captured before anything wraps it.
 *
 * `real-data-tripwire.ts` replaces `fs.rmSync` with a checked version, and cleanup runs in
 * teardown where a throw is close to invisible. Holding the original keeps teardown
 * independent of what else has patched the module, and the tmpdir bound above already
 * provides the only check that matters here.
 */
const rmSync = fsModule().rmSync as (target: string, options: { recursive: boolean; force: boolean }) => void;

/** Paths `mkdtemp` handed this process that lie inside one of {@link TMP_ROOTS}. */
const created = new Set<string>();

/** True when `candidate` is inside `root`, or is `root` itself. */
function isInside(candidate: string, root: string): boolean {
	const rel = path.relative(root, candidate);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Record `dir` for removal in teardown, if it is a temp path.
 *
 * Returns whether it was recorded, which is what the tests assert against: a silent "no"
 * here is the difference between a janitor and a decoration.
 */
export function recordTempDir(dir: unknown): boolean {
	if (typeof dir !== "string" || dir.length === 0) return false;
	const resolved = path.resolve(dir);
	if (TMP_ROOTS.includes(resolved)) return false;
	if (!TMP_ROOTS.some(root => isInside(resolved, root))) return false;
	if (isInside(resolved, HOME)) return false;
	created.add(resolved);
	return true;
}

/** The paths recorded so far, sorted, for the janitor's own tests. */
export function recordedTempDirs(): string[] {
	return [...created].sort();
}

/**
 * Record what an `mkdir` call CREATED, given what it was asked for and what it returned.
 *
 * WHY `mkdir` IS RECORDED AT ALL. `mkdtemp` is the documented way to make scratch in a test
 * and 656 test files do not use it: they build a name by hand, usually unique per run
 * (`path.join(os.tmpdir(), \`pi-branching-test-${Snowflake.next()}\`)`), and 432 of those
 * files never call `rm`. Recording only `mkdtemp` therefore left the larger half of the leak
 * in place.
 *
 * WHY THE RETURN VALUE DECIDES. The janitor must never remove a directory it did not create,
 * because a fixed-name directory under the tmpdir can be shared: a source-level cache like
 * `veyyon-stats-client` is created once and read by whatever runs next. `mkdir` says exactly
 * which case happened. With `recursive: true` it returns the topmost directory it created,
 * or `undefined` when everything already existed; without it, the call throws if the target
 * exists, so returning at all means this process made it. Recording the TOPMOST created path
 * also keeps removal complete: recording the leaf would leave the parents behind.
 *
 * The residual hazard is a directory this process creates and another test file, running in
 * another worker at the same time, expects to still be there. It is bounded to fixed-name
 * directories, since a unique name cannot be shared, and every one of those in this
 * repository is a cache its owner recreates on demand. See `docs/internal/testing.md`.
 */
export function recordCreatedDirectory(target: unknown, options: unknown, result: unknown): boolean {
	if (typeof result === "string") return recordTempDir(result);
	if (isRecursiveRequest(options)) return false;
	return recordTempDir(target);
}

/** True when these `mkdir` options ask for `recursive: true`. */
function isRecursiveRequest(options: unknown): boolean {
	return typeof options === "object" && options !== null && (options as { recursive?: unknown }).recursive === true;
}

/**
 * Remove every recorded path and forget it.
 *
 * Returns what it removed and what it could not, rather than throwing: this runs in
 * teardown, where a throw would abort the remaining removals and be reported as a failure
 * of whichever suite happened to finish last. A directory that is already gone is a
 * success, not a failure, because a suite that cleaned up after itself is the outcome this
 * module wants.
 */
export function removeRecordedTempDirs(): { removed: string[]; failed: { dir: string; reason: string }[] } {
	const removed: string[] = [];
	const failed: { dir: string; reason: string }[] = [];
	for (const dir of [...created].sort()) {
		try {
			removeTree(dir);
			removed.push(dir);
		} catch (err) {
			failed.push({ dir, reason: err instanceof Error ? err.message : String(err) });
		}
		created.delete(dir);
	}
	return { removed, failed };
}

/**
 * Restore write permission on `dir` and everything under it.
 *
 * A directory cannot be removed unless its OWN mode allows writing, so a suite that tests
 * permission handling by making its scratch read-only leaves a directory nothing can
 * collect: `rm -rf` reports `EACCES` and the sweep reports it again on every future run,
 * forever. Three of them were sitting in `/tmp` when this was written. Only ever called on
 * a path already inside the tmpdir bound, and only after a removal has failed.
 */
function restoreWritePermission(dir: string): void {
	const fs = fsModule() as unknown as typeof import("node:fs");
	fs.chmodSync(dir, 0o700);
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const child = path.join(dir, entry.name);
		if (entry.isDirectory()) restoreWritePermission(child);
		else fs.chmodSync(child, 0o600);
	}
}

/**
 * Remove `dir`, restoring write permission and retrying once if the first attempt is
 * refused. Throws only when the retry also fails, so a caller still learns about a
 * directory it genuinely cannot collect.
 */
function removeTree(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch (err) {
		restoreWritePermission(dir);
		rmSync(dir, { recursive: true, force: true });
		void err;
	}
}

/**
 * How old a stranded directory must be before {@link sweepStaleTempDirs} will remove it.
 *
 * Six hours, and the bound is the whole safety argument. The sweep runs at the start of a
 * run and deletes directories belonging to processes that are gone, but it cannot tell a
 * dead process's scratch from a live one's, only how long ago it was written. No test run
 * in this repository takes six hours, so anything older than that belongs to nobody, while
 * a run started ten minutes ago is untouchable no matter how many other runs begin beside
 * it.
 */
export const STALE_TEMP_DIR_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * The directory-name prefixes this repository's tests create under the tmpdir.
 *
 * ONE OWNER FOR THE LIST, because the sweep is worthless against a prefix it does not know:
 * it ran with `veyyon-` alone while `/tmp` held 14,364 `pi-` directories from the
 * coding-agent suite, which is the larger half of what a killed run strands.
 *
 * DISTINCTIVE NAMES ONLY. The sweep removes directories belonging to processes that are
 * gone, and it identifies them by name and age, so a prefix that another program might also
 * use does not belong here however many of ours it would catch. That rules out the generic
 * first words this suite also uses (`read-`, `auth-`, `test-`, `plan-`): those are covered
 * by the per-file cleanup instead, which needs no name at all. `pi-` is the shortest entry
 * and the one worth knowing about: it is this project's former name, still the coding-agent
 * suite's convention, and a six-hour-old `/tmp/pi-*` directory belonging to something else
 * would be removed with them.
 *
 * To refresh it, look at what the suite actually names:
 * `rg -o 'tmpdir\(\)\s*,\s*`?"?([a-z][a-z0-9-]*?)-' -r '$1' packages scripts | sort -u`.
 */
export const TEST_TEMP_DIR_PREFIXES = ["veyyon-", "pi-", "mnemopi-", "argot-", "hashline-"] as const;

/**
 * Remove `prefix`-named directories under the tmpdir that nothing has written to in
 * {@link STALE_TEMP_DIR_AGE_MS}.
 *
 * THE OTHER HALF OF THE JANITOR. Per-file teardown keeps a healthy run clean and does
 * nothing for a process killed with `SIGKILL`, for a suite that builds its temp directory
 * with `mkdirSync` and a fixed name rather than with `mkdtemp`, or for the 38,600
 * directories a machine has already accumulated. This recovers from all three, which is why
 * `scripts/ci-test-ts.ts` calls it before a run rather than leaving the disk to fill again.
 *
 * @param options.prefix Directory-name prefix to consider, matched against the base name.
 * @param options.root Directory to sweep. Defaults to the tmpdir; a test passes its own.
 * @param options.olderThanMs Age bound. Defaults to {@link STALE_TEMP_DIR_AGE_MS}.
 * @param options.now Clock, injectable so a test does not have to backdate real files.
 */
export function sweepStaleTempDirs(options: { prefix: string; root?: string; olderThanMs?: number; now?: number }): {
	removed: string[];
	failed: { dir: string; reason: string }[];
} {
	const fs = fsModule() as unknown as typeof import("node:fs");
	const root = options.root ?? TMP_ROOTS[0] ?? path.resolve(os.tmpdir());
	const olderThanMs = options.olderThanMs ?? STALE_TEMP_DIR_AGE_MS;
	const now = options.now ?? Date.now();
	const removed: string[] = [];
	const failed: { dir: string; reason: string }[] = [];

	let entries: import("node:fs").Dirent[];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch (err) {
		return { removed, failed: [{ dir: root, reason: err instanceof Error ? err.message : String(err) }] };
	}

	for (const entry of entries) {
		if (!entry.isDirectory() || !entry.name.startsWith(options.prefix)) continue;
		const dir = path.join(root, entry.name);
		// A directory this process is still recording is live by definition, whatever its
		// timestamp says: a suite can create its scratch and not touch it again for hours.
		if (created.has(path.resolve(dir))) continue;
		try {
			if (now - fs.statSync(dir).mtimeMs < olderThanMs) continue;
			removeTree(dir);
			removed.push(dir);
		} catch (err) {
			failed.push({ dir, reason: err instanceof Error ? err.message : String(err) });
		}
	}
	return { removed, failed };
}

/** Marker on the wrapped functions, naming which ones this module produced. */
export const RECORDING_MARKER = "__veyyonTempDirRecorded";

/** Marker on the `node:fs` module object itself, so a second install is a no-op. */
const INSTALLED_MARKER = "__veyyonTempDirJanitorInstalled";

/** True when `candidate` is the recording version of an `mkdtemp` entry point. */
export function isRecording(candidate: unknown): boolean {
	// `as unknown as` because the `typeof` guard has already narrowed `candidate` to `Function`, which has no
	// index signature; the same spelling is used by `install` below.
	return (
		typeof candidate === "function" && (candidate as unknown as Record<string, unknown>)[RECORDING_MARKER] === true
	);
}

/** Tag `wrapped` as installed and put it on `target`. */
function install(target: Record<string, unknown>, name: string, wrapped: (...args: unknown[]) => unknown): void {
	(wrapped as unknown as Record<string, unknown>)[RECORDING_MARKER] = true;
	target[name] = wrapped;
}

/**
 * Wrap the three shapes `mkdtemp` comes in, and the three `mkdir` comes in.
 *
 * All of them rather than only the synchronous ones because the leak is measured in
 * directories, not in call styles, and a suite that switches to `await mkdtemp` should not
 * quietly opt out of cleanup. `mkdir` is here because most test files do not use `mkdtemp`
 * at all; see {@link recordCreatedDirectory} for what it records and what it refuses to.
 */
function installRecorders(): void {
	const fs = fsModule();
	// THE GUARD IS ON THE MODULE, NOT ON THE FUNCTION. `real-data-tripwire.ts` wraps
	// `mkdtemp`/`mkdtempSync` as well, and it wraps them AFTER these recorders, so the
	// outermost function carries the tripwire's marker and not this one. A per-function
	// check would conclude "not installed" and wrap a second time on every later call,
	// recording each directory twice and growing a chain of closures for the whole run.
	if (fs[INSTALLED_MARKER] === true) return;
	fs[INSTALLED_MARKER] = true;

	const syncOriginal = fs.mkdtempSync;
	if (typeof syncOriginal === "function" && !isRecording(syncOriginal)) {
		const fn = syncOriginal as (...args: unknown[]) => unknown;
		install(fs, "mkdtempSync", function recordingMkdtempSync(this: unknown, ...args: unknown[]) {
			const result = fn.apply(this, args);
			recordTempDir(typeof result === "string" ? result : String(result));
			return result;
		});
	}

	const callbackOriginal = fs.mkdtemp;
	if (typeof callbackOriginal === "function" && !isRecording(callbackOriginal)) {
		const fn = callbackOriginal as (...args: unknown[]) => unknown;
		install(fs, "mkdtemp", function recordingMkdtemp(this: unknown, ...args: unknown[]) {
			const last = args[args.length - 1];
			if (typeof last !== "function") return fn.apply(this, args);
			const callback = last as (...callbackArgs: unknown[]) => unknown;
			const forwarded = [
				...args.slice(0, -1),
				(err: unknown, dir: unknown) => {
					if (!err) recordTempDir(dir);
					return callback(err, dir);
				},
			];
			return fn.apply(this, forwarded);
		});
	}

	const promises = fs.promises as Record<string, unknown> | undefined;
	const promiseOriginal = promises?.mkdtemp;
	if (promises && typeof promiseOriginal === "function" && !isRecording(promiseOriginal)) {
		const fn = promiseOriginal as (...args: unknown[]) => Promise<unknown>;
		install(promises, "mkdtemp", function recordingMkdtempPromise(this: unknown, ...args: unknown[]) {
			return fn.apply(this, args).then(dir => {
				recordTempDir(dir);
				return dir;
			});
		});
	}

	const mkdirSyncOriginal = fs.mkdirSync;
	if (typeof mkdirSyncOriginal === "function" && !isRecording(mkdirSyncOriginal)) {
		const fn = mkdirSyncOriginal as (...args: unknown[]) => unknown;
		install(fs, "mkdirSync", function recordingMkdirSync(this: unknown, ...args: unknown[]) {
			const result = fn.apply(this, args);
			recordCreatedDirectory(args[0], args[1], result);
			return result;
		});
	}

	const mkdirOriginal = fs.mkdir;
	if (typeof mkdirOriginal === "function" && !isRecording(mkdirOriginal)) {
		const fn = mkdirOriginal as (...args: unknown[]) => unknown;
		install(fs, "mkdir", function recordingMkdir(this: unknown, ...args: unknown[]) {
			const last = args[args.length - 1];
			if (typeof last !== "function") return fn.apply(this, args);
			const callback = last as (...callbackArgs: unknown[]) => unknown;
			const target = args[0];
			// `fs.mkdir(path, cb)` and `fs.mkdir(path, options, cb)` are both legal, so the
			// options are whatever sits between the two, if anything.
			const options = args.length > 2 ? args[1] : undefined;
			const forwarded = [
				...args.slice(0, -1),
				(err: unknown, made: unknown) => {
					if (!err) recordCreatedDirectory(target, options, made);
					return callback(err, made);
				},
			];
			return fn.apply(this, forwarded);
		});
	}

	const mkdirPromiseOriginal = promises?.mkdir;
	if (promises && typeof mkdirPromiseOriginal === "function" && !isRecording(mkdirPromiseOriginal)) {
		const fn = mkdirPromiseOriginal as (...args: unknown[]) => Promise<unknown>;
		install(promises, "mkdir", function recordingMkdirPromise(this: unknown, ...args: unknown[]) {
			return fn.apply(this, args).then(made => {
				recordCreatedDirectory(args[0], args[1], made);
				return made;
			});
		});
	}
}

/** Set once {@link installTempDirJanitor} has wired cleanup. */
let installed = false;

/**
 * Where the cleanup is wired, which is the one thing about this module worth checking when
 * it appears to do nothing.
 *
 * `"afterAll"` is a `bun:test` hook registered from a preload, which bun runs once per test
 * FILE. `"exit"` is `process.on("exit")`, for a process that is not a test run.
 */
export type JanitorCleanupHook = "afterAll" | "exit";

/** How cleanup was wired in this process, or `null` before {@link installTempDirJanitor}. */
let cleanupHook: JanitorCleanupHook | null = null;

/** How cleanup is wired in this process. */
export function janitorCleanupHook(): JanitorCleanupHook | null {
	return cleanupHook;
}

/**
 * Install the recorders and the cleanup hook. Idempotent.
 *
 * AN EXPLICIT CALL, NOT A MODULE-LOAD SIDE EFFECT. It was the latter, imported for effect
 * by `real-data-tripwire.ts` with `import "./temp-dir-janitor"`, and bun dropped that
 * import: the tripwire installed and the janitor did not, so every directory still leaked
 * while the module read as if it were wired. An import whose binding is called cannot be
 * elided.
 *
 * `process.on("exit")` IS NOT ENOUGH, and that is the other thing this got wrong.
 * `bun test` does not run exit handlers: a preload that registers one prints nothing at the
 * end of a run, so cleanup written that way is dead code in exactly the process it was
 * built for. A `bun:test` `afterAll` registered from a preload does run, once per test
 * file, which is also a better moment than process exit because it bounds how much a run
 * ever holds at once rather than only what it leaves behind. The exit handler stays for
 * processes that are not test runs, where `bun:test` cannot be imported at all.
 */
export function installTempDirJanitor(): void {
	installRecorders();
	if (installed) return;
	installed = true;

	try {
		const { afterAll } = require("bun:test") as { afterAll: (fn: () => void) => void };
		afterAll(reportUncollected);
		cleanupHook = "afterAll";
		return;
	} catch {
		// Not a test process: `bun:test` does not resolve outside one. Fall through to the
		// exit handler, which is the only hook such a process has.
	}

	process.on("exit", reportUncollected);
	cleanupHook = "exit";
}

/**
 * Run the cleanup and SAY SO when it could not collect something.
 *
 * The hook used to call `removeRecordedTempDirs()` and throw its return value away. That
 * function reports what it failed to remove precisely so a caller can act on it, and
 * discarding the report reintroduced, inside the module built to stop it, the exact
 * failure mode the module exists for: a directory left in the system temp directory with
 * nothing anywhere naming it. It is the quiet case that matters, because a directory the
 * janitor could NOT remove is the one that stays forever, while the ones it can remove
 * need no announcement.
 *
 * It writes to `console.error` rather than throwing. This runs in teardown, and a throw
 * here is reported as a failure of whichever test file happened to finish last, which
 * blames the wrong suite for a leak somebody else caused (Law 10: loud, not fatal).
 */
function reportUncollected(): void {
	const message = describeUncollected(removeRecordedTempDirs().failed);
	if (message !== null) console.error(message);
}

/**
 * The message for a set of directories that could not be removed, or `null` for none.
 *
 * Separated from the hook so its exact wording can be asserted without arranging a real
 * removal failure. That turned out to matter: the obvious way to arrange one, a scratch
 * directory inside a read-only parent, does not fail at all when the janitor made the
 * parent too, because it removes the parent first and the child goes with it.
 *
 * `null` rather than an empty string for the ordinary case, so a caller cannot print a
 * blank line on every clean run and train readers to skip past this.
 */
export function describeUncollected(failed: { dir: string; reason: string }[]): string | null {
	if (failed.length === 0) return null;
	const count = failed.length === 1 ? "1 scratch directory" : `${failed.length} scratch directories`;
	const verb = failed.length === 1 ? "is" : "are";
	const lines = failed.map(({ dir, reason }) => `  ${dir}: ${reason}`).join("\n");
	return `temp-dir-janitor: ${count} could not be removed and ${verb} left behind:\n${lines}`;
}

/**
 * Drop `dir` from the record without removing it.
 *
 * FOR THE JANITOR'S OWN TESTS ONLY, and it exists because they cannot otherwise model the
 * case the sweep is for. A stranded directory belongs to a process that is GONE, and a test
 * has to create one to sweep it, which now records it, which makes the sweep skip it as
 * live. Forgetting the fixture is what makes it another process's.
 */
function forget(dir: string): void {
	created.delete(path.resolve(dir));
}

/** Exported for the janitor's own tests. */
export const __janitor = { TMP_ROOTS, isInside, installRecorders, fsModule, forget };

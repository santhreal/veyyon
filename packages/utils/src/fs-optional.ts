/**
 * Filesystem reads whose subject is allowed to be ABSENT, and whose failure is not allowed to be silent.
 *
 * WHY THIS EXISTS. Half the tree scans an optional directory, and the shape everybody reaches for is
 * `await fs.readdir(dir).catch(() => [])`. It is right about the common case -- `~/.veyyon/agents` usually
 * does not exist, and a project with no `.veyyon/` is not an error -- and wrong about every other one. A
 * directory that exists and cannot be LISTED collapses to the same empty array: the user's subagents
 * silently vanish, a memories sweep silently sees nothing to keep, a plugin scan silently finds no
 * plugins. Nothing fails, so nobody looks, and the recall loss is invisible (Law 10).
 *
 * The two answers are different and must stay different. "Not there" is data: return nothing and carry on.
 * "There but unreadable" is a fault: report it with the path and the reason, then return nothing, because
 * the caller genuinely has nothing to work with -- but the operator now has something to find.
 *
 * REPORTED THROUGH `reportFault`, WHICH IS THE HALF THIS FILE USED TO GET WRONG. The paragraph above was
 * true of the code's structure and false of its effect: the report was a `logger.warn`, the default
 * transport set is `{ file: true }` with no console transport, and a TUI cannot write to the console
 * without corrupting its render, so "the operator now has something to find" meant a line in a file
 * nobody opens. Every promise in this file was kept only against a reader who already suspected the
 * problem and went looking, which is precisely the reader who does not need telling. `fault-sink.ts` is
 * now the one place these go, and whoever owns an operator-visible surface attaches it.
 *
 * These are the one owner for that decision. Reach for them instead of writing another `.catch(() => [])`.
 *
 * FOUR CONTRACTS FOR "IS THIS PATH THERE", differing only in what happens to a fault, because that is the
 * only question a caller actually has. Pick by name:
 *
 *   - {@link pathExists} reports the fault and answers absent. The default, for a probe that switches a
 *     feature on: the operator hears about it and the caller carries on.
 *   - {@link pathExistsOrThrow} propagates it. For a probe whose false branch DELETES or overwrites
 *     something, where acting on a wrong answer is worse than failing.
 *   - {@link pathState} returns it as a third value. For a caller whose OUTPUT is the difference, which
 *     in practice means a health check.
 *   - {@link pathExistsQuietly} swallows it, and makes you say why. For a resolution walk where a miss is
 *     the expected answer at nearly every step.
 *
 * {@link pathStateSync} is the third contract again for a caller that cannot await, and it is the only
 * sync spelling here on purpose: `ConfigFile` resolves which file to read from a synchronous constructor,
 * because settings are read before anything is allowed to be asynchronous. Everything else awaits.
 *
 * THREE FILES HAND-ROLLED ONE OF THESE BEFORE THEY ALL EXISTED, and none of them was wrong about what it
 * needed: `cli/gc-cli.ts` wanted the throwing one, `utils/file-mentions.ts` and
 * `extensibility/plugins/legacy-pi-compat.ts` wanted the silent one. Two of them named their private copy
 * `pathExists`, the same name as the reporting export with the opposite behaviour, so a reader had no way
 * to tell which contract a call site had and importing the shared one would have changed behaviour
 * silently. Wanting something different is now a matter of picking a name, and
 * `test/fs-optional-strict-twins.test.ts` fails if a fourth private copy appears.
 */

// `Stats` is named explicitly rather than inferred through `Awaited<ReturnType<typeof fs.stat>>`, which
// is what these signatures used to say. `fs.stat` is OVERLOADED on its options argument, so that
// expression resolves to `BigIntStats | Stats` and every caller inherited a union it never asked for.
// Nothing noticed while the only callers read `.size` and `.mtimeMs`, which both members have; the first
// caller to pass a stat into a `{ dev: number, ino: number }` shape got four type errors for a `bigint`
// that cannot occur, because no call here passes `{ bigint: true }`.
import type { Dirent, Stats } from "node:fs";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import * as fs from "node:fs/promises";
// Faults go through `reportFault`, NOT through `logger.warn`. This module's header promises the
// failure is "not allowed to be silent", and `logger.warn` writes to a file-only transport set, so
// for the first two years of this file every promise below was kept only in the file log. See
// `fault-sink.ts` for why the reporting direction is inverted instead of importing the session's
// notice channel, which lives a layer above this one.
import { reportFault } from "./fault-sink";
import { isEnoent } from "./fs-error";

/**
 * The directory's entries, or `[]` when it does not exist.
 *
 * A missing directory is silent: that is the ordinary state of every optional config directory. Anything
 * else is logged with the directory and the error before the empty list is returned, so a permissions
 * problem or a bad mount does not read as "nothing configured".
 *
 * @param what a short phrase naming what the caller was looking for, used in the log line so the report
 * says which scan came up empty (`"agent definitions"`, `"managed skills"`) rather than only which path.
 */
export async function readdirIfPresent(dir: string, what: string): Promise<Dirent[]> {
	try {
		return await fs.readdir(dir, { withFileTypes: true });
	} catch (error) {
		if (isEnoent(error)) return [];
		reportFault({
			source: "filesystem",
			// Names the CONSEQUENCE, not just the syscall. "Could not list a directory" tells an operator
			// nothing about what they have lost; "your agent definitions were not loaded" is what makes
			// them go and look, and the empty result is the thing they would otherwise misread as
			// "nothing configured".
			text: `${dir} exists but could not be listed, so ${what} could not be loaded and this run is continuing without any. Check the directory's permissions and whether its filesystem is mounted.`,
			context: { dir, what, error: String(error) },
		});
		return [];
	}
}

/**
 * Whether the path is there, without blocking the event loop, and without hiding a fault.
 *
 * The async replacement for `fs.existsSync` inside an `async` function, which is a shape the tree keeps
 * growing: a marker-file probe in a project detector, six of them in a plugin loader, a guard before a
 * read. Each one stops the loop for the length of a stat. On a cold or network filesystem that is
 * milliseconds, during which a TUI cannot paint a frame and a server cannot answer, and the cost is
 * multiplied by however many markers the probe checks in a row.
 *
 * It also fixes what `existsSync` cannot express. `existsSync` answers `false` for a path that exists and
 * cannot be stat'd, so a permissions problem or a bad mount is indistinguishable from absence and the
 * caller carries on as though the file were simply not there (Law 10). This reports that case with the
 * path and the reason through {@link reportFault}, then answers `false`, because the caller still has
 * nothing to work with. The RETURN is still indistinguishable from absence, by design: a caller that
 * needs to tell the two apart must not use a boolean, and `plugin doctor` is the standing example of a
 * caller whose whole job is to tell them apart.
 *
 * @param what a short phrase naming what the caller was probing for, used in the log line.
 */
export async function pathExists(target: string, what: string): Promise<boolean> {
	return (await statIfPresent(target, what)) !== undefined;
}

/**
 * The path's `stat`, or `undefined` when it does not exist.
 *
 * Same split as {@link readdirIfPresent}: absence is an answer, anything else is a fault worth a line.
 * `undefined` rather than `null` so a caller cannot confuse "no stat" with a falsy stat field.
 */
export async function statIfPresent(target: string, what: string): Promise<Stats | undefined> {
	try {
		return await fs.stat(target);
	} catch (error) {
		if (isEnoent(error)) return undefined;
		reportFault({
			source: "filesystem",
			// "Treating it as absent" was the whole defect stated out loud: the caller then behaves as
			// though the path is not there, which for a probe means a feature quietly switches off. The
			// operator has to be told that the answer they are about to see is a guess.
			text: `${target} could not be read while probing for ${what}, so it is being treated as absent and anything that depends on it is switched off. Check the path's permissions and whether its filesystem is mounted.`,
			context: { path: target, what, error: String(error) },
		});
		return undefined;
	}
}

/**
 * The path's `stat`, `undefined` when it does not exist, and a THROW for anything else.
 *
 * The other contract, and it needs a home of its own rather than a private copy per caller. Absence
 * is still an answer, because that is what makes these helpers worth having, but a fault propagates
 * instead of degrading to "absent". Reach for this when acting on a wrong answer is worse than
 * failing: a garbage collector deciding whether a session file is still there, a lock probe deciding
 * whether another process holds it, any check whose false branch DELETES or OVERWRITES something.
 * {@link statIfPresent} is right for a probe that switches a feature on, and catastrophic for a
 * probe that authorises a removal.
 *
 * WHY IT IS SPELLED OUT IN THE NAME. `cli/gc-cli.ts` carried private `pathExists` and
 * `statIfPresent` with these exact two names and the OPPOSITE behaviour to the exported pair, so the
 * same call spelled the same way threw in one file and swallowed in another, and anyone tidying the
 * duplicate away by importing the shared one would have silently converted the garbage collector to
 * the degrading contract with no type error and no failing test. Its copy also returned `null` where
 * the shared one documents `undefined`, for the reason given on {@link statIfPresent}. Two contracts
 * are fine; two contracts under one name is a trap.
 */
export async function statIfPresentOrThrow(target: string): Promise<Stats | undefined> {
	try {
		return await fs.stat(target);
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

/**
 * Whether the path is there, throwing when that question cannot be answered.
 *
 * The strict twin of {@link pathExists}, over {@link statIfPresentOrThrow}. No `what` parameter,
 * because nothing is reported: the error carries the path and the errno already, and a caller that
 * throws is going to say what it was doing in its own words.
 */
export async function pathExistsOrThrow(target: string): Promise<boolean> {
	return (await statIfPresentOrThrow(target)) !== undefined;
}

/**
 * Whether the path is there, reporting NOTHING when the answer cannot be determined.
 *
 * THE SILENT CONTRACT, WHICH EXISTS SO THAT SILENCE HAS TO BE SPELLED. This module's header says a
 * call site that must be silent "needs a comment saying why the invisible case is acceptable there",
 * and two of them obliged and then hand-rolled the function: `utils/file-mentions.ts` and
 * `extensibility/plugins/legacy-pi-compat.ts` each defined a private `pathExists` that swallowed every
 * error, each with a correct paragraph explaining why. Both reasons are good ones. The problem was the
 * NAME: two functions called `pathExists`, one reporting and one silent, so importing the shared one
 * into either file would have added operator noise with no type error, and hand-rolling a third copy
 * was easier than justifying the silence.
 *
 * So the silence is a named export with a MANDATORY `why`. The string is never rendered; it exists to
 * make every silent probe carry its justification at the call site and to make them all greppable at
 * once. If you cannot write the `why`, you want {@link pathExists}, which reports.
 *
 * Legitimate uses look like this, and both are resolution WALKS rather than single probes: an
 * `@`-mention completing against several candidate paths, or a package-root search climbing to the
 * filesystem root. Most calls are misses by design, and a fault line per miss is how a real report
 * gets tuned out.
 */
export async function pathExistsQuietly(target: string, why: string): Promise<boolean> {
	// `why` is documentation the compiler enforces the presence of. Read once so a linter cannot
	// suggest deleting the parameter, which would remove the whole point of the signature.
	void why;
	try {
		await fs.stat(target);
		return true;
	} catch {
		return false;
	}
}

/**
 * What is actually known about a path: it is there and usable, it is not there, or it is there and
 * this process cannot use it.
 */
export type PathState = "present" | "absent" | "unreadable";

/**
 * The three-state answer, for a caller whose job is to tell absence from a fault.
 *
 * The third contract, and the one the other two cannot express. `pathExists` collapses `unreadable`
 * into `false` and {@link pathExistsOrThrow} turns it into a throw, which are the right answers for a
 * probe that switches a feature on and for a probe that authorises a delete. Neither suits a HEALTH
 * CHECK, whose entire output is the difference between "not installed yet" and "installed and
 * broken": `PluginManager.doctor` reported a plugins directory it could not stat as
 * `"Not created yet (no plugins installed)"` with status `ok`, and its doc comment cited "a path that
 * exists but cannot be stat'd is exactly the kind of broken install doctor is meant to surface" as
 * the reason it had moved off `existsSync`. The move fixed the blocking, not the conflation, because
 * the return type had no room for the third answer.
 *
 * A DIRECTORY IS CHECKED FOR ACCESS, NOT ONLY STAT'D, and getting that wrong is how this function
 * shipped its first version answering "present" for the exact case it was written to detect. `stat`
 * resolves a path through its PARENT, so `stat` on a `chmod 000` directory SUCCEEDS: the caller
 * learns the directory is there and nothing about whether its contents can be read. Every unreadable
 * directory therefore came back `present`, and the "could not be read" message below could not fire
 * on the state it describes. The extra `access(R_OK | X_OK)` is the question a caller about to list a
 * directory is actually asking, and it costs one syscall on a path that already stat'd.
 *
 * A FILE is `present` on a successful stat, deliberately. Whether its BYTES can be read is a
 * different question with a different answer per opener, and the caller is about to open it anyway,
 * so probing first would be both a lie (the permission can change in between) and a wasted syscall.
 *
 * NOTHING IS REPORTED HERE. A caller asking for the state is going to put it in its own output, and a
 * fault line as well would report one problem twice in two voices. That is the opposite of
 * {@link statIfPresent}, which reports precisely because its caller cannot.
 */
export async function pathState(target: string): Promise<PathState> {
	let stat: Stats;
	try {
		stat = await fs.stat(target);
	} catch (error) {
		return isEnoent(error) ? "absent" : "unreadable";
	}
	if (!stat.isDirectory()) return "present";
	try {
		// R_OK to read the entries, X_OK to traverse into them. A directory missing either is one a
		// caller cannot walk, which is what "unreadable" has to mean for it to be worth reporting.
		await fs.access(target, fsConstants.R_OK | fsConstants.X_OK);
		return "present";
	} catch {
		return "unreadable";
	}
}

/**
 * {@link pathState}, synchronously, for a caller that genuinely cannot await.
 *
 * WHY A SYNC TWIN EXISTS AT ALL, when the rest of this file is async on purpose. `ConfigFile` resolves
 * which file to read from a SYNCHRONOUS constructor and a synchronous `tryLoad`, because settings are
 * read before anything is allowed to be asynchronous: `Settings.isolated()`, the CLI's own startup, and
 * every test helper depend on that. Its probe was `fs.existsSync(this.#basePath)`, which answers `false`
 * for an unreadable file exactly as it does for an absent one, so a config file that was THERE and could
 * not be read silently resolved to the YAML fallback and the operator's settings were replaced by a
 * different file's, with nothing said. The three-state answer is the fix, and it has to be available
 * without an await or the call site cannot use it.
 *
 * THE SAME CONTRACT AS THE ASYNC ONE, INCLUDING THE DIRECTORY ACCESS CHECK, and it is the same function
 * twice only in the sense that `readFile` and `readFileSync` are: one owner for the DECISION (what
 * counts as absent, what counts as unreadable, why a directory needs `access` when `stat` resolves
 * through its parent), two spellings of the syscall. A caller that can await must use {@link pathState};
 * this one blocks the event loop and is for the paths that have no choice.
 */
export function pathStateSync(target: string): PathState {
	let stat: Stats;
	try {
		stat = statSync(target);
	} catch (error) {
		return isEnoent(error) ? "absent" : "unreadable";
	}
	if (!stat.isDirectory()) return "present";
	try {
		accessSync(target, fsConstants.R_OK | fsConstants.X_OK);
		return "present";
	} catch {
		return "unreadable";
	}
}

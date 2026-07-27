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
 * These are the one owner for that decision. Reach for them instead of writing another `.catch(() => [])`,
 * and if a call site truly must be silent, it needs a comment saying why the invisible case is acceptable
 * there.
 */

import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import { isEnoent } from "./fs-error";
// `logger` is a MODULE, not an object: `index.ts` publishes it as `export * as logger`, so importing the
// namespace here is the same `logger.warn` every caller uses.
import * as logger from "./logger";

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
		logger.warn(`Could not list a directory while looking for ${what}; continuing without it`, {
			dir,
			what,
			error: String(error),
		});
		return [];
	}
}

/**
 * The path's `stat`, or `undefined` when it does not exist.
 *
 * Same split as {@link readdirIfPresent}: absence is an answer, anything else is a fault worth a line.
 * `undefined` rather than `null` so a caller cannot confuse "no stat" with a falsy stat field.
 */
export async function statIfPresent(
	target: string,
	what: string,
): Promise<Awaited<ReturnType<typeof fs.stat>> | undefined> {
	try {
		return await fs.stat(target);
	} catch (error) {
		if (isEnoent(error)) return undefined;
		logger.warn(`Could not stat a path while looking for ${what}; treating it as absent`, {
			path: target,
			what,
			error: String(error),
		});
		return undefined;
	}
}

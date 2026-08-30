import * as os from "node:os";
import * as path from "node:path";

/**
 * Node-side path shortener: collapses the *real* home dir (`os.homedir()`, or
 * an explicit `homeDir`) to `~`, normalizes Win32 separators, and tolerates
 * non-string input. The browser packages cannot call `os.homedir()`, so they
 * share a separate `/Users|/home`-heuristic owner in `@veyyon/tool-render`
 * (`src/util.ts`). Two owners, one per runtime boundary, is deliberate here —
 * not an accidental duplicate.
 *
 * It sits in its own module because the launch card's status row needs it and
 * `render-utils` costs 94 modules to reach; this one costs two node builtins.
 * `render-utils` re-exports it, so every existing caller is unchanged.
 */
export function shortenPath(filePath: unknown, homeDir?: string): string {
	if (typeof filePath !== "string") {
		return "";
	}
	const home = homeDir ?? os.homedir();
	if (home && filePath.startsWith(home)) {
		const suffix = filePath.slice(home.length);
		if (suffix === "" || suffix.startsWith(path.posix.sep) || suffix.startsWith(path.win32.sep)) {
			return `~${suffix.replaceAll(path.win32.sep, path.posix.sep)}`;
		}
	}
	return filePath;
}

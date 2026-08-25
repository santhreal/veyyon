import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { splitDelimitedPathEntrySync } from "@veyyon/coding-agent/tools/path-utils";

/**
 * WHY: `probePartResolvesSync` answers one question — does this candidate part
 * of a delimited entry exist on disk? It returned false for "missing" and
 * RETHREW everything else, so a part the process may not stat took down the
 * whole tool call instead of answering it. EACCES is the ordinary way that
 * happens: statting a path under a directory without execute permission
 * (another user's home, a 0700 service directory) fails that way while the path
 * is perfectly real. The `probeLiteralExists*` pair a few lines above already
 * read not-missing as "it exists", so the two probes disagreed about the same
 * filesystem.
 *
 * The mock is path-aware on purpose. Failing every stat with EACCES makes the
 * undivided entry itself probe as present, the splitter returns `null` before
 * any part is examined, and the test proves nothing. Only the whole literal is
 * reported missing here, which is what forces the candidate parts to be probed.
 *
 * CLASS CLOSED: the probe answers rather than throws for a non-missing stat
 * error, and the caller still receives the split. ENOENT keeps meaning
 * "absent", so the correction cannot be mistaken for "treat every error as
 * present" at the boundary where that distinction is the whole point.
 *
 * NOT CAUGHT: this drives the sync probe through its exported caller. The async
 * twin shares the shape and the correction but is reached by its own callers.
 */

afterEach(() => {
	// A file-wide stub of `fs` would poison every later suite in this bucket.
	spyOn(fs, "statSync").mockRestore();
});

function errno(code: string, message: string): NodeJS.ErrnoException {
	const err: NodeJS.ErrnoException = new Error(message);
	err.code = code;
	return err;
}

/**
 * Report the undivided entry as absent and every individual part as present but
 * unreadable — the only arrangement that reaches the part probe at all.
 */
function stubPartsUnreadable(): void {
	spyOn(fs, "statSync").mockImplementation(((target: fs.PathLike) => {
		if (String(target).includes(",")) throw errno("ENOENT", "ENOENT: no such file or directory");
		throw errno("EACCES", "EACCES: permission denied");
	}) as typeof fs.statSync);
}

describe("an unreadable path part does not crash delimiter splitting", () => {
	it("does not throw when a candidate part cannot be stat'd", () => {
		stubPartsUnreadable();
		expect(() => splitDelimitedPathEntrySync("src,/root/secret,test", process.cwd())).not.toThrow();
	});

	it("accepts the split, counting the unreadable part as present", () => {
		stubPartsUnreadable();
		expect(splitDelimitedPathEntrySync("src,/root/secret,test", process.cwd())).toEqual([
			"src",
			"/root/secret",
			"test",
		]);
	});

	it("still declines to split when the parts are genuinely absent", () => {
		spyOn(fs, "statSync").mockImplementation((() => {
			throw errno("ENOENT", "ENOENT: no such file or directory");
		}) as typeof fs.statSync);
		expect(splitDelimitedPathEntrySync("nope-a,nope-b", process.cwd())).toBeNull();
	});
});

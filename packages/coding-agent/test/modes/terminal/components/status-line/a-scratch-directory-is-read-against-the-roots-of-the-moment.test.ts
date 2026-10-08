/**
 * WHY THIS SUITE EXISTS. The footline paints a scratch icon and a root-relative path for a working
 * directory under a scratch root. Deciding that costs two `realpath` calls per root, and the row
 * renders on every keystroke and animation frame, so the answer is held for the directory it was
 * asked about. The scratch roots come from the environment (`os.tmpdir()`, the home directory), and
 * a held answer that outlives a change to them paints a project as scratch after its root is gone,
 * or misses one under a root that arrived.
 *
 * THE CLASS: every input the classification reads, held or not. The directory and the root list
 * are both part of what the held answer is checked against, so each case changes one of them and
 * expects the answer to change with it.
 *
 * WHAT IT DOES NOT CATCH: a symlink retargeted under an unchanged directory and root list. The
 * answer is held per directory, as the display-root strip beside it is.
 */
import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { classifyProjectDir } from "@veyyon/coding-agent/modes/terminal/components/status-line/location";

/** Absolute and never created, so containment is read off the spelling, and outside every default root. */
const HOME_A = path.resolve("/veyyon-scratch-home-a");
const HOME_B = path.resolve("/veyyon-scratch-home-b");
const TMP_A = path.resolve("/veyyon-scratch-tmp-a");
const TMP_B = path.resolve("/veyyon-scratch-tmp-b");

afterEach(() => {
	vi.restoreAllMocks();
});

describe("a scratch directory is read against the roots of the moment", () => {
	it("follows the home directory's scratch root when the home directory changes", () => {
		const home = spyOn(os, "homedir").mockReturnValue(HOME_A);
		const project = path.join(HOME_A, "tmp", "probe");
		expect(classifyProjectDir(project)).toEqual({ scratch: true, relative: "probe" });

		home.mockReturnValue(HOME_B);
		expect(classifyProjectDir(project)).toEqual({ scratch: false, relative: null });
		expect(classifyProjectDir(path.join(HOME_B, "tmp", "other"))).toEqual({ scratch: true, relative: "other" });
	});

	it("follows the temporary directory when it changes", () => {
		const tmp = spyOn(os, "tmpdir").mockReturnValue(TMP_A);
		const project = path.join(TMP_A, "probe");
		expect(classifyProjectDir(project)).toEqual({ scratch: true, relative: "probe" });

		tmp.mockReturnValue(TMP_B);
		expect(classifyProjectDir(project)).toEqual({ scratch: false, relative: null });
	});

	it("answers for the directory asked about, not the one asked before it", () => {
		spyOn(os, "tmpdir").mockReturnValue(TMP_A);
		expect(classifyProjectDir(path.join(TMP_A, "first"))).toEqual({ scratch: true, relative: "first" });
		expect(classifyProjectDir(path.join(TMP_A, "second"))).toEqual({ scratch: true, relative: "second" });
		expect(classifyProjectDir(path.join(HOME_A, "project"))).toEqual({ scratch: false, relative: null });
	});
});

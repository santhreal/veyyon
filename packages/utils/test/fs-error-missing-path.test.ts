/**
 * "Is this filesystem error an absent path, or an unusable one?" has ONE answer in the repo.
 *
 * WHY THIS SUITE EXISTS. That question decides whether a probe stays quiet or complains, and it was
 * answered in at least six places, in four different spellings, under three different names:
 * `isNotFoundError` in `tools/read.ts` compared raw code strings, `isMissingDirectoryError` in
 * `discovery/claude.ts` called `hasFsCode` twice, `internal-urls/registry-helpers.ts` used
 * `isEnoent` for one half and a cast to `NodeJS.ErrnoException` for the other, and `capability/fs.ts`
 * and `tools/path-utils.ts` each wrote `!isEnoent(e) && !isEnotdir(e)` inline.
 *
 * The consequence of a copy drifting is not cosmetic. Every one of those call sites uses the answer
 * to decide whether to swallow the error: a copy that counted `EACCES` as "absent" would turn a
 * permission error into "there is no config file here" and silently drop a user's configuration,
 * which is the invisible loss Law 10 exists to prevent. So the membership of that set is pinned here
 * code by code, including the ones that must NOT be in it.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent, isEnotdir, isMissingPath } from "@veyyon/utils";
import { collectPackageSources } from "./support/package-sources";

/** An error shaped like the one a real `fs` call throws. */
function fsError(code: string): NodeJS.ErrnoException {
	const error = new Error(`${code}: synthetic`) as NodeJS.ErrnoException;
	error.code = code;
	return error;
}

describe("isMissingPath", () => {
	it("counts ENOENT, the path that simply is not there", () => {
		expect(isMissingPath(fsError("ENOENT"))).toBe(true);
	});

	it("counts ENOTDIR, which is the same fact reached through a non-directory component", () => {
		// `a/file.txt/lsp.json` fails with ENOTDIR, and nothing can exist below a file, so
		// there is no config there either. Every call site that got this wrong reported a
		// spurious warning on a perfectly ordinary probe miss.
		expect(isMissingPath(fsError("ENOTDIR"))).toBe(true);
	});

	it("does NOT count the codes that mean the path exists and could not be read", () => {
		// The load-bearing half. Each of these was one drifting copy away from being
		// swallowed as "nothing here", which is how a readable-looking config silently
		// stops taking effect.
		for (const code of ["EACCES", "EPERM", "EISDIR", "ELOOP", "EIO", "EMFILE", "ENFILE", "EBUSY", "ENAMETOOLONG"]) {
			expect(isMissingPath(fsError(code)), `${code} must not read as an absent path`).toBe(false);
		}
	});

	it("does not count a non-filesystem error", () => {
		// A `TypeError` from the code inside the `try` block reaches the same catch. Treating
		// it as a missing file would hide a real defect behind a benign-looking path miss.
		expect(isMissingPath(new TypeError("cannot read properties of undefined"))).toBe(false);
		expect(isMissingPath(new Error("no code at all"))).toBe(false);
	});

	it("does not count values that are not errors at all", () => {
		expect(isMissingPath(undefined)).toBe(false);
		expect(isMissingPath(null)).toBe(false);
		expect(isMissingPath("ENOENT")).toBe(false);
		expect(isMissingPath({ code: "ENOENT" })).toBe(false);
	});

	it("is exactly the union of the two primitives, with nothing added or removed", () => {
		// The owner is defined in terms of `isEnoent`/`isEnotdir`, and those stay legitimate on
		// their own where a caller genuinely needs one specific code. This pins the relation so
		// a future edit cannot quietly widen the union.
		for (const code of ["ENOENT", "ENOTDIR", "EACCES", "EISDIR", "EEXIST", "ENOTEMPTY"]) {
			const error = fsError(code);
			expect(isMissingPath(error), code).toBe(isEnoent(error) || isEnotdir(error));
		}
	});

	it("narrows the type so the caller can read the code", () => {
		// A type guard, not a boolean helper: call sites log `err.code` right after the check.
		const error: unknown = fsError("ENOENT");
		if (!isMissingPath(error)) throw new Error("guard should have matched");
		expect(error.code).toBe("ENOENT");
	});
});

describe("the repository", () => {
	it("re-spells the absent-path union nowhere", async () => {
		// The lock. A seventh inline copy would behave identically on the day it was written
		// and drift the first time someone reconsidered whether EISDIR counts — which is
		// precisely the failure no behavioural test can catch, so the SOURCE is asserted.
		// The walk itself comes from the shared owner, which is what keeps every ownership
		// lock in this package agreeing on what "a package source file" is.
		const patterns = [
			/isEnoent\([^)]*\)\s*\|\|\s*isEnotdir\(/,
			/!isEnoent\([^)]*\)\s*&&\s*!isEnotdir\(/,
			/hasFsCode\([^,]+,\s*"ENOENT"\)\s*\|\|\s*hasFsCode\([^,]+,\s*"ENOTDIR"\)/,
			/code === "ENOENT" \|\| code === "ENOTDIR"/,
		];

		const offenders = (await collectPackageSources())
			.filter(({ rel }) => rel !== "utils/src/fs-error.ts")
			.filter(({ text }) => patterns.some(pattern => pattern.test(text)))
			.map(({ rel }) => rel);

		expect(offenders, "inline absent-path union — import isMissingPath from @veyyon/utils instead").toEqual([]);
	});
});

describe("the codes a real filesystem produces", () => {
	/**
	 * The synthetic errors above prove the predicate; these prove the premise. If Bun or the
	 * platform ever reported a missing file with a different code, every quiet-probe path in the
	 * repo would start warning on ordinary misses, and no synthetic test would notice.
	 */
	let dir: string;

	it("reports a missing file as ENOENT", () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-missing-path-"));
		try {
			let caught: unknown;
			try {
				fs.readFileSync(path.join(dir, "absent.json"), "utf-8");
			} catch (error) {
				caught = error;
			}
			expect(isMissingPath(caught)).toBe(true);
			expect((caught as NodeJS.ErrnoException).code).toBe("ENOENT");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reports a path under a regular file as ENOTDIR", () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-missing-path-"));
		try {
			fs.writeFileSync(path.join(dir, "file"), "x");
			let caught: unknown;
			try {
				fs.readFileSync(path.join(dir, "file", "lsp.json"), "utf-8");
			} catch (error) {
				caught = error;
			}
			expect(isMissingPath(caught)).toBe(true);
			expect((caught as NodeJS.ErrnoException).code).toBe("ENOTDIR");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reports reading a directory as EISDIR, which is NOT absence", () => {
		// This is why `EISDIR` is excluded: a directory named `lsp.json` is a mistake that
		// leaves the config permanently ineffective, and the user needs to hear about it.
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-missing-path-"));
		try {
			fs.mkdirSync(path.join(dir, "lsp.json"));
			let caught: unknown;
			try {
				fs.readFileSync(path.join(dir, "lsp.json"), "utf-8");
			} catch (error) {
				caught = error;
			}
			expect(isMissingPath(caught)).toBe(false);
			expect((caught as NodeJS.ErrnoException).code).toBe("EISDIR");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

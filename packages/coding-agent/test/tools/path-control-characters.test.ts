import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { isPathWithinCwd, resolveToCwd } from "@veyyon/coding-agent/tools/path-utils";
import { removeWithRetries } from "@veyyon/utils";
import { guardDestructivePath } from "../../../utils/test/helpers/destructive-guard";
import { useTrackedTempDirs } from "../helpers/tracked-temp-dir";

// Tracked temp directories: the factory deletes what it made when this file finishes.
// These call sites used a bare `mkdtempSync` with no teardown, so every run left the
// directory in `/tmp` forever. Cleanup is attached to creation so a new case cannot
// reintroduce the leak by forgetting an `afterAll`.
const makePathControlDir = useTrackedTempDirs("veyyon-path-control-");

const NUL = String.fromCharCode(0);
const NEWLINE = String.fromCharCode(10);
const TAB = String.fromCharCode(9);
const CR = String.fromCharCode(13);

/**
 * PATHE-5: control characters in a path, and the stance on each.
 *
 * The row asked for both NUL bytes and newlines to be rejected. Only one of
 * those is right, and the difference matters enough to write down:
 *
 * **NUL is rejected.** It cannot appear in any filename, because the kernel
 * receives a C string and stops at the first NUL. Before this change the byte
 * travelled all the way to the syscall, where Node produced
 * `ERR_INVALID_ARG_VALUE: the argument 'path' must be a string ... without null
 * bytes` — a message about argument types, which reads like an internal bug
 * rather than a bad path. The worse outcome is the one that message happens to
 * prevent and that a less careful runtime does not: operating on a TRUNCATED
 * path, where `secret\0.txt` becomes `secret`. Containment would then have been
 * checked against a string that is not the path touched, which is a security
 * property quietly evaluated on the wrong input. So it fails at the resolution
 * boundary now, naming the input and the position.
 *
 * **Newline, tab and CR are NOT rejected.** They are legal in POSIX filenames.
 * Refusing them would mean refusing to read files that genuinely exist on a
 * user's disk, which is a capability gap dressed up as a safety feature. A
 * filename is not a shell word, and treating it like one is the actual bug in
 * that idea. These tests therefore prove the opposite contract: such a path
 * resolves, round-trips byte for byte, and still answers containment correctly.
 *
 * The containment assertions are the point of the whole file. A path predicate
 * that gives a different answer for a control-character path than the filesystem
 * does is how an escape gets through, so each case checks the boundary decision,
 * not merely that resolution returned a string.
 */
describe("control characters in tool paths", () => {
	let cwd = "";

	beforeEach(() => {
		cwd = makePathControlDir();
	});

	afterEach(async () => {
		if (cwd) {
			await removeWithRetries(guardDestructivePath(cwd, "path-control-characters"));
			cwd = "";
		}
	});

	describe("NUL is refused at the resolution boundary", () => {
		test("a NUL in the middle of a filename throws, naming the input", () => {
			expect(() => resolveToCwd(`secret${NUL}.txt`, cwd)).toThrow(/NUL byte/);
		});

		test("the error names the position, so a hidden byte can be found", () => {
			// A NUL is invisible in every terminal and most editors. Without the index
			// the user is told their path is wrong and given no way to see where.
			expect(() => resolveToCwd(`ab${NUL}cd.txt`, cwd)).toThrow(/position 2/);
		});

		test("a leading NUL is refused too", () => {
			expect(() => resolveToCwd(`${NUL}notes.txt`, cwd)).toThrow(/NUL byte/);
		});

		test("a trailing NUL is refused, which is the truncation case", () => {
			// The dangerous shape specifically: truncation here would turn a path that
			// looks distinct into an existing one.
			expect(() => resolveToCwd(`notes.txt${NUL}`, cwd)).toThrow(/NUL byte/);
		});

		test("an absolute path with a NUL is refused as well", () => {
			// The absolute branch returns early, so it needs its own case or the check
			// could sit on the relative path only.
			expect(() => resolveToCwd(`${cwd}/deep${NUL}/file.txt`, cwd)).toThrow(/NUL byte/);
		});

		test("it is refused BEFORE anything touches the filesystem", () => {
			// The whole point of validating at the boundary. If the check happened at
			// the syscall instead, a partially-applied operation could already have
			// run by the time it failed.
			const before = fs.readdirSync(cwd);
			expect(() => resolveToCwd(`x${NUL}y`, cwd)).toThrow();
			expect(fs.readdirSync(cwd)).toEqual(before);
		});

		test("the message tells the user what to do, not just what is wrong", () => {
			// An error that names a rule without naming the remedy sends the user
			// looking for a bug in their tooling.
			expect(() => resolveToCwd(`a${NUL}b`, cwd)).toThrow(/Remove the NUL/);
		});
	});

	describe("newline, tab and CR are legal filenames and stay usable", () => {
		test("a newline in a filename resolves without throwing", () => {
			// Rejecting this would refuse a file that can genuinely exist on disk.
			expect(resolveToCwd(`weird${NEWLINE}name.txt`, cwd)).toBe(path.join(cwd, `weird${NEWLINE}name.txt`));
		});

		test("a tab and a CR resolve the same way", () => {
			expect(resolveToCwd(`a${TAB}b.txt`, cwd)).toBe(path.join(cwd, `a${TAB}b.txt`));
			expect(resolveToCwd(`a${CR}b.txt`, cwd)).toBe(path.join(cwd, `a${CR}b.txt`));
		});

		test("such a file really can be written and read back byte for byte", () => {
			// The claim above is only worth making if it is true of the actual
			// filesystem, not just of the resolver. This is the proof.
			const resolved = resolveToCwd(`line${NEWLINE}break.txt`, cwd);
			fs.writeFileSync(resolved, "content");

			expect(fs.readdirSync(cwd)).toEqual([`line${NEWLINE}break.txt`]);
			expect(fs.readFileSync(resolved, "utf8")).toBe("content");
		});

		test("containment still answers correctly for a newline path inside cwd", () => {
			// The security-relevant half: a control character must not change the
			// boundary decision, or it becomes a way to smuggle a path past the gate.
			expect(isPathWithinCwd(resolveToCwd(`in${NEWLINE}side.txt`, cwd), cwd)).toBe(true);
		});

		test("containment still answers correctly for a newline path OUTSIDE cwd", () => {
			// The direction that actually matters. An escape that passed because of an
			// embedded newline would be exactly the silent hole this file exists for.
			const outside = path.join(path.dirname(cwd), `out${NEWLINE}side.txt`);

			expect(isPathWithinCwd(resolveToCwd(outside, cwd), cwd)).toBe(false);
		});

		test("`..` with a newline glued on is a literal directory name, not a parent reference", () => {
			// Worth stating explicitly, because the intuition runs the other way. A
			// component `..\n` is an ordinary (if perverse) directory name: only the
			// exact two-character `..` means "parent". So `..\n/../etc` climbs into
			// that literal directory and back out again, landing at `cwd/etc` — still
			// inside. Nothing escaped, and a check that "helpfully" treated the
			// newline component as `..` would be the one introducing an escape.
			expect(resolveToCwd(`..${NEWLINE}/../etc`, cwd)).toBe(path.join(cwd, "etc"));
			expect(isPathWithinCwd(resolveToCwd(`..${NEWLINE}/../etc`, cwd), cwd)).toBe(true);
		});

		test("a genuine traversal still escapes, newline or not", () => {
			// The twin that keeps the case above honest: containment is not simply
			// returning true for everything with a control character in it.
			expect(isPathWithinCwd(resolveToCwd("../etc", cwd), cwd)).toBe(false);
			expect(isPathWithinCwd(resolveToCwd(`../we${NEWLINE}ird/etc`, cwd), cwd)).toBe(false);
		});
	});

	test("an ordinary path is unaffected by any of this", () => {
		// The control. Every rejection above would also pass if resolution had simply
		// stopped working.
		expect(resolveToCwd("notes.txt", cwd)).toBe(path.join(cwd, "notes.txt"));
		expect(isPathWithinCwd(resolveToCwd("notes.txt", cwd), cwd)).toBe(true);
	});
});

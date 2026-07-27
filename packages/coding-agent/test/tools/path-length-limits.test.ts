/**
 * A path that cannot fit the filesystem's name limits is refused with an error
 * that says which limit, not with a raw errno from the syscall.
 *
 * WHY THIS SUITE EXISTS. Before this check, an over-long path reached the
 * syscall and came back as:
 *
 *     ENAMETOOLONG: name too long, open '<the entire 300-character path>'
 *
 * That names an errno and then buries the only useful part under the offending
 * string. It does not say which limit was hit, which component was too long, or
 * by how much, and on a write it arrives only after the tool has already decided
 * the path was acceptable. `resolveToCwd` is the one place tool paths resolve,
 * so the check belongs there beside the existing NUL-byte guard.
 *
 * The limits are measured in BYTES, which is the part that is easy to get wrong.
 * `NAME_MAX` applies to the encoded name, so a 70-character emoji filename is
 * 280 bytes and must be refused even though a character count would pass it at
 * 70. A test suite that only used ASCII would never notice the difference.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveToCwd } from "@veyyon/coding-agent/tools/path-utils";
import { removeWithRetries } from "@veyyon/utils";
import { guardDestructivePath } from "../../../utils/test/helpers/destructive-guard";
import { useTrackedTempDirs } from "../helpers/tracked-temp-dir";

// Tracked temp directories: the factory deletes what it made when this file finishes.
// These call sites used a bare `mkdtempSync` with no teardown, so every run left the
// directory in `/tmp` forever. Cleanup is attached to creation so a new case cannot
// reintroduce the leak by forgetting an `afterAll`.
const makePathLengthRealDir = useTrackedTempDirs("veyyon-path-length-real-");

const CWD = "/tmp/project";

describe("per-component filename limit", () => {
	/** The common real case: a filename generated from a title, an error message,
	 * or a URL, which sails past 255 bytes without anyone counting. */
	it("refuses a component over the 255-byte limit and says so", () => {
		const name = `${"x".repeat(300)}.txt`;
		expect(() => resolveToCwd(name, CWD)).toThrow(/304 bytes.*255-byte filename limit/s);
	});

	/** The message must carry the actual numbers. "Path too long" sends the reader
	 * back to counting characters by hand, which is how the byte/character
	 * confusion below survives. */
	it("names both the measured size and the limit", () => {
		let message = "";
		try {
			resolveToCwd("z".repeat(300), CWD);
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toContain("300 bytes");
		expect(message).toContain("255-byte filename limit");
	});

	/** Boundary, lower side. 255 is the limit, not one under it, and an
	 * off-by-one here refuses filenames the filesystem accepts. */
	it("accepts a component of exactly 255 bytes", () => {
		const name = "z".repeat(255);
		expect(resolveToCwd(name, CWD)).toBe(`${CWD}/${name}`);
	});

	/** Boundary, upper side. */
	it("refuses a component of 256 bytes", () => {
		expect(() => resolveToCwd("z".repeat(256), CWD)).toThrow(/256 bytes/);
	});

	/**
	 * THE subtlety this suite exists to pin. Seventy emoji are seventy characters
	 * and 280 bytes. A character-counting check passes this and the write then
	 * fails at the syscall, which is the exact failure the guard was added to
	 * prevent.
	 */
	it("counts bytes, not characters, so a short emoji name can still be too long", () => {
		const name = "\u{1F600}".repeat(70);
		expect(name.length).toBeLessThan(255);
		expect(() => resolveToCwd(name, CWD)).toThrow(/280 bytes/);
	});

	/** The other side of the same rule: a multi-byte name that fits must not be
	 * refused. Over-strict validation would make non-ASCII filenames unusable. */
	it("accepts a multi-byte name that fits within the byte limit", () => {
		const name = "\u{1F600}".repeat(40);
		expect(resolveToCwd(name, CWD)).toBe(`${CWD}/${name}`);
	});

	/**
	 * The fast path skips exact measurement only when a component cannot possibly
	 * reach the limit (at most 85 UTF-16 units, since UTF-8 never exceeds 3 bytes
	 * per unit). A 100-character ASCII name is past that threshold, so it takes
	 * the exact branch and must still be ACCEPTED. This is the case a wrong
	 * threshold would turn into a spurious rejection.
	 */
	it("accepts a name past the fast-path threshold but under the real limit", () => {
		const name = "a".repeat(100);
		expect(name.length).toBeGreaterThan(85);
		expect(resolveToCwd(name, CWD)).toBe(`${CWD}/${name}`);
	});

	/** A long segment in the MIDDLE fails too. The kernel checks every component,
	 * so checking only the basename would pass a path that cannot be created. */
	it("refuses an over-long directory component, not just the filename", () => {
		expect(() => resolveToCwd(`${"d".repeat(300)}/ok.txt`, CWD)).toThrow(/255-byte filename limit/);
	});

	/** The error must identify the offending path, or the operator cannot tell
	 * which of several inputs was rejected. */
	it("quotes the offending input in the message", () => {
		let message = "";
		try {
			resolveToCwd(`${"q".repeat(300)}.txt`, CWD);
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toContain("qqq");
	});
});

describe("whole-path limit", () => {
	/** A path can be far under the total limit and still fail on one component,
	 * and it can also be the reverse: every component legal, the total not. */
	it("refuses a path over the total byte limit", () => {
		const deep = Array.from({ length: 1400 }, () => "dir").join("/");
		expect(() => resolveToCwd(`${deep}/f.txt`, CWD)).toThrow(/total path limit/);
	});

	/** A deep but legal tree must keep working; this is ordinary in a real
	 * monorepo and refusing it would be a regression, not a safety win. */
	it("accepts a deep path that stays under the limit", () => {
		const deep = Array.from({ length: 300 }, () => "dir").join("/");
		expect(resolveToCwd(`${deep}/f.txt`, CWD)).toBe(`${CWD}/${deep}/f.txt`);
	});

	/**
	 * The total is measured on the RESOLVED path. A short relative path under a
	 * deep cwd is what the syscall actually receives, so measuring the raw input
	 * would let it through and fail later.
	 */
	it("measures the resolved path, not the raw input", () => {
		const deepCwd = `/tmp/${Array.from({ length: 1400 }, () => "dir").join("/")}`;
		expect(() => resolveToCwd("f.txt", deepCwd)).toThrow(/total path limit/);
	});
});

describe("ordinary paths are unaffected", () => {
	/** The guard must be invisible in normal use. A validation change that alters
	 * everyday resolution is a regression regardless of what it prevents. */
	it("resolves a normal relative path unchanged", () => {
		expect(resolveToCwd("src/a.ts", CWD)).toBe(`${CWD}/src/a.ts`);
	});

	/** Absolute paths take a different branch in `resolveToCwd`, so they need
	 * their own check that the guard did not disturb them. */
	it("resolves a normal absolute path unchanged", () => {
		expect(resolveToCwd("/etc/hosts", CWD)).toBe("/etc/hosts");
	});

	/** The bare-root alias short-circuits before the length check; pin that the
	 * new code did not reorder it. */
	it("keeps the bare-root workspace alias", () => {
		expect(resolveToCwd("/", CWD)).toBe(CWD);
	});
});

describe("the NUL guard still fires first", () => {
	/**
	 * A NUL is the more dangerous defect: a truncated path silently targets a
	 * different file than the one a containment check approved. If a length error
	 * preempted it, an over-long path carrying a NUL would be reported as merely
	 * too long, and the truncation risk would go unmentioned.
	 */
	it("reports the NUL, not the length, when a path has both problems", () => {
		// `\0`, not a literal NUL byte: a raw NUL makes git treat this whole file
		// as binary, so every diff of it becomes unreviewable. Same runtime value.
		const bad = `${"x".repeat(300)}\0.txt`;
		expect(() => resolveToCwd(bad, CWD)).toThrow(/NUL byte/);
	});
});

describe("the limits match what the filesystem actually enforces", () => {
	/**
	 * Everything above tests the guard against its own constants, which proves the
	 * guard is self-consistent and nothing more. If 255 were simply the wrong
	 * number, every test in this file would still pass while the tool refused
	 * filenames the kernel accepts, or accepted ones it does not.
	 *
	 * These two ground the constants in the real filesystem. They are the reason
	 * the numbers can be trusted, and the tests that would fail first on a platform
	 * whose limits differ.
	 */
	let dir = "";

	beforeEach(() => {
		dir = makePathLengthRealDir();
	});

	afterEach(async () => {
		if (dir) {
			await removeWithRetries(guardDestructivePath(dir, "path-length-limits"));
			dir = "";
		}
	});

	it("really does reject a 256-byte name, one byte over the guard's limit", () => {
		expect(() => fs.writeFileSync(path.join(dir, "z".repeat(256)), "x")).toThrow(/ENAMETOOLONG/);
	});

	it("really does accept a 255-byte name, exactly at the guard's limit", () => {
		const name = "z".repeat(255);
		fs.writeFileSync(path.join(dir, name), "x");

		// Read back BY NAME, not merely "some file exists": a truncated write would
		// leave a shorter name here and still satisfy a count.
		expect(fs.readdirSync(dir)).toEqual([name]);
		expect(fs.readFileSync(path.join(dir, name), "utf8")).toBe("x");
	});
});

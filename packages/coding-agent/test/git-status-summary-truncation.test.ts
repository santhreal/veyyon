import { describe, expect, it } from "bun:test";
import * as git from "@veyyon/coding-agent/utils/git";

/**
 * What the status counts mean when git's output did not all fit.
 *
 * `git status --porcelain` prints one line per changed file, and veyyon reads it
 * through a reader that stops at an 8 MiB cap and appends a notice saying so.
 * That cap is the right call: a repository with hundreds of thousands of
 * untracked files must not be able to make the status line allocate without
 * bound. What was wrong was everything after it.
 *
 * The parser did not know the notice existed. It is prose sitting in the middle
 * of machine-readable text, and its first two characters are `[g`, so the loop
 * scored it as both a staged and an unstaged file. A repository big enough to
 * hit the cap therefore reported ONE PHANTOM CHANGE on top of counts that were
 * already short, and reported all of it as though it were exact.
 *
 * That is the failure worth locking out, because it is silent in the worst way:
 * the number is plausible, stable across refreshes, and simply wrong. The counts
 * are now lower bounds and say so, and the status line renders them with a `+`
 * rather than as a total.
 *
 * These drive the exported parser on the exact bytes the reader produces. Making
 * a real repository big enough to overrun 8 MiB would take hundreds of thousands
 * of files and minutes per run, and would test the cap rather than the parsing
 * of a capped result, which is where the defect was.
 */

/** The notice the capped reader appends, byte for byte. */
const TRUNCATION_NOTICE = "[git subprocess output truncated after 8 MiB]";

describe("status counts from output that fit", () => {
	/**
	 * The ordinary case, and the floor for everything below: without it a parser
	 * that reported every result as truncated would still pass the truncation
	 * tests while making the common status line permanently wrong.
	 */
	it("counts staged, unstaged and untracked entries exactly", () => {
		const summary = git.status.parse(["M  staged.ts", " M unstaged.ts", "?? untracked.ts"].join("\n"));

		expect(summary).toEqual({ staged: 1, truncated: false, unstaged: 1, untracked: 1 });
	});

	/** A file both staged and further modified counts once in each column. */
	it("counts a file that is staged and then modified again in both columns", () => {
		const summary = git.status.parse("MM both.ts");

		expect(summary).toEqual({ staged: 1, truncated: false, unstaged: 1, untracked: 0 });
	});

	/** A clean tree is all zeros and, importantly, not truncated. */
	it("reports zeros for a clean tree", () => {
		expect(git.status.parse("")).toEqual({ staged: 0, truncated: false, unstaged: 0, untracked: 0 });
	});

	/**
	 * A renamed file's `->` arrow must not be mistaken for a second entry, since
	 * it appears on the same line as the status codes.
	 */
	it("counts a rename as a single staged entry", () => {
		const summary = git.status.parse("R  old.ts -> new.ts");

		expect(summary).toEqual({ staged: 1, truncated: false, unstaged: 0, untracked: 0 });
	});
});

describe("status counts from output that was cut at the cap", () => {
	/**
	 * THE regression. The notice was counted as a changed file, inventing one
	 * staged and one unstaged entry that do not exist. Asserted with exact
	 * numbers, because an assertion that merely checked the counts were positive
	 * would have passed against the bug.
	 */
	it("does not count the truncation notice as a changed file", () => {
		const summary = git.status.parse(["M  a.ts", " M b.ts", TRUNCATION_NOTICE].join("\n"));

		expect(summary.staged).toBe(1);
		expect(summary.unstaged).toBe(1);
		expect(summary.untracked).toBe(0);
	});

	/**
	 * And it reports that the answer is partial. Without this the counts would be
	 * clean but still presented as totals, which is the same lie told quietly:
	 * every caller would keep treating a lower bound as exact.
	 */
	it("marks the summary as truncated", () => {
		const summary = git.status.parse(["?? a.ts", TRUNCATION_NOTICE].join("\n"));

		expect(summary.truncated).toBe(true);
		expect(summary.untracked).toBe(1);
	});

	/**
	 * The notice arrives at the END of the stream, after a line that was itself
	 * cut mid-way. The partial line is still a real entry and must be counted;
	 * dropping it would trade one silent undercount for another.
	 */
	it("still counts a final entry that was cut off mid-line", () => {
		const summary = git.status.parse(["?? a.ts", "?? partially-writ", TRUNCATION_NOTICE].join("\n"));

		expect(summary.untracked).toBe(2);
		expect(summary.truncated).toBe(true);
	});

	/**
	 * Untruncated output must never be flagged, or the status line would show its
	 * "at least" suffix on every ordinary repository and the signal would mean
	 * nothing.
	 */
	it("does not flag output that merely mentions the notice inside a filename", () => {
		// A file can be named anything, including something containing the notice
		// text. Only a line that IS the notice counts as one.
		const summary = git.status.parse(`?? weird ${TRUNCATION_NOTICE} name.ts`);

		expect(summary.truncated).toBe(false);
		expect(summary.untracked).toBe(1);
	});
});

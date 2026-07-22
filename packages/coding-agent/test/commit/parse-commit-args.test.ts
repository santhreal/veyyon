import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { parseCommitArgs } from "../../src/commit/cli";

/**
 * parseCommitArgs turns the raw `veyyon commit ...` argv tail into a typed options
 * object. It had no test. The contracts pinned here:
 *   - it returns undefined (declines) unless argv[0] is exactly "commit";
 *   - bare `commit` yields the all-false defaults;
 *   - the boolean flags (--push, --dry-run, --no-changelog, --legacy) set their
 *     fields; -c/-m are aliases for --context/--model;
 *   - --context/--model consume the FOLLOWING token as their value;
 *   - --help/-h are accepted no-ops;
 *   - a non-flag positional (does not start with "-") is ignored;
 *   - a value-taking flag with a missing/flag-looking value, and an unknown flag,
 *     each write an error and call process.exit(1).
 * A regression would drop a flag, swallow the next arg as a value, or fail to
 * reject a typo'd flag.
 */

describe("parseCommitArgs parsing", () => {
	it("declines (undefined) when argv is empty or does not start with commit", () => {
		expect(parseCommitArgs([])).toBeUndefined();
		expect(parseCommitArgs(["status"])).toBeUndefined();
	});

	it("returns all-false defaults for a bare commit", () => {
		expect(parseCommitArgs(["commit"])).toEqual({ push: false, dryRun: false, noChangelog: false });
	});

	it("sets every boolean flag", () => {
		expect(parseCommitArgs(["commit", "--push", "--dry-run", "--no-changelog", "--legacy"])).toEqual({
			push: true,
			dryRun: true,
			noChangelog: true,
			legacy: true,
		});
	});

	it("reads --context and --model values, preserving a space in the value", () => {
		expect(parseCommitArgs(["commit", "--context", "hello world", "--model", "gpt-5"])).toEqual({
			push: false,
			dryRun: false,
			noChangelog: false,
			context: "hello world",
			model: "gpt-5",
		});
	});

	it("treats -c/-m as aliases for --context/--model", () => {
		expect(parseCommitArgs(["commit", "-c", "hi", "-m", "m1"])).toEqual({
			push: false,
			dryRun: false,
			noChangelog: false,
			context: "hi",
			model: "m1",
		});
	});

	it("accepts --help as a no-op and ignores a non-flag positional", () => {
		expect(parseCommitArgs(["commit", "--help"])).toEqual({ push: false, dryRun: false, noChangelog: false });
		expect(parseCommitArgs(["commit", "somefile.ts", "--push"])).toEqual({
			push: true,
			dryRun: false,
			noChangelog: false,
		});
	});
});

describe("parseCommitArgs error handling", () => {
	let exitSpy: ReturnType<typeof spyOn>;
	let stderrSpy: ReturnType<typeof spyOn>;

	afterEach(() => {
		exitSpy?.mockRestore();
		stderrSpy?.mockRestore();
	});

	function armExit(): void {
		// Make process.exit throw so parsing stops exactly where the real exit would,
		// and swallow the chalk-red stderr line so the test output stays clean.
		exitSpy = spyOn(process, "exit").mockImplementation((() => {
			throw new Error("__exit__");
		}) as never);
		stderrSpy = spyOn(process.stderr, "write").mockImplementation((() => true) as never);
	}

	it("exits(1) when --context is given without a value", () => {
		armExit();
		expect(() => parseCommitArgs(["commit", "--context"])).toThrow("__exit__");
		expect(exitSpy).toHaveBeenCalledWith(1);
	});

	it("exits(1) when --model's value looks like another flag", () => {
		armExit();
		expect(() => parseCommitArgs(["commit", "--model", "--push"])).toThrow("__exit__");
		expect(exitSpy).toHaveBeenCalledWith(1);
	});

	it("exits(1) on an unknown flag", () => {
		armExit();
		expect(() => parseCommitArgs(["commit", "--bogus"])).toThrow("__exit__");
		expect(exitSpy).toHaveBeenCalledWith(1);
	});
});

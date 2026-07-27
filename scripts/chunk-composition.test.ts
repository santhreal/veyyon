/**
 * A failing chunk names the files it ran.
 *
 * WHY THIS SUITE EXISTS. The TS runner splits a bucket's sorted file list into
 * chunks and runs each in its own `bun test` process, so a suite can pass alone
 * and fail in chunk 109 purely because of what shares that process: a module-level
 * cache, a temp config root another file owns, a leaked global. WHICH files landed
 * in the chunk is therefore the entire lead, and the runner used to print only the
 * command on one long line. Recovering the composition meant reconstructing the
 * partition by hand from the runner source, which cost an hour on
 * `markit-mupdf-warnings.test.ts` and is recorded in BACKLOG.md as the reason this
 * output exists.
 *
 * The command already carries the file list, so the fix is extraction rather than
 * plumbing. These tests pin the extraction against the shapes the runner really
 * produces, because a regex that silently matches nothing would restore exactly
 * the silence this replaced.
 */
import { describe, expect, it } from "bun:test";
import { chunkTestFiles, formatChunkFailure } from "./ci-test-ts";

/** A chunk outcome shaped like the runner's, with the command under test. */
function outcome(command: string) {
	return {
		label: "packages/coding-agent (native bucket; chunk 109/120)",
		command,
		exitCode: 1,
		seconds: 12.5,
		output: "",
	};
}

describe("chunkTestFiles", () => {
	/**
	 * The real shape: a preload path, flags, then the files. The preload is a `.ts`
	 * file too and must NOT be counted, or every chunk would report one phantom
	 * member.
	 */
	it("takes the test files and not the preload or the flags", () => {
		const command =
			"bun test --preload /repo/packages/utils/test/helpers/real-data-tripwire.ts --parallel=1 --only-failures " +
			"packages/coding-agent/test/utils/markit-mupdf-warnings.test.ts packages/coding-agent/test/utils/a.test.ts";

		expect(chunkTestFiles(command)).toEqual([
			"packages/coding-agent/test/utils/markit-mupdf-warnings.test.ts",
			"packages/coding-agent/test/utils/a.test.ts",
		]);
	});

	/** Quoted paths, which `shellQuote` produces for anything with a shell character. */
	it("reads a quoted path", () => {
		expect(chunkTestFiles("bun test 'packages/x/test/a b.test.ts' packages/x/test/c.test.ts")).toEqual([
			"packages/x/test/a b.test.ts",
			"packages/x/test/c.test.ts",
		]);
	});

	/** `.test.tsx` counts: the UI bucket has them and they chunk like any other file. */
	it("reads a tsx suite", () => {
		expect(chunkTestFiles("bun test packages/tui/test/render.test.tsx")).toEqual([
			"packages/tui/test/render.test.tsx",
		]);
	});

	/** A command with no suites yields nothing rather than throwing. */
	it("returns nothing for a command that runs no suites", () => {
		expect(chunkTestFiles("bun run check:ts")).toEqual([]);
	});
});

describe("formatChunkFailure", () => {
	/**
	 * The composition is printed, one file per line, with a count.
	 *
	 * The output an investigation actually reads. Asserting the count as well as the
	 * names catches a truncating formatter, which would look right in a short case
	 * and hide half of a real ten-file chunk.
	 */
	it("lists every file of a failing chunk", () => {
		const report = formatChunkFailure(
			outcome("bun test packages/x/test/a.test.ts packages/x/test/b.test.ts packages/x/test/c.test.ts"),
			false,
		);

		expect(report).toContain("3 files in this chunk:");
		for (const file of ["packages/x/test/a.test.ts", "packages/x/test/b.test.ts", "packages/x/test/c.test.ts"]) {
			expect(report).toContain(file);
		}
	});

	/**
	 * A single-file command says nothing extra.
	 *
	 * There is no composition to explain when one file ran, and the label and command
	 * already name it; a "1 files in this chunk" line would be noise on every
	 * ordinary package failure.
	 */
	it("stays quiet when the chunk is one file", () => {
		const report = formatChunkFailure(outcome("bun test packages/x/test/only.test.ts"), false);

		expect(report).not.toContain("files in this chunk");
		expect(report).toContain("packages/x/test/only.test.ts");
	});
});

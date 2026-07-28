/**
 * What may live where in this test tree.
 *
 * WHY THIS SUITE EXISTS. Eight files that are not suites sat at the root of
 * `test/` beside the suites: two shared helpers, one subprocess fixture, one
 * type-only assertion, and four scripts a human runs by hand. Nothing was wrong
 * with any of them individually. The problem was that the root stopped meaning
 * anything: a reader could no longer tell from a listing what runs in the gate,
 * and three of the four scripts read as committed scratch, because a script with
 * no header does not say whether it is load-bearing or a leftover.
 *
 * So the tree has homes, and this suite is what keeps them:
 *
 * - `test/**\/*.test.ts` are the suites, and at the ROOT that is all there is.
 * - `test/helpers/` and `test/support/` hold code the suites import.
 * - `test/fixtures/` holds data.
 * - `test/typecheck/` holds files that assert by compiling, which have no runtime
 *   behavior to check and would be an empty suite if written as one.
 * - `test/probes/` holds scripts a human runs, each stating what question it
 *   answers and how to run it, because that header is the difference between a
 *   diagnostic and abandoned scratch.
 *
 * The rules are asserted rather than written down in a document, since a listing
 * that drifts is exactly what happened here.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";

const TEST_ROOT = path.resolve(import.meta.dir);

/** Names directly inside `test/`, split into files and directories. */
function rootEntries(): { files: string[]; dirs: string[] } {
	const entries = readdirSync(TEST_ROOT, { withFileTypes: true });
	return {
		files: entries
			.filter(entry => entry.isFile())
			.map(entry => entry.name)
			.sort(),
		dirs: entries
			.filter(entry => entry.isDirectory())
			.map(entry => entry.name)
			.sort(),
	};
}

describe("coding-agent test tree layout", () => {
	/**
	 * NON-VACUITY: the walk found the tree it is about to make claims over.
	 *
	 * Without it every rule below passes on an empty listing, which is what a moved
	 * or renamed directory would produce.
	 */
	it("reads a test root that holds the suites", () => {
		const { files, dirs } = rootEntries();

		expect(files.filter(name => name.endsWith(".test.ts")).length).toBeGreaterThan(500);
		expect(dirs).toContain("helpers");
		expect(dirs).toContain("fixtures");
		expect(dirs).toContain("probes");
	});

	/**
	 * Nothing but suites at the root.
	 *
	 * This is the rule the eight files broke. A helper at the root is imported as
	 * `./utilities`, which says nothing about what it holds; the same file under
	 * `helpers/` is imported as `../helpers/e2e-session`, which does.
	 */
	it("has no file at the root that is not a suite", () => {
		const strays = rootEntries().files.filter(name => !name.endsWith(".test.ts"));

		expect(
			strays,
			"move these: shared code to test/helpers, data to test/fixtures, compile-only assertions to " +
				"test/typecheck, and hand-run scripts to test/probes",
		).toEqual([]);
	});

	/**
	 * Every hand-run script says how to run it and what it is for.
	 *
	 * The header is the whole difference between a probe and scratch. Three of the
	 * four scripts here had none, and the only way to find out what
	 * `checkpoint-rpc-qa.ts` needed was to read all 204 lines of it.
	 */
	it("gives every probe a header naming its question and its command", () => {
		const dir = path.join(TEST_ROOT, "probes");
		const scripts = readdirSync(dir).filter(name => name.endsWith(".ts"));

		expect(scripts.length).toBeGreaterThanOrEqual(4);
		for (const name of scripts) {
			const text = readFileSync(path.join(dir, name), "utf8");
			const header = text.slice(0, text.indexOf("*/") + 2);

			expect(text.startsWith("/**"), `${name} should open with a doc comment`).toBe(true);
			expect(header, `${name} should say how to run it`).toContain("Run with: bun test/probes/");
			expect(header, `${name} should name what it needs`).toContain("Needs:");
			expect(header.length, `${name}'s header should explain itself, not just name a command`).toBeGreaterThan(200);
		}
	});

	/**
	 * A probe is not a suite, and must not be picked up by the runner.
	 *
	 * `bun test` globs `*.test.ts`, so a probe named `foo.test.ts` would be run in
	 * the gate: it would drive a live provider, or write ANSI to a pipe, and read as
	 * a flaky suite rather than as a misfiled script.
	 */
	it("keeps probes out of the runner's glob", () => {
		const misfiled = readdirSync(path.join(TEST_ROOT, "probes")).filter(name => name.endsWith(".test.ts"));

		expect(misfiled, "a probe named *.test.ts runs in the gate; rename it").toEqual([]);
	});

	/**
	 * A suite is named for the behavior it defends, not for a tracker number.
	 *
	 * Thirty-nine suites were named `issue-NNN-repro.test.ts`. The name is worthless
	 * twice over. Reading a listing, `issue-2510-repro` says nothing, so nobody can
	 * tell whether plan-mode toggling is covered without opening files; and running
	 * one, a failure reports a number that means nothing without the tracker, which
	 * outlives no migration. `repro` is worse than uninformative: it says the suite
	 * exists to reproduce a bug, when what it does is defend a contract, and that
	 * framing is why some of them had no doc comment explaining the contract at all.
	 *
	 * The tracker number belongs INSIDE the file, in the header that explains what
	 * broke. That keeps the traceability and costs the name nothing.
	 */
	it("names every suite for a behavior rather than a tracker number", () => {
		const offenders: string[] = [];
		const walk = (dir: string): void => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				if (entry.isDirectory()) {
					walk(path.join(dir, entry.name));
					continue;
				}
				if (!entry.name.endsWith(".test.ts")) continue;
				// A leading tracker id in any of its spellings, or `repro` anywhere. The
				// id pattern demands the digits: without them `pr` alone matches every
				// `prompt-*.test.ts` in the tree, which is how the first version of this
				// rule reported 64 innocent suites.
				if (/^(issue|bug|gh|pr)[-_]\d+[-_.]/i.test(entry.name) || /[-_]repro[-_.]/i.test(entry.name)) {
					offenders.push(path.relative(TEST_ROOT, path.join(dir, entry.name)));
				}
			}
		};
		walk(TEST_ROOT);

		expect(
			offenders,
			"name the suite for the contract it defends and put the tracker number in the file's header: " +
				"a number in a filename means nothing in a listing and nothing in a failure report",
		).toEqual([]);
	});

	/**
	 * Compile-only assertions live where their reason can be read.
	 *
	 * `dap-client-flush.typecheck.ts` exists so standard TypeScript checks
	 * `src/dap/client.ts`, including `socketToSink()` against `DapWriteSink.flush()`.
	 * It asserts nothing at runtime, which is why it is not a suite, and it has to
	 * stay inside the typechecked program to mean anything.
	 */
	it("keeps typecheck-only files in test/typecheck with a stated reason", () => {
		const dir = path.join(TEST_ROOT, "typecheck");
		const files = readdirSync(dir).filter(name => name.endsWith(".ts"));

		expect(files).toContain("dap-client-flush.typecheck.ts");
		for (const name of files) {
			const text = readFileSync(path.join(dir, name), "utf8");

			expect(name, `${name} should be named for what it checks`).toMatch(/\.typecheck\.ts$/);
			expect(text, `${name} should say which source it forces the checker through`).toMatch(/src\//);
		}
	});
});

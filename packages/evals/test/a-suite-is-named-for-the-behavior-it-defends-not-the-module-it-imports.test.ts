/**
 * WHY THIS SUITE EXISTS. Fifty-six of this package's seventy test files were once named after the
 * module they imported (`suite.test.ts`, `manager.test.ts`, `aggregate.test.ts`), so a reader who
 * changed `suite.ts` could not tell from the tree which contract covered the change, and three
 * different `suite.test.ts` files answered to the same name. Renaming them closed the incident.
 * This closes the class: a test file whose name is a module's name turns the sweep red, and the
 * opt-out set is pinned by exact equality so adding a member is a recorded decision rather than a
 * silent one.
 *
 * The variant space is read off disk at run time, so a module added under `src/` and a test added
 * under `test/` are both swept without this file being edited.
 *
 * What it does not catch: a name that is prose and still wrong ("a-thing-works"), a suite that
 * defends nothing, and a module-named test file in another package.
 */

import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { listFiles } from "../src/core/fs-walk";
import { evalsPackageDir } from "../src/paths";

/** The name a test file claims, without its `.test.ts` / `.test.tsx` suffix. */
function claimOf(testFile: string): string {
	return path.basename(testFile).replace(/\.test\.tsx?$/, "");
}

/** Test files whose claim is the bare name of a shipped module. */
export function collidingTests(moduleNames: ReadonlySet<string>, testFiles: readonly string[]): string[] {
	return testFiles.filter(file => moduleNames.has(claimOf(file))).sort();
}

/**
 * Test files allowed to carry a module's name.
 *
 * Shrink-only: a new entry needs a reason recorded beside it, and an entry whose file is renamed
 * is deleted rather than kept.
 */
const NAMED_AFTER_A_MODULE: readonly string[] = [];

async function tsFilesUnder(dir: string): Promise<string[]> {
	const files = await listFiles(path.join(evalsPackageDir(), dir));
	return files.filter(file => file.endsWith(".ts") || file.endsWith(".tsx"));
}

describe("a test file names the behavior it defends", () => {
	it("finds no suite named after a shipped module", async () => {
		const moduleNames = new Set((await tsFilesUnder("src")).map(file => claimOf(file).replace(/\.tsx?$/, "")));
		const testFiles = (await tsFilesUnder("test")).filter(file => /\.test\.tsx?$/.test(file));

		// A sweep that scanned nothing reports no collision, so both sides name one member a
		// reader can check by hand.
		expect(moduleNames.has("suite")).toBe(true);
		expect(testFiles).toContain("manager/a-store-mutation-either-lands-whole-or-not-at-all.test.ts");

		expect(collidingTests(moduleNames, testFiles)).toEqual([...NAMED_AFTER_A_MODULE]);
	});

	it("reports a module-named suite and passes a prose-named one", () => {
		const modules = new Set(["suite", "store", "fs-walk"]);

		expect(
			collidingTests(modules, [
				"suites/deep-swe/suite.test.ts",
				"manager/a-store-mutation-either-lands-whole-or-not-at-all.test.ts",
				"web/store.test.tsx",
			]),
		).toEqual(["suites/deep-swe/suite.test.ts", "web/store.test.tsx"]);
	});
});

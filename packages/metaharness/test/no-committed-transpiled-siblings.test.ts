/**
 * A TypeScript source does not get a committed `.js` twin.
 *
 * WHY THIS SUITE EXISTS (FINDING-METAHARNESS-TRANSPILED-JS-DUPLICATES-SOURCE).
 * Four transpiled copies sit committed beside their originals in
 * `adapters/edit/`: `cli.js`, `report.js`, `runner.js`, `runner.test.js`. Nothing
 * imports any of them. They are a second, STALE copy of source under the
 * one-place rule, and the staleness is not hypothetical -- `runner.js` still
 * carries the pre-registry `import benchmarkRetryPrompt from
 * "./prompts/benchmark-retry.md"` lines that `runner.ts` no longer has. A reader
 * who opens the `.js` sees prompts addressed by relative path and concludes the
 * prompt registry is not in effect here, which is wrong. `runner.js` is 67 KB of
 * it, last touched by a `wip: preserve in-flight work` commit.
 *
 * A RATCHET, because the fix and the guard are two different permissions.
 * Deleting committed files is the user's call, so the four known twins are
 * baselined and everything else is refused. The guard still does the load-bearing
 * work today: it stops a fifth copy from appearing, which is how four became four
 * in the first place. When the four are removed, the second test below fails and
 * the baseline comes out with them.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Glob } from "bun";

/** The metaharness package root, from this file's location (`test/`). */
const ROOT = path.resolve(import.meta.dir, "..");

/**
 * Transpiled twins that exist today and are not this suite's to delete.
 *
 * Only shrinks. Paths are package-relative and sorted, so a diff to this list is
 * legible in review.
 */
const BASELINE: readonly string[] = [
	"adapters/edit/cli.js",
	"adapters/edit/report.js",
	"adapters/edit/runner.js",
	"adapters/edit/runner.test.js",
];

/** Every `.js` in the package that has a `.ts` of the same name beside it. */
async function transpiledTwins(): Promise<string[]> {
	const found: string[] = [];
	for await (const file of new Glob("**/*.js").scan({ cwd: ROOT })) {
		if (file.startsWith("node_modules/") || file.includes("/dist/") || file.startsWith("dist/")) continue;
		const sibling = path.join(ROOT, `${file.slice(0, -3)}.ts`);
		if (await Bun.file(sibling).exists()) found.push(file);
	}
	return found.sort();
}

describe("no committed transpiled twins", () => {
	/**
	 * The headline. A fifth `.js` twin fails here, named, before it can accumulate
	 * the way the first four did -- none of which any commit message describes as
	 * deliberate.
	 */
	it("has no transpiled twin outside the known four", async () => {
		expect(await transpiledTwins()).toEqual([...BASELINE]);
	});

	/**
	 * And the baseline is not permanent. Once the four are deleted this fails,
	 * which is the reminder to empty `BASELINE` rather than leave a list of files
	 * that no longer exist looking like a policy.
	 */
	it("still finds every baselined twin, so their removal is noticed", async () => {
		const twins = new Set(await transpiledTwins());
		for (const file of BASELINE) {
			expect(twins.has(file), `${file} is gone — drop it from BASELINE`).toBe(true);
		}
	});

	/**
	 * The twins are stale, not merely redundant, which is why they mislead rather
	 * than just waste space. Asserted on the exact drift that makes `runner.js`
	 * dangerous: it addresses prompts by relative path, and `runner.ts` -- the file
	 * that actually runs -- does not.
	 */
	it("proves the committed runner twin disagrees with the source it was built from", async () => {
		const twin = await Bun.file(path.join(ROOT, "adapters/edit/runner.js")).text();
		const source = await Bun.file(path.join(ROOT, "adapters/edit/runner.ts")).text();

		expect(twin).toContain("./prompts/benchmark-retry.md");
		expect(source).not.toContain("./prompts/benchmark-retry.md");
	});
});

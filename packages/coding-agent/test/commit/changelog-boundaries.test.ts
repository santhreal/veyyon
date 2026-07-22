import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { detectChangelogBoundaries } from "../../src/commit/changelog/detect";

/**
 * detectChangelogBoundaries decides which CHANGELOG.md a staged file belongs to,
 * so the changelog agent proposes an entry in the RIGHT file in a monorepo. It
 * had no test. The contract:
 *   - each staged file maps to its NEAREST CHANGELOG.md walking up from the
 *     file's directory to (but not above) cwd;
 *   - files that share a nearest changelog are grouped together, preserving
 *     staged order;
 *   - a staged CHANGELOG.md is itself skipped (case-insensitively);
 *   - a file with no changelog anywhere up to cwd contributes no boundary.
 * Getting this wrong writes a changelog entry into the wrong package or drops it.
 */

let cwd = "";

beforeEach(() => {
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "changelog-boundaries-"));
});
afterEach(() => {
	fs.rmSync(cwd, { recursive: true, force: true });
});

const mkdir = (rel: string): void => {
	fs.mkdirSync(path.join(cwd, rel), { recursive: true });
};
const touch = (rel: string): void => {
	mkdir(path.dirname(rel));
	fs.writeFileSync(path.join(cwd, rel), "x");
};

describe("detectChangelogBoundaries", () => {
	it("maps each file to its nearest changelog and groups by it in staged order", async () => {
		touch("CHANGELOG.md");
		touch("packages/x/CHANGELOG.md");
		mkdir("packages/x/src");
		mkdir("packages/y");

		const boundaries = await detectChangelogBoundaries(cwd, ["packages/x/src/a.ts", "src/b.ts", "packages/y/z.ts"]);

		expect(boundaries).toEqual([
			{ changelogPath: path.join(cwd, "packages/x/CHANGELOG.md"), files: ["packages/x/src/a.ts"] },
			// src/b.ts and packages/y/z.ts both fall back to the ROOT changelog, grouped, in order.
			{ changelogPath: path.join(cwd, "CHANGELOG.md"), files: ["src/b.ts", "packages/y/z.ts"] },
		]);
	});

	it("skips a staged CHANGELOG.md itself, case-insensitively", async () => {
		touch("CHANGELOG.md");
		touch("src/a.ts");

		const boundaries = await detectChangelogBoundaries(cwd, ["CHANGELOG.md", "changelog.md", "src/a.ts"]);

		// Only the real source file produces a boundary; neither changelog spelling does.
		expect(boundaries).toEqual([{ changelogPath: path.join(cwd, "CHANGELOG.md"), files: ["src/a.ts"] }]);
	});

	it("returns no boundary for a file with no changelog up to cwd", async () => {
		// No CHANGELOG.md anywhere in the tree.
		mkdir("src");
		const boundaries = await detectChangelogBoundaries(cwd, ["src/a.ts"]);
		expect(boundaries).toEqual([]);
	});

	it("prefers a deeply nested changelog over an ancestor one", async () => {
		touch("CHANGELOG.md");
		touch("packages/x/CHANGELOG.md");
		mkdir("packages/x/deep/nested");

		const boundaries = await detectChangelogBoundaries(cwd, ["packages/x/deep/nested/a.ts"]);

		expect(boundaries).toEqual([
			{ changelogPath: path.join(cwd, "packages/x/CHANGELOG.md"), files: ["packages/x/deep/nested/a.ts"] },
		]);
	});
});

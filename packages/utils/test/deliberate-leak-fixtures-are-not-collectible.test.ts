/**
 * The fixtures that leak global state on purpose cannot be collected by an ordinary test run.
 *
 * WHY THIS SUITE EXISTS. `scripts/find-test-leaks.ts` needs suites that really do leak, so
 * `packages/utils/test/fixtures/` holds three: one sets `VEYYON_CONFIG_DIR` and never restores it,
 * one activates a profile and leaves it active, one restores properly and exists to prove the tracer
 * does not cry wolf. They were named `*.fixture.test.ts`.
 *
 * `bun test <dir>` collects every `*.test.ts` under the directory, wherever it sits, so an ordinary
 * `bun test packages/utils/test` RAN them — and every suite that executed afterwards resolved its
 * config directory under `/tmp/leaked-by-fixture` and failed. Which suites those were depended on
 * file order, which is exactly why the repository's full-suite pollution looked nondeterministic:
 * three consecutive full runs produced three different sets of victims. A concrete instance:
 * `coding-agent/test/tools/web-scrapers/youtube-parallel.test.ts` passes alone and fails when
 * `packages/utils/test` is in the same run.
 *
 * They are `*.fixture.ts` now. A path passed to `bun test` explicitly still runs regardless of its
 * name, so the tracer can drive them, while directory collection cannot see them. This suite locks
 * both halves of that: the names stay outside the glob, and the fixtures stay present and still
 * leak (a rename that quietly deleted the tracer's evidence would be the other way to break it).
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures");

/**
 * The names `bun test` recognises during directory discovery. Taken from its own error
 * message: `Tests need ".test", "_test_", ".spec" or "_spec_" in the filename`.
 */
const COLLECTED_BY_BUN = /(\.test|_test_|\.spec|_spec_)\./;

describe("packages/utils/test/fixtures", () => {
	it("contains no file that bun test would collect from a directory", () => {
		// The lock. Renaming one back to `*.fixture.test.ts` would reintroduce a leak that
		// breaks unrelated suites hundreds of files later, with a failure message that names
		// the victim and never mentions the cause.
		const collectible = fs
			.readdirSync(FIXTURES_DIR)
			.filter(name => COLLECTED_BY_BUN.test(name))
			.sort();

		expect(
			collectible,
			"a fixture under fixtures/ matches bun's test-file pattern and will run in ordinary directory runs",
		).toEqual([]);
	});

	it("still holds the three fixtures the leak tracer drives", () => {
		// The other direction. The point of the rename was to keep the fixtures, not to
		// remove the tracer's only end-to-end evidence.
		expect(
			fs
				.readdirSync(FIXTURES_DIR)
				.filter(name => name.endsWith(".fixture.ts"))
				.sort(),
		).toEqual(["leaky-suite.fixture.ts", "profile-leak.fixture.ts", "restoring-in-afterall.fixture.ts"]);
	});

	it("keeps the environment leak in the leaky fixture, since that is what it is for", () => {
		// Asserted on the source: the fixture must still perform the unrestored write the
		// tracer is supposed to catch. A fixture "fixed" to clean up after itself would make
		// `find-test-leaks.test.ts` pass while proving nothing.
		const text = fs.readFileSync(path.join(FIXTURES_DIR, "leaky-suite.fixture.ts"), "utf8");
		expect(text).toContain('process.env.VEYYON_CONFIG_DIR = "/tmp/leaked-by-fixture"');
		expect(text).not.toContain("afterAll");
	});

	it("keeps the module-state leak in the profile fixture", () => {
		const text = fs.readFileSync(path.join(FIXTURES_DIR, "profile-leak.fixture.ts"), "utf8");
		expect(text).toContain('setProfile("leaky")');
	});

	it("keeps the restoring fixture restoring, which is the tracer's negative twin", () => {
		const text = fs.readFileSync(path.join(FIXTURES_DIR, "restoring-in-afterall.fixture.ts"), "utf8");
		expect(text).toContain("afterAll");
	});
});

describe("this process", () => {
	it("has not been polluted by the fixtures, which is the symptom the rename removes", () => {
		// If a fixture ran in this same process (because it got collected again), this is the
		// value it would have left behind. Cheap, direct, and it fails in exactly the run
		// where the lock above would fail too — one asserting the cause, one the effect.
		expect(process.env.VEYYON_CONFIG_DIR).not.toBe("/tmp/leaked-by-fixture");
	});
});

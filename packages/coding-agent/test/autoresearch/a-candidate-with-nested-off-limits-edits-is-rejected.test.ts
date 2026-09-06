/**
 * WHY: `off_limits` paths in an autoresearch session protect benchmark harnesses,
 * tests, and golden files from being edited by candidate arms. In `swarm.ts`,
 * `scopeDeviations` performed an exact string equality check (`forbidden.has(candidate)`)
 * instead of path-matching (`pathMatchesSpec`). As a result, an arm modifying
 * `test/unit/math.test.ts` or `src/secret/key.ts` was not recognized as a scope deviation
 * when `off_limits` contained `test` or `src/secret`, and survived triage.
 *
 * The class it closes: any scope-filtering mechanism in swarm triage that fails to match
 * subpaths, normalized paths (e.g. `./autoresearch.sh` vs `autoresearch.sh`), or directory specs.
 *
 * What it does not catch: modifications to files outside the repository or files not
 * reported in `modifiedPaths`.
 */
import { describe, expect, it } from "bun:test";
import { scopeDeviations, triage } from "@veyyon/coding-agent/autoresearch/swarm";

describe("swarm scope deviations and triage path matching", () => {
	it("detects files inside an off-limits directory spec", () => {
		const offLimits = ["test", "docs"];
		const modifiedPaths = ["src/math.ts", "test/unit/bench.test.ts", "docs/guide.md"];
		const deviations = scopeDeviations(modifiedPaths, offLimits);
		expect(deviations).toEqual(["docs/guide.md", "test/unit/bench.test.ts"]);
	});

	it("detects exact file matches with differing leading or trailing path formats", () => {
		const offLimits = ["./autoresearch.sh", "fixtures/golden/"];
		const modifiedPaths = ["autoresearch.sh", "fixtures/golden/output.json", "src/index.ts"];
		const deviations = scopeDeviations(modifiedPaths, offLimits);
		expect(deviations).toEqual(["autoresearch.sh", "fixtures/golden/output.json"]);
	});

	it("rejects candidate arms in triage when they touch subpaths of off-limits directories", () => {
		const offLimits = ["test", "autoresearch.sh"];
		const candidates = [
			{
				arm: "a0",
				hypothesis: "faster loop",
				diff: "--- a/src/math.ts\n+++ b/src/math.ts\n+return 1;\n",
				modifiedPaths: ["src/math.ts"],
			},
			{
				arm: "a1",
				hypothesis: "tamper with test",
				diff: "--- a/test/unit/bench.test.ts\n+++ b/test/unit/bench.test.ts\n+assert(true);\n",
				modifiedPaths: ["test/unit/bench.test.ts"],
			},
			{
				arm: "a2",
				hypothesis: "tamper with harness",
				diff: "--- a/autoresearch.sh\n+++ b/autoresearch.sh\n+echo METRIC ms=0\n",
				modifiedPaths: ["autoresearch.sh"],
			},
		];

		const { survivors, rejected } = triage(candidates, offLimits);
		expect(survivors.map(c => c.arm)).toEqual(["a0"]);
		expect(rejected).toEqual([
			{ arm: "a1", reason: "scope", detail: "test/unit/bench.test.ts" },
			{ arm: "a2", reason: "scope", detail: "autoresearch.sh" },
		]);
	});
});

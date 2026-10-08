/**
 * Classifying a model id leaves nothing behind: every function `@veyyon/catalog/identity` exports
 * holds the same memory after classifying 8,000 distinct ids as after classifying 1,000.
 *
 * WHY: each family predicate and each family parse kept its own process-lifetime `Map` from id to
 * answer. Building the bundled catalog classifies all 4,406 models once, so a launch that resolved
 * a model held about 3.5 MiB of tables for answers no caller asked for again, and every discovered
 * or typed id added one entry per cache for the life of the process. A classification is a regex
 * or a string test that costs well under a microsecond, far less than the cache it filled.
 *
 * The sweep enumerates the barrel at run time, so a new export that caches per id fails here
 * without being named. An export that cannot take a lone id is pinned by name.
 *
 * NOT COVERED: a cache bounded below 7,000 entries (a bounded cache is not the defect), and state
 * reached only through an argument other than the id.
 */
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import type { ClassifiedGrowth } from "./fixtures/classified-id-growth";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "classified-id-growth.ts");

/** Runs the fixture over `perShape` ids of each family shape in a fresh process. */
function classify(perShape: number): ClassifiedGrowth {
	const run = spawnSync(process.execPath, [FIXTURE, String(perShape)], { encoding: "utf8" });
	expect(run.stderr).toBe("");
	return JSON.parse(run.stdout) as ClassifiedGrowth;
}

describe("classifying a model id", () => {
	it("holds no memory in proportion to the ids classified", () => {
		const small = classify(100);
		const large = classify(800);
		expect(large.ids - small.ids).toBe(7_000);
		// Compiled code for the hot predicates is live after either sweep; only per-id state differs.
		expect(large.grown - small.grown).toBeLessThan(256 * 1024);
	});

	it("reaches every export that takes a model id", () => {
		const { classified, rejected } = classify(1);
		// Each takes a candidate list or a built index, not an id.
		expect(rejected).toEqual(["buildModelReferenceIndex", "resolveModelReference"]);
		// One export behind each cache the catalog held: family predicates, family parses, the bare id.
		expect(classified).toEqual(
			expect.arrayContaining([
				"bareModelId",
				"isKimiModelId",
				"modelFamilyToken",
				"parseAnthropicModel",
				"parseGlmModel",
				"stripThinkingVariantToken",
			]),
		);
	});
});

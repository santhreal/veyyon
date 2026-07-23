/**
 * Contract/manifest sync lock for mnemopi's first wave (TS-SUITE-1).
 * docs/migration/manifest.json freezes the JSON-level port boundary
 * (src/core/conformance-boundary.ts); if a listed function is renamed,
 * unexported, or removed, a Rust port would reimplement a fiction. This
 * suite asserts every mnemopi manifest entry exists with the declared
 * arity, that the contract doc exists, and that the conformance BOUNDARY
 * covers exactly the manifest's function set, so contract, corpus, and code
 * can only move together.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as boundary from "../src/core/conformance-boundary";

const REPO_ROOT = join(import.meta.dir, "../../..");
const MANIFEST_PATH = join(REPO_ROOT, "docs/migration/manifest.json");

interface ManifestModule {
	module: string;
	sourceFile: string;
	contract: string;
	functions: Array<{ name: string; input: unknown[]; invariants: string[] }>;
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as { modules: ManifestModule[] };
const mnemopiModules = manifest.modules.filter(m => m.module.startsWith("mnemopi/"));

describe("mnemopi migration manifest sync", () => {
	it("registers the five first-wave modules", () => {
		expect(mnemopiModules.map(m => m.module)).toEqual([
			"mnemopi/vector-math",
			"mnemopi/binary-vectors",
			"mnemopi/decay",
			"mnemopi/text-similarity",
			"mnemopi/mmr",
		]);
	});

	for (const module of mnemopiModules) {
		describe(module.module, () => {
			it("points at the boundary source and contract doc, both existing", () => {
				expect(module.sourceFile).toBe("packages/mnemopi/src/core/conformance-boundary.ts");
				expect(existsSync(join(REPO_ROOT, module.sourceFile))).toBe(true);
				expect(existsSync(join(REPO_ROOT, module.contract))).toBe(true);
			});

			for (const fn of module.functions) {
				it(`exports ${fn.name} with the declared arity and real invariants`, () => {
					const exported = (boundary as unknown as Record<string, unknown>)[fn.name];
					expect(typeof exported).toBe("function");
					// mmrRerankRecords/weibullDecayFactor12 have optional params
					// counted in the manifest; fn.length only counts required.
					expect((exported as (...args: unknown[]) => unknown).length).toBeLessThanOrEqual(fn.input.length);
					expect((exported as (...args: unknown[]) => unknown).length).toBeGreaterThan(0);
					expect(fn.invariants.length).toBeGreaterThan(0);
				});
			}
		});
	}

	it("matches the conformance BOUNDARY exactly (corpus and contract cover the same set)", () => {
		const manifestFns = mnemopiModules.flatMap(m => m.functions.map(f => f.name)).sort();
		const boundarySource = readFileSync(join(import.meta.dir, "conformance/mnemopi-conformance.test.ts"), "utf8");
		for (const name of manifestFns) {
			expect(boundarySource).toContain(name);
		}
		expect(manifestFns).toEqual(
			[
				"cosineSimilarity",
				"encodeEmbeddingJson",
				"decodeEmbeddingJson",
				"quantizeInt8AsArray",
				"binarizeAsArray",
				"hammingDistanceFromArrays",
				"informationScore",
				"weibullDecayFactor12",
				"jaccardWordSimilarity",
				"wordSetSorted",
				"mmrRerankRecords",
			].sort(),
		);
	});
});

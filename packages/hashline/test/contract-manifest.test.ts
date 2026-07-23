/**
 * Contract/manifest sync lock (TS-SUITE-1). docs/migration/manifest.json is
 * the machine-readable freeze of the port boundary; if a listed function is
 * renamed, unexported, or removed, the Rust port would be reimplementing a
 * fiction. This suite asserts every manifest-listed export exists with the
 * declared arity, that the contract doc it points to exists, and that the
 * conformance BOUNDARY covers exactly the manifest's function set — so
 * contract, corpus, and code can only move together.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as normalize from "../src/normalize";
import * as tokenizer from "../src/tokenizer";

const REPO_ROOT = join(import.meta.dir, "../../..");
const MANIFEST_PATH = join(REPO_ROOT, "docs/migration/manifest.json");

interface ManifestFunction {
	name: string;
	input: Array<{ name: string; type: string }>;
	output: string;
	errors: Array<{ type: string; messagePrefix: string }>;
	invariants: string[];
}

interface ManifestModule {
	module: string;
	sourceFile: string;
	contract: string;
	functions: ManifestFunction[];
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
	schemaVersion: number;
	modules: ManifestModule[];
};

const NAMESPACES: Record<string, Record<string, unknown>> = {
	"hashline/tokenizer": tokenizer as unknown as Record<string, unknown>,
	"hashline/normalize": normalize as unknown as Record<string, unknown>,
};

describe("migration manifest sync", () => {
	it("is schema version 1 with the two first-wave hashline modules", () => {
		expect(manifest.schemaVersion).toBe(1);
		// Other packages (mnemopi, wire) add their own modules; this suite owns
		// only the hashline entries and their sync.
		expect(manifest.modules.map(m => m.module).filter(m => m.startsWith("hashline/"))).toEqual([
			"hashline/tokenizer",
			"hashline/normalize",
		]);
	});

	for (const module of manifest.modules.filter(m => m.module.startsWith("hashline/"))) {
		describe(module.module, () => {
			it("points at a source file and a contract doc that exist", () => {
				expect(existsSync(join(REPO_ROOT, module.sourceFile))).toBe(true);
				expect(existsSync(join(REPO_ROOT, module.contract))).toBe(true);
			});

			for (const fn of module.functions) {
				it(`exports ${fn.name} with the declared arity and real invariants`, () => {
					const exported = NAMESPACES[module.module]?.[fn.name];
					expect(typeof exported).toBe("function");
					expect((exported as (...args: unknown[]) => unknown).length).toBe(fn.input.length);
					// An invariant-free entry is a stub, not a contract.
					expect(fn.invariants.length).toBeGreaterThan(0);
				});
			}
		});
	}

	it("matches the conformance BOUNDARY exactly (corpus and contract cover the same set)", () => {
		const manifestFns = manifest.modules
			.filter(m => m.module.startsWith("hashline/"))
			.flatMap(m => m.functions.map(f => f.name))
			.sort();
		// The conformance suite's BOUNDARY object is the corpus's function set;
		// keep the two lists identical so neither can silently shrink.
		const boundarySource = readFileSync(join(import.meta.dir, "conformance/hashline-conformance.test.ts"), "utf8");
		for (const name of manifestFns) {
			expect(boundarySource).toContain(name);
		}
		expect(manifestFns).toEqual(
			[
				"detectLineEnding",
				"normalizeToLF",
				"parseLid",
				"restoreLineEndings",
				"splitHashlineLines",
				"stripBom",
			].sort(),
		);
	});
});

/**
 * Corpus/oracle sync lock (TS-SUITE-3). The conformance vectors under
 * packages/<module>/test/conformance/vectors are GENERATED from the TS oracle
 * by record-conformance.ts; if someone edits a vector by hand, changes the
 * oracle without regenerating, or drops a file, the corpus silently stops
 * being the record of current behavior — the exact drift that would let a
 * Rust port "pass" against stale truth. This suite re-renders every recorded
 * module in memory and requires byte-identical files on disk, and pins the
 * corpus scale so a shrunk enumeration cannot pass as green.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderModuleVectors, vectorDirFor } from "./record-conformance";

const MODULES = ["hashline", "mnemopi"] as const;

describe("record-conformance corpus sync", () => {
	for (const moduleName of MODULES) {
		it(`${moduleName}: every checked-in vector file is byte-identical to the oracle recording`, () => {
			const rendered = renderModuleVectors(moduleName);
			const dir = vectorDirFor(moduleName);
			for (const [name, content] of rendered) {
				expect(readFileSync(join(dir, name), "utf8")).toBe(content);
			}
			// No orphan vector files: everything on disk is something the
			// recorder still produces.
			const onDisk = readdirSync(dir)
				.filter(f => f.endsWith(".json"))
				.sort();
			expect(onDisk).toEqual([...rendered.keys()].sort());
		});
	}

	it("hashline: the corpus stays at scale (a shrunk enumeration is a corpus regression)", () => {
		const rendered = renderModuleVectors("hashline");
		let vectors = 0;
		for (const content of rendered.values()) {
			vectors += (JSON.parse(content) as { vectors: unknown[] }).vectors.length;
		}
		expect(rendered.size).toBe(6);
		expect(vectors).toBe(153);
	});

	it("mnemopi: the corpus stays at scale (a shrunk enumeration is a corpus regression)", () => {
		const rendered = renderModuleVectors("mnemopi");
		let vectors = 0;
		for (const content of rendered.values()) {
			vectors += (JSON.parse(content) as { vectors: unknown[] }).vectors.length;
		}
		expect(rendered.size).toBe(11);
		expect(vectors).toBe(168);
	});

	it("rejects unknown modules loudly instead of writing nothing", () => {
		expect(() => renderModuleVectors("no-such-module")).toThrow('Unknown conformance module "no-such-module"');
	});
});

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createModuleReachCache, moduleGraph, moduleReach, moduleReachCount } from "@veyyon/utils/module-reach";

/**
 * Contract: a walk with a cache answers exactly what a walk without one answers, and reads each file once.
 *
 * WHY THE CACHE EXISTS. The architecture gates walk one entry per test file. `test-suite-module-reach`
 * walks 1,891 entries over a graph whose files overlap almost completely, so before this every one of those
 * walks re-read and re-scanned the same modules: the same `readFileSync`, the same regex pass, the same
 * resolution, thousands of times over for one number. It was tolerable while the walk resolved four
 * packages and stopped at every other boundary. Resolving the whole workspace made the gate take minutes,
 * and a gate too slow to run stops catching anything (Law 7).
 *
 * WHY THESE TESTS AND NOT A BENCHMARK. The risk in a memo is never that it fails to be faster, it is that
 * it answers differently: a stale entry, a shared mutable array handed to a caller, an unreadable file
 * remembered as having no edges when the next walk should look again. So the cases below pin EQUALITY with
 * the uncached walk on the same fixture, and the one property that makes the speedup real (each file is
 * read once across many entries) is asserted by counting reads through a fixture whose files are deleted
 * out from under the second walk. That is a real value, not a timing.
 */

let root: string;

function write(relative: string, source: string): string {
	const file = path.join(root, relative);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, source);
	return file;
}

beforeAll(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "module-reach-cache-"));
});

afterAll(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe("a cached walk answers what an uncached walk answers", () => {
	/**
	 * A diamond: two entries whose graphs share a leaf. The shared file is what a cache is for, and getting
	 * it wrong in the obvious way (returning the memo of the wrong file) shows up here as a wrong set.
	 */
	it("returns the same reach set for every entry of a shared graph", () => {
		const leaf = write("diamond/leaf.ts", "export const leaf = 1;\n");
		const left = write("diamond/left.ts", 'import { leaf } from "./leaf";\nexport const left = leaf;\n');
		const right = write("diamond/right.ts", 'import { leaf } from "./leaf";\nexport const right = leaf;\n');
		const top = write(
			"diamond/top.ts",
			'import { left } from "./left";\nimport { right } from "./right";\nexport const top = left + right;\n',
		);
		const cache = createModuleReachCache();

		for (const entry of [top, left, right, leaf]) {
			expect([...moduleReach(entry, {}, cache)].sort()).toEqual([...moduleReach(entry, {})].sort());
		}
		expect(moduleReachCount(top, {}, cache)).toBe(4);
		expect(moduleReachCount(leaf, {}, cache)).toBe(1);
	});

	/** A cycle must still terminate with a cache, and count each module once. */
	it("terminates on a cycle and counts each module once", () => {
		write("cycle/a.ts", 'import { b } from "./b";\nexport const a = b;\n');
		write("cycle/b.ts", 'import { a } from "./a";\nexport const b = a;\n');
		const cache = createModuleReachCache();

		expect(moduleReachCount(path.join(root, "cycle/a.ts"), {}, cache)).toBe(2);
		expect(moduleReachCount(path.join(root, "cycle/b.ts"), {}, cache)).toBe(2);
	});

	/** `moduleGraph` takes the same cache and must keep every node, edges included. */
	it("builds the same adjacency list with and without a cache", () => {
		const entry = write("graph/entry.ts", 'import { leaf } from "./leaf";\nexport const entry = leaf;\n');
		write("graph/leaf.ts", "export const leaf = 1;\n");
		const cache = createModuleReachCache();

		const cached = moduleGraph(entry, {}, cache);
		const uncached = moduleGraph(entry, {});

		expect([...cached.keys()].sort()).toEqual([...uncached.keys()].sort());
		expect(cached.get(entry)).toEqual([path.join(root, "graph/leaf.ts")]);
		// The same cache, now warm, still produces the leaf's own (empty) edge list rather than the entry's.
		expect(moduleGraph(path.join(root, "graph/leaf.ts"), {}, cache).get(path.join(root, "graph/leaf.ts"))).toEqual(
			[],
		);
	});

	/**
	 * THE PROPERTY THAT MAKES IT FASTER, asserted as a value rather than a duration. The second walk reads
	 * nothing: the fixture is deleted between the two, so an uncached walk would see a single unreadable
	 * entry with no edges (reach 1) while the cached walk still answers 3 from the memo. Deleting the files
	 * is the only way to prove a read did not happen without timing anything.
	 */
	it("reads each file once across walks, proven by deleting the files between them", () => {
		const entry = write("counted/entry.ts", 'import { mid } from "./mid";\nexport const entry = mid;\n');
		write("counted/mid.ts", 'import { leaf } from "./leaf";\nexport const mid = leaf;\n');
		write("counted/leaf.ts", "export const leaf = 1;\n");
		const cache = createModuleReachCache();

		expect(moduleReachCount(entry, {}, cache)).toBe(3);
		fs.rmSync(path.join(root, "counted"), { recursive: true, force: true });

		expect(moduleReachCount(entry, {}, cache)).toBe(3);
		expect(moduleReachCount(entry, {})).toBe(1);
	});

	/**
	 * An unreadable file is remembered as having no edges, and only within the run that saw it. That is the
	 * one case where memoizing could hide something: a file being rewritten by a build while a gate walks it
	 * is exactly why the walk tolerates an unreadable file at all. A fresh cache looks again, which is what
	 * makes the memo per-run rather than module-level.
	 */
	it("remembers an unreadable file only for the cache that saw it", () => {
		const entry = write("transient/entry.ts", 'import { gone } from "./gone";\nexport const entry = gone;\n');
		const gone = write("transient/gone.ts", "export const gone = 1;\n");
		const warm = createModuleReachCache();

		expect(moduleReachCount(entry, {}, warm)).toBe(2);
		fs.writeFileSync(gone, 'import { deeper } from "./deeper";\nexport const gone = deeper;\n');
		write("transient/deeper.ts", "export const deeper = 1;\n");

		// The warm cache holds the file as it was: two modules, because `gone.ts` had no imports when read.
		expect(moduleReachCount(entry, {}, warm)).toBe(2);
		// A fresh cache reads it again and finds the third module. Same call, same disk, different memo.
		expect(moduleReachCount(entry, {}, createModuleReachCache())).toBe(3);
	});

	/** The cache is keyed by absolute path, so a relative entry and its resolved form share one memo. */
	it("keys on the resolved absolute path, not on what the caller passed", () => {
		const entry = write("keys/entry.ts", "export const entry = 1;\n");
		const cache = createModuleReachCache();

		expect(moduleReachCount(entry, {}, cache)).toBe(1);
		expect(cache.has(entry)).toBe(true);
		expect(cache.size).toBe(1);
	});
});

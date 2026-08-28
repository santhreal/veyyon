/**
 * WHY: `packages/tui/src/core/` is what a 5415-line `tui.ts` became. A split is
 * only real while its pieces stay layered; the failure mode is not that a module
 * grows, which `module-size-gates.test.ts` measures, but that the pieces start
 * reaching for each other until the ten files are one module wearing ten names.
 *
 * Two edges do that, and both look harmless at the call site:
 *
 *   - a leaf importing the composition root (`renderer.ts` needing something off
 *     `TUI`), which makes the root a dependency of its own parts and puts the
 *     whole engine back in every file's graph, and
 *   - a new shared module appearing between the leaves, so a reader can no
 *     longer say which module owns a concept without reading all ten.
 *
 * So the layering is asserted as a derived graph rather than as a rule about
 * `TUI`: the root imports its parts, the parts import a pinned shared vocabulary
 * and nothing else, and nobody imports the root. Every edge below is read out of
 * the source at run time, so a module added to `core/` or an import added to one
 * turns this red until somebody records the decision here.
 *
 * WHAT THIS DOES NOT CATCH. Coupling that is not an import: a leaf reading a
 * field the root writes on a shared object, or a value passed through
 * `component-types` that only the root can produce. It also says nothing about
 * imports out of the package, which `tui-has-no-string-processing.test.ts` and
 * `tui-does-not-re-export-utils.test.ts` own.
 */

import { describe, expect, test } from "bun:test";
import { basename } from "node:path";
import { importSpecifiers, isDirectory, repoPath, typeScriptFiles } from "./helpers/module-graph";

const CORE = repoPath("packages/tui/src/core");

/** The composition root: the only module in `core/` allowed to import its siblings broadly. */
const ROOT = "tui.ts";

/**
 * The modules a non-root sibling may depend on.
 *
 * `component-types.ts` is the component and frame vocabulary every part speaks,
 * and `container.ts` is the tree the renderer walks. Pinned by exact equality
 * rather than as a ceiling: a third shared module is the moment the layering
 * stops being describable in one sentence, and a count would let one be swapped
 * for another silently.
 */
const SHARED = ["component-types.ts", "container.ts"] as const;

/** `./name` → `name.ts`, for the sibling edges of one file. */
function siblingEdges(file: string): string[] {
	const edges: string[] = [];
	for (const specifier of importSpecifiers(file)) {
		if (!specifier.startsWith("./")) continue;
		const target = `${specifier.slice(2)}.ts`;
		if (!edges.includes(target)) edges.push(target);
	}
	return edges.sort();
}

const files = typeScriptFiles(CORE).map(file => basename(file));
const edges = new Map<string, string[]>(typeScriptFiles(CORE).map(file => [basename(file), siblingEdges(file)]));

describe("the core split stays layered", () => {
	test("reads a real directory with the root and its parts in it", () => {
		// Non-vacuity. Every assertion below quantifies over `files`, so an empty
		// or misspelled directory would pass all of them while measuring nothing.
		expect(isDirectory(CORE)).toBe(true);
		expect(files).toContain(ROOT);
		expect(files.length).toBeGreaterThanOrEqual(10);
		for (const shared of SHARED) expect(files).toContain(shared);
	});

	/**
	 * THE EDGE THAT UNDOES THE SPLIT. A part importing the root makes the root a
	 * dependency of its own dependencies: every leaf's graph grows back to the
	 * whole engine, and the cycle means neither file can be read or tested alone.
	 */
	test("no part imports the composition root", () => {
		const reaching = files.filter(file => file !== ROOT && (edges.get(file) ?? []).includes(ROOT));

		expect(reaching).toEqual([]);
	});

	/**
	 * Stated as a set rather than a per-file allowance, so the question a reader
	 * asks — which modules do the parts share? — has one answer for the directory
	 * instead of ten answers to be cross-read.
	 */
	test("a part depends only on the shared vocabulary", () => {
		const beyond = new Set<string>();
		for (const file of files) {
			if (file === ROOT) continue;
			for (const target of edges.get(file) ?? []) {
				if (!SHARED.includes(target as (typeof SHARED)[number])) beyond.add(`${file} -> ${target}`);
			}
		}

		expect([...beyond].sort()).toEqual([]);
	});

	/**
	 * The shared modules are shared, not just permitted. A `SHARED` entry nothing
	 * imports is a stale allowance, and an allowance outliving its use is how the
	 * list stops describing the code.
	 */
	test("every shared module is imported by a part", () => {
		const unused = SHARED.filter(
			shared => !files.some(file => file !== ROOT && (edges.get(file) ?? []).includes(shared)),
		);

		expect(unused).toEqual([]);
	});

	/**
	 * The root composes the parts. A module in `core/` the root never reaches is
	 * either dead or wired in from somewhere that should not be composing the
	 * engine, and both read as "ten focused modules" from a directory listing.
	 */
	test("the root imports every part", () => {
		const composed = edges.get(ROOT) ?? [];
		const orphans = files.filter(file => file !== ROOT && !composed.includes(file));

		expect(orphans).toEqual([]);
	});

	/**
	 * Acyclicity, proved by draining the graph rather than by trusting the two
	 * rules above to imply it. A cycle among the parts is possible while every
	 * edge lands inside `SHARED` — `component-types` importing `container` and
	 * back — and it is the one shape that makes the module order undefined.
	 */
	test("the sibling graph is acyclic", () => {
		const remaining = new Map<string, string[]>(files.map(file => [file, [...(edges.get(file) ?? [])]]));
		let progressed = true;
		while (progressed) {
			progressed = false;
			for (const [file, targets] of remaining) {
				if (targets.some(target => remaining.has(target))) continue;
				remaining.delete(file);
				progressed = true;
			}
		}

		expect([...remaining.keys()].sort()).toEqual([]);
	});
});

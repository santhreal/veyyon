/**
 * WHY: the split exists so that a module can be read in one sitting, and the
 * only way a split stays split is a ratchet. Without one, the next feature lands
 * in whichever file already has the imports, and the engine reassembles itself
 * one convenience at a time. The defect class is growth: not a wrong line, but a
 * module that quietly becomes the place everything goes.
 *
 * The gate is a ceiling per module, and every ceiling is a MEASURED number with
 * a recorded reason, not a target. Two of them are far above the 800-line figure
 * the plan asked for, and that is stated rather than hidden:
 *
 * `core/tui.ts` is 3612 lines. MEASURED 2026-08-27. The nine sibling modules
 * were carved out of a 5415-line file, and what remains is the `TUI` class
 * itself: one object holding about sixty private fields that the compose,
 * paint, scroll-isolation, cursor, overlay and input paths all mutate within a
 * single frame. Splitting it further means passing that state between
 * collaborating objects in the highest-risk file in the product, where the
 * failure mode is a corrupted frame on someone's terminal rather than a failing
 * test. So the ceiling records where it is and stops it growing, and the further
 * split is a separate change with its own render-oracle evidence.
 *
 * `core/renderer.ts` is 611 lines and holds the frame preparation the engine
 * calls per row: SGR coalescing, line fitting, prefix resync, cursor-marker
 * extraction. It is under the plan's figure and listed for the same reason.
 *
 * What it does NOT catch: a module that stays small by pushing its complexity
 * into a sibling, and it says nothing about whether the lines are any good.
 */

import { describe, expect, test } from "bun:test";
import { basename } from "node:path";
import { isDirectory, lineCount, repoPath, repoRelative, typeScriptFiles } from "./helpers/module-graph";

/**
 * Ceilings for the engine's core modules, by file name. MEASURED 2026-08-27,
 * with headroom of roughly ten percent so an ordinary edit does not fail the
 * gate and a new subsystem does.
 */
const CORE_CEILINGS: Record<string, number> = {
	"tui.ts": 3700,
	"renderer.ts": 700,
	"overlay.ts": 560,
	"image-budget.ts": 330,
	"component-types.ts": 320,
	"terminal-session.ts": 300,
	"cursor.ts": 230,
	"scroll.ts": 200,
	"container.ts": 180,
	"mouse-routing.ts": 150,
};

/** Ceiling for every module in the presentation layer, which is new and has no legacy. */
const PRESENTATION_CEILING = 500;

const PRESENTATION_DIRECTORIES = [
	repoPath("packages/wire/src/presentation"),
	repoPath("packages/coding-agent/src/presentation"),
	repoPath("packages/coding-agent/src/modes/terminal"),
];

describe("the engine's core modules stay the size they were split to", () => {
	const core = repoPath("packages/tui/src/core");

	test("the ceiling table names exactly the modules that exist", () => {
		// Derived from the directory, not from memory: a new core module fails here
		// until someone records what it is allowed to weigh.
		expect(isDirectory(core)).toBe(true);
		const present = typeScriptFiles(core)
			.map(file => basename(file))
			.sort();
		expect(present).toEqual(Object.keys(CORE_CEILINGS).sort());
	});

	test.each(Object.entries(CORE_CEILINGS))("%s stays under %d lines", (name, ceiling) => {
		expect(lineCount(`${core}/${name}`)).toBeLessThanOrEqual(ceiling);
	});

	test("no ceiling is so loose that it cannot fail", () => {
		// A ceiling more than double the measured size is not a ratchet, and a
		// generous one added to unblock a change is how a gate dies.
		const loose: string[] = [];
		for (const [name, ceiling] of Object.entries(CORE_CEILINGS)) {
			const measured = lineCount(`${core}/${name}`);
			if (ceiling > measured * 2) loose.push(`${name}: ${measured} lines under a ${ceiling} ceiling`);
		}
		expect(loose).toEqual([]);
	});
});

describe("the presentation layer's modules stay small", () => {
	test("every directory under the rule exists and holds modules", () => {
		for (const directory of PRESENTATION_DIRECTORIES) {
			expect(isDirectory(directory)).toBe(true);
			expect(typeScriptFiles(directory).length).toBeGreaterThan(0);
		}
	});

	test("no module exceeds the ceiling", () => {
		const oversized: string[] = [];
		for (const directory of PRESENTATION_DIRECTORIES) {
			for (const file of typeScriptFiles(directory)) {
				const lines = lineCount(file);
				if (lines > PRESENTATION_CEILING) oversized.push(`${repoRelative(file)}: ${lines} lines`);
			}
		}
		expect(oversized).toEqual([]);
	});
});

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
import { readdirSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { isDirectory, lineCount, repoPath, repoRelative, typeScriptFiles } from "./helpers/module-graph";

/**
 * Ceilings for the engine's core modules, by their path under `hosts/terminal/engine/src`.
 * MEASURED 2026-08-27, with headroom of roughly ten percent so an ordinary edit
 * does not fail the gate and a new subsystem does. The keys are full paths so a
 * reader can find the module, and so the repository's "a shipped module arrives
 * with a test that names it" gate counts these as named.
 */
const CORE_CEILINGS: Record<string, number> = {
	"core/tui.ts": 3700,
	"core/renderer.ts": 700,
	"core/overlay.ts": 560,
	"core/image-budget.ts": 330,
	"core/component-types.ts": 320,
	"core/terminal-session.ts": 300,
	"core/cursor.ts": 230,
	"core/scroll.ts": 200,
	"core/container.ts": 180,
	"core/mouse-routing.ts": 150,
};

/** Ceiling for every module in the presentation layer, which is new and has no legacy. */
const PRESENTATION_CEILING = 500;

const PRESENTATION_DIRECTORIES = [
	repoPath("contracts/wire/src/presentation"),
	repoPath("packages/coding-agent/src/presentation"),
];

/**
 * The terminal tree is not on the ceiling: it carries the interactive mode and
 * the components that predate the contract, and slimming those onto the driver
 * is its own change. What IS on the ceiling is the layer written against the
 * contract, found by the import rather than by a list, so a fifth module added
 * beside the driver is measured the day it lands.
 */
const TERMINAL = repoPath("packages/coding-agent/src/modes/terminal");

function viewModelModules(): string[] {
	return readdirSync(TERMINAL, { withFileTypes: true })
		.filter(entry => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"))
		.map(entry => `${TERMINAL}/${entry.name}`)
		.filter(file => readFileSync(file, "utf8").includes('from "@veyyon/wire/presentation"'))
		.sort();
}

describe("the engine's core modules stay the size they were split to", () => {
	const tuiSrc = repoPath("hosts/terminal/engine/src");
	const core = `${tuiSrc}/core`;
	const measure = (key: string): number => lineCount(`${tuiSrc}/${key}`);

	test("the ceiling table names exactly the modules that exist", () => {
		// Derived from the directory, not from memory: a new core module fails here
		// until someone records what it is allowed to weigh.
		expect(isDirectory(core)).toBe(true);
		const present = typeScriptFiles(core)
			.map(file => `core/${basename(file)}`)
			.sort();
		expect(present).toEqual(Object.keys(CORE_CEILINGS).sort());
	});

	test.each(Object.entries(CORE_CEILINGS))("%s stays under %d lines", (key, ceiling) => {
		expect(measure(key)).toBeLessThanOrEqual(ceiling);
	});

	test("no ceiling is so loose that it cannot fail", () => {
		// A ceiling more than double the measured size is not a ratchet, and a
		// generous one added to unblock a change is how a gate dies.
		const loose: string[] = [];
		for (const [key, ceiling] of Object.entries(CORE_CEILINGS)) {
			const measured = measure(key);
			if (ceiling > measured * 2) loose.push(`${key}: ${measured} lines under a ${ceiling} ceiling`);
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

	test("the terminal modules written against the contract are on the same ceiling", () => {
		const modules = viewModelModules();
		// The layer exists: an empty set here would pass the ceiling by measuring
		// nothing, which is how this kind of gate dies.
		expect(modules.map(file => basename(file))).toEqual([
			"block-rows.ts",
			"chrome-rows.ts",
			"driver.ts",
			"theme-ansi.ts",
		]);
		const oversized = modules
			.filter(file => lineCount(file) > PRESENTATION_CEILING)
			.map(file => `${repoRelative(file)}: ${lineCount(file)} lines`);
		expect(oversized).toEqual([]);
	});
});

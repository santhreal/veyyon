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
 * `core/tui.ts` is 3837 lines. RE-MEASURED 2026-10-09, after the render
 * scheduler moved to `core/render-scheduler.ts`, the root-child segment
 * arithmetic to `core/frame-segments.ts`, the frame intent and the rule that
 * selects it to `core/render-intent.ts`, and the alt-buffer caret mapping to
 * `core/cursor.ts`; it was 3964 before them, past this ceiling since frame
 * composition, input dispatch, window planning and update emission were split
 * into single-purpose steps. It was 3800 at 2026-10-04, after the frame throttle
 * and the terminal hosts' settle windows moved to `core/frame-pacing.ts`; it
 * was 3821 at 2026-09-30, after the queue of
 * virtualized roots a component-scoped frame compacts and the switch that
 * records the scroll tape only while scroll isolation reads it; it was 3757 at
 * 2026-09-26, after the escape sequences each paint emits moved to
 * `core/paint-sequences.ts` and the records one frame phase hands the next
 * moved to `core/frame-plan.ts`, 3790 before them, and 3612 at the split with
 * upstream edits to the pre-split monolith. The sibling modules were carved out
 * of a 5415-line
 * file, and what remains is the `TUI` class itself: one object holding about
 * sixty private fields that the compose, paint, scroll-isolation, cursor,
 * overlay and input paths all mutate within a single frame. Splitting it
 * further means passing that state between collaborating objects in the
 * highest-risk file in the product, where the failure mode is a corrupted frame
 * on someone's terminal rather than a failing test. So the ceiling records where
 * it is and stops it growing, and the further split is a separate change with
 * its own render-oracle evidence. Its headroom is under two percent rather
 * than the table's ten, because this is the module the ratchet exists for.
 *
 * `core/renderer.ts` is 589 lines and holds the frame preparation the engine
 * calls per row: line fitting, prefix resync, cursor-marker extraction. It is
 * under the plan's figure and listed for the same reason. RE-MEASURED
 * 2026-10-09, after SGR coalescing moved to `core/sgr-coalesce.ts`; it was 750
 * before, past its 700 ceiling since the render and parse hotspots were split
 * into single-purpose helpers, and its ceiling drops to 650 so the moved lines
 * do not grow back.
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
 * with a test that names it" gate counts these as named. `core/component-types.ts`
 * RE-MEASURED 2026-09-30 at 328, after `Component.releaseRenderCache()` and the
 * empty child set of a compacting frame joined the contract it declares.
 * RE-MEASURED 2026-10-09: `core/frame-plan.ts` at 83 after `RenderIntent` moved
 * to `core/render-intent.ts`, and `core/cursor.ts` at 202 after it took
 * `screenCaret` from `core/tui.ts`. The modules carved out that day enter at
 * their measured size plus roughly ten percent: `core/sgr-coalesce.ts` at 166,
 * `core/frame-segments.ts` at 87, `core/render-intent.ts` at 36 and
 * `core/render-scheduler.ts` at 30.
 */
const CORE_CEILINGS: Record<string, number> = {
	"core/tui.ts": 3860,
	"core/renderer.ts": 650,
	"core/overlay.ts": 560,
	"core/image-budget.ts": 330,
	"core/component-types.ts": 360,
	"core/terminal-session.ts": 300,
	"core/cursor.ts": 230,
	"core/scroll.ts": 200,
	"core/container.ts": 180,
	"core/mouse-routing.ts": 150,
	"core/paint-sequences.ts": 430,
	"core/frame-plan.ts": 90,
	"core/frame-pacing.ts": 150,
	"core/sgr-coalesce.ts": 185,
	"core/frame-segments.ts": 95,
	"core/render-intent.ts": 40,
	"core/render-scheduler.ts": 35,
};

/** Ceiling for every module in the presentation layer, which is new and has no legacy. */
const PRESENTATION_CEILING = 700;

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
		expect(modules.map(file => basename(file))).toEqual(["driver.ts"]);
		const oversized = modules
			.filter(file => lineCount(file) > PRESENTATION_CEILING)
			.map(file => `${repoRelative(file)}: ${lineCount(file)} lines`);
		expect(oversized).toEqual([]);
	});
});

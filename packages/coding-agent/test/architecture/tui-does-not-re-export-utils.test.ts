/**
 * WHY: the move only holds if the cutover is clean. A barrel that re-exports the
 * relocated primitives means `import { visibleWidth } from "@veyyon/tui"` keeps
 * working, so no caller ever moves, and the dependency the move existed to
 * remove stays in every consumer's graph — invisibly, because the import looks
 * local. The defect class is one compatibility line added to unbreak a caller.
 *
 * The assertion is on the barrel's own resolved exports, evaluated by importing
 * it, not on its source text: a re-export added through a star, an alias or a
 * nested barrel is caught the same way as a direct one.
 *
 * What it does NOT catch: a symbol re-exported under a different name, which is
 * a new API rather than a hidden re-export.
 */

import { describe, expect, test } from "bun:test";
import * as tui from "@veyyon/tui";

/**
 * Symbols that were `@veyyon/tui` exports before the move and are now
 * `@veyyon/utils` subpath exports. Reaching any of them through the renderer's
 * barrel again is the regression.
 */
const MOVED_SYMBOLS = [
	"visibleWidth",
	"truncateToWidth",
	"sliceWithWidth",
	"wrapTextWithAnsi",
	"replaceTabs",
	"padding",
	"parseKey",
	"matchesKey",
	"Key",
	"MOTION",
	"fuzzyMatch",
	"latexToUnicode",
	"stripAnsi",
	"sgrCarryAfter",
	"applyBackgroundToLine",
	"KillRing",
	"isInsideTmux",
	"parseSgrMouseEvent",
] as const;

describe("the renderer barrel does not re-export the moved primitives", () => {
	test("the barrel resolves and exports the engine", () => {
		// A barrel that failed to load would make every absence below vacuous.
		expect(typeof tui.TUI).toBe("function");
		expect(typeof tui.Container).toBe("function");
	});

	test("no moved symbol is reachable through @veyyon/tui", () => {
		const leaked = MOVED_SYMBOLS.filter(name => name in tui);
		expect(leaked).toEqual([]);
	});

	test("the barrel exports components and terminal I/O, which is what it is for", () => {
		for (const name of ["Text", "Container", "TUI", "SelectList", "Markdown"]) {
			expect(name in tui).toBe(true);
		}
	});
});

/**
 * No tool renderer forwards hostile content to a cell.
 *
 * WHY THIS SUITE EXISTS:
 * A tool renderer is handed model output, file content and subprocess bytes, and the repo rule is
 * that every string it displays passes through `replaceTabs`, `truncateToWidth` and `shortenPath`
 * first. Nothing enforced it. The rule was a paragraph in a document, checked by whoever remembered
 * it while writing a renderer, and there are thirty-four registered renderers with two render paths
 * each.
 *
 * The engine is not the backstop it looks like. It resets the style at the end of every row and it
 * truncates a row wider than the terminal, so those two are cosmetic. It does not remove a NUL, a
 * BEL, a backspace or a raw tab, and it writes the row to the terminal as bytes: a control sequence a
 * renderer forwards from a tool result is executed by the emulator, not painted. A `\x1b[2J` in a
 * grep hit clears the screen.
 *
 * WHAT IT ASSERTS:
 * Every renderer in `toolRenderers` is driven over every hostile fixture at three widths, on both its
 * call and its result path, and the resulting rows are judged by the tool-render oracle registry. The
 * tool list is read from the registry at run time, so a renderer registered tomorrow is swept
 * tomorrow, including the one entry that is a lazy getter breaking an import cycle.
 *
 * `KNOWN_OFFENDERS` is the ledger of what the sweep finds today, pinned by exact equality per
 * guarantee. A renderer that starts forwarding a tab, and a renderer that stops, both turn this red:
 * the first is a regression, the second is a fix that should shrink the ledger in the same commit.
 * The pins are `tool/surface` pairs rather than counts, so a new offender cannot hide behind a
 * coincidental total.
 *
 * WHAT THIS SUITE DOES NOT CATCH:
 * - A renderer whose defect needs an argument shape the generic fixture does not build. The fixture
 *   fills the argument names the built-in tools use and leaves the rest inert, so a renderer that
 *   only paints its `details` payload is swept with an empty one.
 * - Whether a row that fits the width is laid out sensibly. Placement is what the composer and
 *   overlay registries judge; this one judges the bytes of a row.
 * - An MCP-bridged or custom tool renderer. Those are not in `toolRenderers`; they reach the same
 *   seam and no sweep drives them yet.
 *
 * MUTATION GATE:
 * 1. Measuring a row in code units instead of cells (`text.length` for `Bun.stringWidth`) turns the
 *    width ledger red: the wide-glyph fixture is 200 characters in 82 cells, so the count decides
 *    which renderers are over width.
 * 2. Collapsing the sweep to one verdict over every render at once turns all six ledgers red: an
 *    oracle reports its first failure, so the first offender hides every other one. That is why the
 *    loop above judges one render at a time.
 *
 * Two mutations that stay GREEN, recorded because they say what the ledger does not distinguish.
 * Dropping the `plainRowOf` strip, and narrowing the widths to `[80]`, both leave every pin intact: a
 * ledger of `tool/surface` pairs is deliberately blind to which fixture or which width tripped a
 * guarantee, because a renderer that mishandles a tab at one width mishandles it at all three. A
 * regression in a fixture's own reach is caught by the fixture and width claims above instead.
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "../src/config/settings";
import {
	TOOL_RENDER_ORACLE_GUARANTEES,
	type ToolRenderOracleGuarantee,
} from "../src/modes/components/tool-render-defect-oracle";
import { getThemeByName, setThemeInstance, type Theme } from "../src/modes/theme/theme";
import { toolRenderers } from "../src/tools/renderers";
import { promoteToolRenderFailureToCorpus } from "./helpers/renderer-defect-corpus";
import {
	evaluateToolRenderAttempts,
	RENDER_FIXTURES,
	type RenderAttempt,
	sweepToolRenders,
} from "./helpers/tool-render-oracle-runner";

const WIDTHS = [40, 80, 120] as const;

/**
 * What the sweep finds today, as `tool/surface` pairs per guarantee.
 *
 * A `Record` over the guarantee union, so a new guarantee does not compile until somebody records
 * what it finds. An empty array is a real entry: it states that no registered renderer trips that
 * guarantee, and it turns red the moment one does.
 */
const KNOWN_OFFENDERS: Readonly<Record<ToolRenderOracleGuarantee, readonly string[]>> = {
	everyRowFitsTheRenderWidth: [
		"glob/result",
		"grep/result",
		"inspect_image/result",
		"read/result",
		"write/call",
		"write/result",
	],
	noContentSuppliedEscapeSurvives: [
		"apply_patch/call",
		"apply_patch/result",
		"ask/result",
		"ast_edit/call",
		"ast_grep/call",
		"bash/call",
		"bash/result",
		"browser/call",
		"browser/result",
		"debug/call",
		"debug/result",
		"edit/call",
		"edit/result",
		"eval/result",
		"github/result",
		"glob/call",
		"glob/result",
		"grep/call",
		"grep/result",
		"inspect_image/call",
		"inspect_image/result",
		"irc/result",
		"job/result",
		"launch/call",
		"launch/result",
		"lsp/call",
		"lsp/result",
		"read/call",
		"read/result",
		"recall/call",
		"recall/result",
		"reflect/call",
		"reflect/result",
		"retain/result",
		"search_tool_bm25/call",
		"search_tool_bm25/result",
		"set_cwd/call",
		"ssh/call",
		"ssh/result",
		"task/result",
		"web_search/call",
		"web_search/result",
		"write/call",
		"write/result",
	],
	noControlCharacterOtherThanStyle: [
		"apply_patch/call",
		"apply_patch/result",
		"ask/result",
		"ast_edit/call",
		"ast_grep/call",
		"bash/call",
		"bash/result",
		"browser/call",
		"browser/result",
		"debug/call",
		"debug/result",
		"edit/call",
		"edit/result",
		"eval/call",
		"eval/result",
		"github/result",
		"glob/call",
		"glob/result",
		"grep/call",
		"grep/result",
		"inspect_image/call",
		"inspect_image/result",
		"irc/result",
		"job/result",
		"launch/call",
		"launch/result",
		"lsp/call",
		"lsp/result",
		"read/call",
		"read/result",
		"recall/call",
		"recall/result",
		"reflect/call",
		"reflect/result",
		"retain/result",
		"search_tool_bm25/call",
		"search_tool_bm25/result",
		"set_cwd/call",
		"ssh/call",
		"ssh/result",
		"task/result",
		"web_search/call",
		"web_search/result",
		"write/call",
		"write/result",
	],
	noHomeDirectoryPathIsPainted: [
		"apply_patch/call",
		"apply_patch/result",
		"ast_edit/call",
		"ast_grep/call",
		"edit/call",
		"edit/result",
		"glob/call",
		"glob/result",
		"grep/call",
		"inspect_image/call",
		"inspect_image/result",
		"read/call",
		"read/result",
		"set_cwd/call",
		"write/call",
		"write/result",
	],
	noRawTabReachesTheScreen: [
		"glob/result",
		"grep/result",
		"inspect_image/result",
		"lsp/result",
		"read/result",
		"retain/result",
		"ssh/result",
		"task/call",
		"task/result",
		"web_search/result",
		"write/call",
		"write/result",
	],
	noRowSmugglesALineBreak: ["launch/result", "read/result", "reflect/result"],
};

let uiTheme: Theme;
let attempts: readonly RenderAttempt[] = [];

/** Which `tool/surface` pairs each guarantee failed on, judged one render at a time. */
const observed = new Map<ToolRenderOracleGuarantee, Set<string>>();
const inspectedSomewhere = new Set<ToolRenderOracleGuarantee>();

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("theme unavailable");
	uiTheme = loaded;
	setThemeInstance(uiTheme);
	attempts = sweepToolRenders({ theme: uiTheme, widths: WIDTHS });
	for (const guarantee of TOOL_RENDER_ORACLE_GUARANTEES) observed.set(guarantee, new Set());
	// One render per verdict rather than one verdict for the whole sweep: an oracle reports its first
	// failure, so a single offender would hide every other one behind it.
	// One case per guarantee, not one per offending render: 126 copies of six defects is a dump, and
	// the first render that trips a guarantee is the one recorded.
	const promoted = new Set<ToolRenderOracleGuarantee>();
	for (const attempt of attempts) {
		if (!attempt.snapshot) continue;
		const verdict = evaluateToolRenderAttempts([attempt]);
		for (const guarantee of verdict.inspected) inspectedSomewhere.add(guarantee);
		for (const failure of verdict.failures) {
			observed.get(failure.oracle)?.add(`${attempt.tool}/${attempt.surface}`);
			if (promoted.has(failure.oracle)) continue;
			promoted.add(failure.oracle);
			promoteToolRenderFailureToCorpus(
				{ tool: attempt.tool, surface: attempt.surface, fixture: attempt.fixture, width: attempt.width },
				failure,
				attempt.snapshot.rawRows,
				{ template: "tool-render-sweep" },
			);
		}
	}
}, 600_000);

describe("the sweep drove the registry it claims", () => {
	it("drove every registered renderer on both of its surfaces", () => {
		const registered = Object.keys(toolRenderers).sort();
		const driven = [...new Set(attempts.map(entry => entry.tool))].sort();
		expect(driven).toEqual(registered);
		for (const tool of registered) {
			const surfaces = [
				...new Set(attempts.filter(entry => entry.tool === tool).map(entry => entry.surface)),
			].sort();
			expect(surfaces, `${tool} was not driven on both surfaces`).toEqual(["call", "result"]);
		}
	});

	it("drove every fixture at every width", () => {
		const expected = RENDER_FIXTURES.length * WIDTHS.length * 2 * Object.keys(toolRenderers).length;
		expect(attempts.length).toBe(expected);
	});

	it("reached a verdict for every guarantee somewhere in the sweep", () => {
		expect([...inspectedSomewhere].sort()).toEqual([...TOOL_RENDER_ORACLE_GUARANTEES].sort());
	});
});

describe("no renderer crashes on hostile content", () => {
	/**
	 * A renderer that throws takes the frame with it: `ToolExecutionComponent` catches it and paints an
	 * error card where the tool card belonged, and the streamed preview path reaches the renderer with
	 * arguments that are half-written by construction.
	 */
	it("returns rows for every render it was asked for", () => {
		const threw = attempts
			.filter(entry => entry.error)
			.map(entry => `${entry.tool}/${entry.surface}/${entry.fixture}@${entry.width}: ${entry.error?.message}`);
		expect(threw).toEqual([]);
	});
});

describe("what the renderers forward today", () => {
	it.each(TOOL_RENDER_ORACLE_GUARANTEES.map(guarantee => [guarantee] as const))(
		"%s: the offenders are exactly the ones on the ledger",
		guarantee => {
			expect([...(observed.get(guarantee) ?? [])].sort()).toEqual([...KNOWN_OFFENDERS[guarantee]].sort());
		},
	);

	/**
	 * NON-VACUITY. The ledger claims above are satisfied for free by a sweep that found nothing, which
	 * is what a broken runner produces. The fixtures are hostile, the renderers do forward some of it,
	 * and this states that the ledger is not empty.
	 */
	it("found something to record", () => {
		const total = [...observed.values()].reduce((sum, set) => sum + set.size, 0);
		expect(total).toBeGreaterThan(0);
	});
});

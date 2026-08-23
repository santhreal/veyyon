/**
 * The anchored todos board's in-flight glyph stops one ink level below a full cell.
 *
 * WHAT THIS CLOSES. The board drew the status spinner's own density ramp, which
 * peaks on `█` once a cycle. In the status line that is right: the row is dense and
 * a full cell is not the largest ink present. On the board it is — the block sits
 * anchored above the composer, every other row is a checkbox or a partial, and at
 * the top of the ramp the pulse reads as a block appearing rather than as a cell
 * breathing, which is too large a glyph for what it means.
 *
 * THE CLASS, not the incident. The invariant is that no frame the board can emit
 * draws the ramp's brightest glyph, swept over every frame index in the ramp rather
 * than the one or two a reader would think to try, and over the completion exhale as
 * well as the in-flight breath. The ramp is read from the theme at run time and the
 * peak is derived from it, so retuning the ramp cannot leave a stale literal here
 * agreeing with nothing. The status line's ramp is asserted UNCHANGED in the same
 * file, because the cheap way to satisfy this suite is to shorten the ramp for
 * everybody, and that is a different change nobody asked for.
 *
 * The derivation's own fence is pinned too: it recognises a rise-and-fall by shape,
 * so a ramp that does not mirror (`ascii`'s `| / - \`), one of odd length, one whose
 * centre glyph repeats, and one too short to have a middle are all returned
 * untouched. Without those a "peak" would be invented for a sequence that has none.
 *
 * WHAT IT DOES NOT CATCH. Whether the shallower pulse reads better to an eye — that
 * is the before-and-after pair on the pull request. It says nothing about the rail
 * motion, the colours, or the timer that supplies `frame`.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { renderTodoBoardLines, type TodoBoardOptions } from "@veyyon/coding-agent/modes/components/todo-board";
import { SPINNER_FRAMES, spinnerRampOneLevelShallower } from "@veyyon/coding-agent/modes/theme/symbols";
import { initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";
import type { TodoItem, TodoPhase } from "@veyyon/coding-agent/tools/todo";
import { TODO_STRIKE_TOTAL_FRAMES } from "@veyyon/coding-agent/tools/todo";

function phase(name: string, tasks: Array<[string, TodoItem["status"]]>): TodoPhase {
	return { name, tasks: tasks.map(([content, status]) => ({ content, status })) };
}

function options(overrides: Partial<TodoBoardOptions> = {}): TodoBoardOptions {
	return {
		columns: 100,
		maxRows: 14,
		expanded: true,
		owners: new Map(),
		striking: new Map(),
		frame: 0,
		animate: true,
		live: true,
		...overrides,
	};
}

function rowsOf(phases: readonly TodoPhase[], overrides: Partial<TodoBoardOptions> = {}): string[] {
	return renderTodoBoardLines(phases, options(overrides)).map(line => Bun.stripANSI(line));
}

const PLAN: TodoPhase[] = [
	phase("Foundation", [
		["scaffold the crate", "completed"],
		["wire the workspace", "in_progress"],
		["port the credential store", "pending"],
	]),
];

describe("the todo board pulse never draws a full cell", () => {
	beforeAll(() => {
		initTheme();
	});

	/** The ramp the status line runs, read from the live theme. */
	const fullRamp = (): readonly string[] => theme.spinnerFrames;

	/**
	 * The frames the board's ramp gives up, as a multiset difference so a glyph
	 * that merely appears fewer times is still counted. Derived from the live
	 * theme rather than spelled out, so retuning the ramp cannot leave a stale
	 * literal here agreeing with nothing.
	 */
	const dropped = (): string[] => {
		const remaining = spinnerRampOneLevelShallower(fullRamp());
		const gone: string[] = [];
		for (const frame of fullRamp()) {
			const at = remaining.indexOf(frame);
			if (at < 0) gone.push(frame);
			else remaining.splice(at, 1);
		}
		return gone.sort();
	};

	/** The first cell after the rail, which is the row's status glyph. */
	const glyphOf = (row: string): string => row.replace(/^\s*▏\s*/, "").slice(0, 1);

	it("gives up the whole top ink level, not the peak alone", () => {
		// Named as well as derived: a reader has to see which glyph the operator
		// called too big, and the two spellings have to agree. `█` is the peak; the
		// second `▓` goes with it, because leaving both would hold the top of the
		// breath for two frames instead of one.
		expect(dropped()).toEqual(["█", "▓"]);
		expect(spinnerRampOneLevelShallower(fullRamp())).toEqual(["·", ":", "░", "▒", "▓", "▒", "░", ":"]);
	});

	it("emits no full cell at any frame of the in-flight breath", () => {
		// Every index in the ramp, not a sample: the peak is one frame in ten, so a
		// spot check passes nine times out of ten while the defect is on screen.
		const seen = new Set<string>();
		for (let frame = 0; frame < fullRamp().length * 3; frame++) {
			const rows = rowsOf(PLAN, { frame });
			const inFlight = rows.find(row => row.includes("wire the workspace")) ?? "";
			expect(inFlight).not.toBe("");
			expect(rows.join("\n")).not.toContain("█");
			// The rail leads every row, so the glyph is the first cell after it.
			seen.add(glyphOf(inFlight));
		}
		// The sweep has to have actually moved the glyph, or "no full cell" is
		// satisfied by a board that draws one static frame forever.
		expect(seen.size).toBeGreaterThan(3);
	});

	it("emits no full cell at any frame of the completion exhale", () => {
		const closing: TodoPhase[] = [phase("Foundation", [["wire the workspace", "completed"]])];
		for (let frame = 0; frame <= TODO_STRIKE_TOTAL_FRAMES; frame++) {
			const striking = new Map([["wire the workspace", frame]]);
			expect(rowsOf(closing, { frame, striking }).join("\n")).not.toContain("█");
		}
	});

	it("leaves the status line's ramp at full depth", () => {
		// The cheap fix is to shorten the ramp for every consumer. The status line
		// is a dense row where a full cell is not the largest ink, so it keeps one.
		expect(fullRamp()).toContain("█");
		expect(SPINNER_FRAMES.unicode.status).toContain("█");
		expect(SPINNER_FRAMES.unicode.activity).toContain("█");
	});

	it("returns a ramp it does not recognise untouched", () => {
		// A peak exists only for a rise and fall. Inventing one for anything else
		// would silently drop a frame from a theme's own spinner.
		for (const [why, frames] of [
			["ascii does not mirror", SPINNER_FRAMES.ascii.status],
			["thinking does not mirror", SPINNER_FRAMES.unicode.thinking],
			["odd length has no centre", ["a", "b", "c", "d", "e"]],
			["a repeated centre is not a peak", ["a", "b", "c", "c", "c", "b"]],
			["too short to have a middle", ["a", "b"]],
			["a single frame", ["a"]],
			["no frames at all", []],
		] as const) {
			expect(spinnerRampOneLevelShallower(frames), why).toEqual([...frames]);
		}
	});

	it("recognises a rise and fall of any even length", () => {
		// The top level comes off whole: the peak plus the rising frame beside it,
		// so what remains is still a rise and fall about one unique peak.
		expect(spinnerRampOneLevelShallower(["a", "b", "c", "b"])).toEqual(["a", "b"]);
		expect(spinnerRampOneLevelShallower(["a", "b", "c", "d", "c", "b"])).toEqual(["a", "b", "c", "b"]);
	});
});

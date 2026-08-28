/**
 * The anchored todos board's in-flight glyph never draws a full cell or density-ramp cell.
 *
 * WHAT THIS CLOSES. The board drew the status spinner's own density ramp, which
 * peaks on `█` once a cycle. In the status line that is right: the row is dense and
 * a full cell is not the largest ink present. On the board it is — the block sits
 * anchored above the composer, every other row is a checkbox or a partial, and at
 * the top of the ramp the pulse reads as a block appearing rather than as a cell
 * breathing, which is too large a glyph for what it means.
 *
 * THE CLASS, not the incident. The invariant is that no frame the board can emit
 * draws the ramp's brightest glyph or any density ramp cell, swept over every frame
 * index in the ramp rather than the one or two a reader would think to try. The
 * in-flight task mark is constrained to `theme.symbol("status.shadowed")` and
 * `theme.symbol("status.done")`. The status line's ramp is asserted UNCHANGED in the
 * same file, because the cheap way to satisfy this suite is to shorten the ramp for
 * everybody, and that is a different change nobody asked for.
 *
 * The derivation's own fence is pinned too: it recognises a rise-and-fall by shape,
 * so a ramp that does not mirror (`ascii`'s `| / - \`), one of odd length, one whose
 * centre glyph repeats, and one too short to have a middle are all returned
 * untouched. Without those a "peak" would be invented for a sequence that has none.
 *
 * WHAT IT DOES NOT CATCH. Whether the mark reads better to an eye — that is the
 * before-and-after pair on the pull request. It says nothing about the rail
 * motion, the colours, or the timer that supplies `frame`.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import {
	renderTodoBoardLines,
	type TodoBoardOptions,
} from "@veyyon/coding-agent/modes/terminal/components/dashboard/todo-board";
import { SPINNER_FRAMES, spinnerRampOneLevelShallower } from "@veyyon/coding-agent/theme/symbols";
import { initTheme, theme } from "@veyyon/coding-agent/theme/theme";
import type { TodoItem, TodoPhase } from "@veyyon/coding-agent/tools/todo";

function phase(name: string, tasks: Array<[string, TodoItem["status"]]>): TodoPhase {
	return { name, tasks: tasks.map(([content, status]) => ({ content, status })) };
}

function options(overrides: Partial<TodoBoardOptions> = {}): TodoBoardOptions {
	return {
		columns: 100,
		maxRows: 14,
		expanded: true,
		owned: new Set<string>(),
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
	beforeAll(async () => {
		await initTheme();
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

	const glyphOf = (row: string, text: string): string => {
		const idx = row.indexOf(text);
		if (idx <= 0) return "";
		const before = row.slice(0, idx).trimEnd();
		const lastSpace = before.lastIndexOf(" ");
		return lastSpace >= 0 ? before.slice(lastSpace + 1) : before;
	};

	it("gives up the whole top ink level, not the peak alone", () => {
		// Named as well as derived: a reader has to see which glyph the operator
		// called too big, and the two spellings have to agree. `█` is the peak; the
		// second `▓` goes with it, because leaving both would hold the top of the
		// breath for two frames instead of one.
		expect(dropped()).toEqual(["█", "▓"]);
		expect(spinnerRampOneLevelShallower(fullRamp())).toEqual(["·", ":", "░", "▒", "▓", "▒", "░", ":"]);
	});

	it("emits no full cell and no density-ramp cell at any frame of the in-flight breath", () => {
		// Across every index in the sweep, the in-flight task row alternates only
		// between status.shadowed and status.done, never drawing `█` and never
		// drawing any density-ramp cell.
		const seenTaskGlyphs = new Set<string>();
		const densityRampCells = ["░", "▒", "▓", "█"];
		for (let frame = 0; frame < fullRamp().length * 3; frame++) {
			const rows = rowsOf(PLAN, { frame, animate: true });
			const joined = rows.join("\n");
			for (const rampCell of densityRampCells) {
				expect(joined).not.toContain(rampCell);
			}

			const inFlight = rows.find(row => row.includes("wire the workspace")) ?? "";
			expect(inFlight).not.toBe("");
			seenTaskGlyphs.add(glyphOf(inFlight, "wire the workspace"));

			const phaseLine = rows.find(row => row.includes("Foundation")) ?? "";
			expect(phaseLine).not.toBe("");
			expect(phaseLine.trimEnd().endsWith(" · 1/3")).toBe(true);
		}
		expect(seenTaskGlyphs).toEqual(new Set([theme.symbol("status.shadowed"), theme.symbol("status.done")]));

		const stillTaskGlyphs = new Set<string>();
		for (let frame = 0; frame < fullRamp().length * 3; frame++) {
			const rows = rowsOf(PLAN, { frame, animate: false });
			const inFlight = rows.find(row => row.includes("wire the workspace")) ?? "";
			expect(inFlight).not.toBe("");
			stillTaskGlyphs.add(glyphOf(inFlight, "wire the workspace"));
		}
		expect(stillTaskGlyphs).toEqual(new Set([theme.symbol("status.done")]));
	});

	it("emits no full cell at any frame of a closed task and holds it still", () => {
		const closing: TodoPhase[] = [phase("Foundation", [["wire the workspace", "completed"]])];
		const rendered = new Set<string>();
		for (let frame = 0; frame < 20; frame++) {
			for (const animate of [true, false]) {
				const lines = renderTodoBoardLines(closing, options({ frame, animate }));
				const stripped = lines.map(line => Bun.stripANSI(line)).join("\n");
				expect(stripped).not.toContain("█");
				for (const rampCell of ["░", "▒", "▓"]) {
					expect(stripped).not.toContain(rampCell);
				}
				const row = lines.find(line => Bun.stripANSI(line).includes("wire the workspace")) ?? "";
				expect(row).not.toBe("");
				rendered.add(row);
			}
		}
		expect(rendered.size).toBe(1);
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

/**
 * WHY THIS EXISTS.
 *
 * The edit card needs its header to FIT: the path is the subject of the row, the counts after it are
 * what a reader checks, and a row that loses either at the last column lost the fact it was drawn
 * for. That was implemented as a rule the terminal applied to EVERY framed block, and every other
 * card inherited it: a search card that states a query and then counts what it found had the query
 * cut to `…` so that counts which already fitted could keep their columns. Eight differential suites
 * went red at once, in both directions -- a card cut where main left the row whole, and a card left
 * whole where main cut it -- because a budget one card measured for itself became a budget the host
 * measured for all of them.
 *
 * THE CLASS THIS CLOSES. A presentation decision that belongs to a card, taken by the host on behalf
 * of every card. The contract is the boundary: a row that must keep its subject says
 * `descriptionFits`, and the host shortens that row and no other. Sweeping the states here rather
 * than trusting one card means the rule is asserted where it is decided.
 *
 * WHAT IT DOES NOT CATCH. Whether a card that NEEDS fitting asks for it: nothing here knows which
 * cards those are, and the per-tool differential suites own that, byte for byte against the renderer
 * main shipped. It also says nothing about how a non-terminal host fits a row -- `descriptionFits` is
 * a requirement, and a middle cut is this terminal's answer to it.
 */

import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { theme } from "@veyyon/coding-agent/theme/theme";
import { drawFramedBlock } from "@veyyon/coding-agent/modes/terminal/draw/draw-tool-view";
import { visibleWidth } from "@veyyon/utils/width";
import type { FramedBlockView, StatusRowView } from "@veyyon/view";
import { useDifferentialTheme } from "../differential/harness";

useDifferentialTheme();

/** A path long enough that no width below outruns it, so the row always has to give something up. */
const PATH = "packages/coding-agent/src/modes/terminal/components/transcript/tool-execution.ts";

/** The trailing facts a card states after its subject, which are what a cut row drops first. */
const META = [[{ text: "+12" }], [{ text: "-3" }]];

function header(fits: boolean): StatusRowView {
	return {
		kind: "statusRow",
		status: "success",
		title: "Edit",
		description: PATH,
		...(fits ? { descriptionFits: true } : {}),
		meta: META,
	};
}

function block(fits: boolean): FramedBlockView {
	return { kind: "framedBlock", header: header(fits), state: "success", sections: [] };
}

/** The header row as a reader sees it: the first drawn row, without its styling. */
function headerRow(fits: boolean, width: number): string {
	const rows = drawFramedBlock(block(fits), theme).render(width);
	return stripVTControlCharacters(rows[0] ?? "").trimEnd();
}

/** Every width from the one that holds the whole row down to one that holds almost nothing. */
const WIDTHS = [200, 120, 100, 80, 60, 40, 24, 12] as const;

describe("a header the card did not ask to fit", () => {
	it("keeps its subject whole however narrow the block is", () => {
		for (const width of WIDTHS) {
			const row = headerRow(false, width);
			// The row is clipped at the frame's edge, so what SURVIVES is a prefix of the untouched
			// row: the subject is never cut inside itself to buy columns for the facts after it.
			const untouched = headerRow(false, 400);
			expect(untouched).toContain(PATH);
			expect(untouched.startsWith(row.trimEnd()) || row === untouched).toBe(true);
			expect(row).not.toContain("…");
		}
	});
});

describe("a header the card asked to fit", () => {
	it("shortens the subject through the middle and keeps the facts after it", () => {
		const row = headerRow(true, 60);
		expect(row).toContain("…");
		expect(row).not.toContain(PATH);
		// Head and tail both survive, which is the whole reason the cut is not at the end: the
		// directory says where, the file name says what.
		expect(row).toContain("packages/");
		expect(row).toContain(".ts");
		expect(row).toContain("+12");
		expect(row).toContain("-3");
	});

	/**
	 * The bound, and the floor under it. Shortening the subject buys columns back until the subject is
	 * one ellipsis, and a row narrower than the title, the mark and the facts cannot be bought back
	 * any further -- so the claim is that fitting reaches the width whenever the fixed parts leave
	 * room, and reaches the floor when they do not. Without the floor stated, a rule that gave up and
	 * returned the row untouched would read the same as one that fitted it.
	 */
	it("reaches the columns it was given, down to the floor its fixed parts set", () => {
		const floor = visibleWidth(headerRow(true, 1));
		expect(floor).toBeGreaterThan(0);
		for (const width of WIDTHS) {
			const drawn = visibleWidth(headerRow(true, width));
			expect(drawn).toBeLessThanOrEqual(Math.max(width, floor));
			if (width < floor) expect(drawn).toBe(floor);
		}
	});

	it("states the subject as an ellipsis rather than dropping it when nothing fits", () => {
		const row = headerRow(true, 12);
		expect(row).toContain("…");
		expect(row).toContain("Edit");
	});

	/**
	 * The control the two rules above rest on. Both are read against the same card, so a flag that
	 * reached nothing would leave the first rule green for the wrong reason -- every row whole because
	 * no row is ever fitted -- and this is the one cell that fails when that happens.
	 */
	it("draws a different row from the card that did not ask", () => {
		for (const width of [60, 40, 24] as const) {
			expect(headerRow(true, width)).not.toBe(headerRow(false, width));
		}
		// And at a width that holds the whole row, the request changes nothing.
		expect(headerRow(true, 200)).toBe(headerRow(false, 200));
	});
});

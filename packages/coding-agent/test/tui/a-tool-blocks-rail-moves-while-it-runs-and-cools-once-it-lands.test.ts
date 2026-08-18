/**
 * WHY THIS EXISTS.
 *
 * The rail beside a tool block had two colours and a hard cut between them, so a
 * command that ran for four seconds sat next to a line that never moved, and the
 * instant its output landed the whole rail changed colour in one frame. The rail
 * now animates: a highlight travels down it while the tool is live, and one
 * settling pass runs down the finished block when its result arrives.
 *
 * The class this closes is not "the rail is the wrong colour". It is every way an
 * animation drawn over already-rendered rows can damage them:
 *
 *   - moving a row, adding one, or dropping one (the blank-band/tearing class),
 *   - changing any visible character rather than only the colour of the rail cell,
 *   - touching a row that is not railed at all (a header, a plain-text preview),
 *   - ending on a frame that is not the block's own bytes, which is what freezes a
 *     half-drawn animation into native scrollback,
 *   - un-settling a row the pass has already settled, which is the same defect
 *     seen from below,
 *   - painting a rail that carries no colour at all to interpolate,
 *   - animating history: a rebuilt transcript row is constructed and handed its
 *     result in one tick, so "it was live once" is not the gate — "its live rail
 *     was painted" is.
 *
 * Every frame of both animations is swept, and the frame lists are derived from
 * the module's own exported constants rather than written out, so raising a frame
 * count or a cycle length cannot leave part of the envelope unswept.
 *
 * WHAT IT DOES NOT CATCH. Whether the motion is VISIBLE: it pins the contrast
 * between the cooled rail and the head of a pass as a channel distance, not as
 * something an eye judged. And it drives `paintRailMotion` plus the component's
 * own interval; a terminal that reorders SGR runs on the way to the screen is out
 * of reach of any in-process test.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { interactionFixtures } from "@veyyon/coding-agent/cli/gallery-fixtures/interaction";
import type { ToolExecutionComponent } from "@veyyon/coding-agent/modes/components/tool-execution";
import { initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";
import { bashToolRenderer } from "@veyyon/coding-agent/tools/bash";
import {
	findRailCell,
	hasRailRow,
	paintRailMotion,
	RAIL_IDLE_CYCLE_MAX_ROWS,
	RAIL_IDLE_ROWS_PER_STEP,
	RAIL_IDLE_STEP_MS,
	RAIL_SETTLE_FRAME_MS,
	RAIL_SETTLE_FRAMES,
	railIdleCycleRows,
	railIdleHeadAt,
	railIdleIntensity,
} from "@veyyon/coding-agent/tui/rail-motion";
import type { TUI } from "@veyyon/tui";
import { useFullColor } from "../helpers/theme-assertions";
import { createToolExecution } from "../helpers/tool-execution";

const WIDTH = 100;
const COMMAND = "cargo test -p lurien-vision --test audio_transcription";
const OUTPUT = [
	"running 6 tests",
	"test transcribes_a_16k_mono_wav ... ok",
	"test rejects_a_truncated_header ... ok",
].join("\n");

/** The settled block, exactly as the renderer draws it with no animation. */
function settledBlock(): readonly string[] {
	return bashToolRenderer
		.renderResult(
			{ content: [{ type: "text", text: OUTPUT }], details: { exitCode: 0 } },
			{ expanded: false, isPartial: false },
			theme,
		)
		.render(WIDTH);
}

/** The running preview, which is the shape the idle pass plays over. */
function runningBlock(): readonly string[] {
	return bashToolRenderer.renderCall({ command: COMMAND }, { expanded: false, isPartial: true }, theme).render(WIDTH);
}

function plain(lines: readonly string[]): string[] {
	return lines.map(line => stripVTControlCharacters(line));
}

/** Every idle step of one full cycle over a block of `railRows` rows. */
function idleSteps(railRows: number): number[] {
	const steps = Math.ceil(railIdleCycleRows(railRows) / RAIL_IDLE_ROWS_PER_STEP);
	return Array.from({ length: steps }, (_, i) => i);
}

/** 1..RAIL_SETTLE_FRAMES. Not named `settleFrames`: that name belongs to the frame-wait helper in
 *  `test/helpers/settle-frames.ts`, and `settle-owner.test.ts` locks it to that one owner. */
const SETTLE_FRAME_STEPS = Array.from({ length: RAIL_SETTLE_FRAMES }, (_, i) => i + 1);

function railHexes(lines: readonly string[]): string[] {
	const rail = theme.symbol("block.rail");
	const out: string[] = [];
	for (const line of lines) {
		const cell = findRailCell(line, rail);
		if (cell) out.push(cell.hex);
	}
	return out;
}

function channelDistance(a: string, b: string): number {
	let worst = 0;
	for (let i = 0; i < 3; i++) {
		const ca = parseInt(a.slice(1 + i * 2, 3 + i * 2), 16);
		const cb = parseInt(b.slice(1 + i * 2, 3 + i * 2), 16);
		worst = Math.max(worst, Math.abs(ca - cb));
	}
	return worst;
}

describe("a tool block's rail while it runs", () => {
	useFullColor();
	beforeAll(async () => {
		await initTheme();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	// A live block is one row while the command streams and grows as output arrives,
	// so both shapes are swept: a claim about "every row" proved on a one-row block
	// is a claim about nothing.
	const shapes: Array<[string, () => readonly string[]]> = [
		["a one-row preview", runningBlock],
		["a block with output", settledBlock],
	];

	for (const [label, build] of shapes) {
		it(`changes the rail's colour and nothing else, on every step of a full cycle over ${label}`, () => {
			const lines = build();
			const rows = railHexes(lines).length;
			expect(rows).toBeGreaterThan(0);
			const rail = theme.symbol("block.rail");

			for (const step of idleSteps(rows)) {
				const painted = paintRailMotion(lines, { kind: "idle", head: railIdleHeadAt(step) }, theme);
				expect(painted).toHaveLength(lines.length);
				expect(plain(painted)).toEqual(plain(lines));
				expect(railHexes(painted)).toHaveLength(rows);
				for (let i = 0; i < lines.length; i++) {
					const before = lines[i]!;
					const after = painted[i]!;
					const cell = findRailCell(before, rail);
					if (!cell) {
						// A header row has no rail, so no frame of this animation may touch it.
						expect(after).toBe(before);
						continue;
					}
					// Everything from the rail glyph rightward is the renderer's, untouched.
					expect(after.slice(after.indexOf(rail))).toBe(before.slice(before.indexOf(rail)));
				}
			}
		});

		it(`keeps the cooled rail far enough from the head to be seen on ${label}`, () => {
			const lines = build();
			const rows = railHexes(lines).length;
			const seen = new Set<string>();
			for (const step of idleSteps(rows)) {
				for (const hex of railHexes(paintRailMotion(lines, { kind: "idle", head: railIdleHeadAt(step) }, theme))) {
					seen.add(hex);
				}
			}
			const hexes = [...seen];
			let widest = 0;
			for (const a of hexes) {
				for (const b of hexes) widest = Math.max(widest, channelDistance(a, b));
			}
			// The defect this replaces was an animation that ran and could not be seen:
			// the accent is already near-white on the default theme, so brightening it
			// alone moved about 20 of 255 levels.
			expect(widest).toBeGreaterThan(60);
		});
	}

	it("carries the highlight across every row, at every height a block can have", () => {
		// Swept across heights rather than measured on one block: the tallest rail the
		// cycle bound allows, and every height below it, because a pass that travels
		// on a five-row block and stalls on a twenty-row one is the same defect.
		for (let rows = 1; rows <= RAIL_IDLE_CYCLE_MAX_ROWS; rows++) {
			const brightest = new Set<number>();
			for (const step of idleSteps(rows)) {
				const head = railIdleHeadAt(step);
				let best = 0;
				let bestRow = 0;
				for (let row = 0; row < rows; row++) {
					const lit = railIdleIntensity(row, rows, head);
					if (lit > best) {
						best = lit;
						bestRow = row;
					}
				}
				if (best > 0) brightest.add(bestRow);
			}
			// Not "some row lights up": every row is the brightest one at some point in
			// the cycle, which is what makes the pass a pass rather than a flicker on
			// one cell.
			expect([...brightest].sort((a, b) => a - b)).toEqual(Array.from({ length: rows }, (_, i) => i));
		}
	});
});

describe("a tool block's rail once its result lands", () => {
	useFullColor();
	beforeAll(async () => {
		await initTheme();
	});

	it("ends the settling pass on the block's own bytes", () => {
		const lines = settledBlock();
		const painted = paintRailMotion(lines, { kind: "settle", frame: RAIL_SETTLE_FRAMES }, theme);
		expect(painted).toEqual(lines);
	});

	it("settles rows from the top and never un-settles one", () => {
		const lines = settledBlock();
		const settled = railHexes(lines);
		const rows = settled.length;
		expect(rows).toBeGreaterThan(1);

		let previousPrefix = 0;
		for (const frame of SETTLE_FRAME_STEPS) {
			const painted = paintRailMotion(lines, { kind: "settle", frame }, theme);
			expect(painted).toHaveLength(lines.length);
			expect(plain(painted)).toEqual(plain(lines));
			const hexes = railHexes(painted);
			let prefix = 0;
			while (prefix < rows && hexes[prefix] === settled[prefix]) prefix++;
			expect(prefix).toBeGreaterThanOrEqual(previousPrefix);
			previousPrefix = prefix;
		}
		expect(previousPrefix).toBe(rows);
	});

	it("leaves the whole rail live on its first frame", () => {
		const lines = settledBlock();
		const settled = railHexes(lines);
		const first = railHexes(paintRailMotion(lines, { kind: "settle", frame: 1 }, theme));
		// The pass begins where the running block left off, so nothing has cooled
		// yet — a first frame that already settled rows would read as a cut.
		for (let i = 0; i < settled.length; i++) expect(first[i]).not.toBe(settled[i]);
	});
});

describe("a rail this animation must not touch", () => {
	useFullColor();
	beforeAll(async () => {
		await initTheme();
	});

	it("leaves a block with no rail exactly as it was", () => {
		const lines = ["Todo 4/9 tasks", "  plain rows, no rail"];
		expect(hasRailRow(lines, theme.symbol("block.rail"))).toBe(false);
		expect(paintRailMotion(lines, { kind: "idle", head: 3 }, theme)).toBe(lines);
	});

	it("animates an indexed rail in the steps its palette has, and leaves a colourless one alone", () => {
		const rail = theme.symbol("block.rail");
		// A 256-colour terminal spells the rail `38;5;n`. It has a colour to move, so
		// it moves, coarsely. A bare glyph has no colour at all, so the honest frame
		// is the row the renderer produced.
		const indexed = [`\x1b[38;5;244m${rail}\x1b[39m output`];
		const uncoloured = [`${rail} output`];
		expect(findRailCell(indexed[0]!, rail)?.hex).toBe("#808080");
		expect(findRailCell(uncoloured[0]!, rail)).toBeUndefined();
		expect(paintRailMotion(indexed, { kind: "idle", head: 0 }, theme)).not.toBe(indexed);
		expect(paintRailMotion(uncoloured, { kind: "settle", frame: 3 }, theme)).toBe(uncoloured);
	});
});

describe("the component that drives the rail", () => {
	useFullColor();
	beforeAll(async () => {
		await initTheme();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	// Both bounded animations a landed tool block can play, so the invariant is
	// pinned for the mechanism rather than for the rail: a `#railSettleFrame` guard
	// that forgets `#todoBoardInterval` is the same defect.
	type LandedResult = Parameters<ToolExecutionComponent["updateResult"]>[0];
	const animatedBlocks: Array<[string, string, unknown, LandedResult]> = [
		[
			"the rail's settling pass",
			"bash",
			{ command: COMMAND },
			{ content: [{ type: "text", text: OUTPUT }], details: { exitCode: 0 } },
		],
		["the todo board's entrance", "todo", interactionFixtures.todo!.args, interactionFixtures.todo!.result!],
	];

	for (const [label, tool, args, result] of animatedBlocks) {
		it(`never changes a byte while claiming its rows are history, during ${label}`, () => {
			vi.useFakeTimers();
			const component = createToolExecution(
				tool,
				args,
				{},
				undefined,
				{ requestRender: vi.fn(), requestComponentRender: vi.fn() } as unknown as TUI,
				process.cwd(),
			);
			component.render(WIDTH);
			component.updateResult(result, false);
			// The engine audits every committed row BELOW the live-region start and
			// repairs a changed byte there with an erase-and-replay of the whole
			// screen. So a frame that changes bytes must still be declaring itself
			// live, whatever the block reports for displacement and sealing. (The two
			// arms reach that from different states: a landed bash block IS finalized
			// and is held live by the settle, a todo board is displaceable and was
			// never final — the invariant is the same and the mechanism must hold it
			// either way.)
			let previous = component.render(WIDTH).join("\n");
			const step = 15;
			let changes = 0;
			for (let elapsed = 0; elapsed <= 1400; elapsed += step) {
				vi.advanceTimersByTime(step);
				const next = component.render(WIDTH).join("\n");
				if (next !== previous) {
					changes++;
					expect(component.getNativeScrollbackLiveRegionStart()).toBe(0);
				}
				previous = next;
			}
			// The sweep is only evidence if the animation actually ran inside it.
			expect(changes).toBeGreaterThan(3);
			// And the envelope ends: an animation that outlived its window would keep
			// rewriting rows the terminal has already scrolled into history.
			for (let elapsed = 0; elapsed <= 600; elapsed += step) {
				vi.advanceTimersByTime(step);
				expect(component.render(WIDTH).join("\n")).toBe(previous);
			}
		});
	}

	it("moves the rail of a rendered live block and settles it once the result lands", () => {
		vi.useFakeTimers();
		const requestComponentRender = vi.fn();
		const component = createToolExecution(
			"bash",
			{ command: COMMAND },
			{},
			undefined,
			{ requestRender: vi.fn(), requestComponentRender } as unknown as TUI,
			process.cwd(),
		);

		const first = component.render(WIDTH).join("\n");
		vi.advanceTimersByTime(RAIL_IDLE_STEP_MS * 3);
		expect(requestComponentRender).toHaveBeenCalledWith(component);
		const second = component.render(WIDTH).join("\n");
		// The rail moved; the command did not.
		expect(second).not.toBe(first);
		expect(stripVTControlCharacters(second)).toBe(stripVTControlCharacters(first));

		const result = {
			content: [{ type: "text" as const, text: OUTPUT }],
			details: { exitCode: 0 },
		};
		component.updateResult(result, false);
		// A block handed its result before anyone rendered it is a rebuilt transcript
		// row: history must not animate, so its bytes are where the settling pass has
		// to end up.
		const rebuilt = createToolExecution(
			"bash",
			{ command: COMMAND },
			{},
			undefined,
			{ requestRender: vi.fn(), requestComponentRender: vi.fn() } as unknown as TUI,
			process.cwd(),
		);
		rebuilt.updateResult(result, false);
		const settled = rebuilt.render(WIDTH);

		const landing = component.render(WIDTH);
		expect(plain(landing)).toEqual(plain(settled));
		expect(landing.join("\n")).not.toBe(settled.join("\n"));

		// The pass is bounded: one envelope later the block is its own settled bytes
		// and nothing is still asking for frames.
		vi.advanceTimersByTime(RAIL_SETTLE_FRAME_MS * (RAIL_SETTLE_FRAMES + 2));
		expect(component.render(WIDTH).join("\n")).toBe(settled.join("\n"));
		requestComponentRender.mockClear();
		vi.advanceTimersByTime(RAIL_SETTLE_FRAME_MS * 10);
		expect(requestComponentRender).not.toHaveBeenCalled();
	});

	it("never animates a block whose result arrived before anyone painted it", () => {
		vi.useFakeTimers();
		const requestComponentRender = vi.fn();
		// This is every row of a rebuilt transcript: constructed and handed its
		// result in one tick, on a resize or a `/clear`-and-redraw. Two hundred rows
		// settling together is not a transition, and gating the settle on "was live"
		// alone does not stop it — a block is live for the instant between its
		// constructor and its result.
		const rebuilt = createToolExecution(
			"bash",
			{ command: COMMAND },
			{},
			undefined,
			{ requestRender: vi.fn(), requestComponentRender } as unknown as TUI,
			process.cwd(),
		);
		rebuilt.updateResult({ content: [{ type: "text", text: OUTPUT }], details: { exitCode: 0 } }, false);
		const drawn = rebuilt.render(WIDTH).join("\n");
		vi.advanceTimersByTime(RAIL_SETTLE_FRAME_MS * (RAIL_SETTLE_FRAMES + 4));
		expect(requestComponentRender).not.toHaveBeenCalled();
		expect(rebuilt.render(WIDTH).join("\n")).toBe(drawn);
	});

	it("stops animating a sealed block", () => {
		vi.useFakeTimers();
		const requestComponentRender = vi.fn();
		const component = createToolExecution(
			"bash",
			{ command: COMMAND },
			{},
			undefined,
			{ requestRender: vi.fn(), requestComponentRender } as unknown as TUI,
			process.cwd(),
		);

		component.render(WIDTH);
		component.seal();
		requestComponentRender.mockClear();
		vi.advanceTimersByTime(RAIL_IDLE_STEP_MS * 20);
		expect(requestComponentRender).not.toHaveBeenCalled();
		const a = component.render(WIDTH).join("\n");
		vi.advanceTimersByTime(RAIL_IDLE_STEP_MS * 20);
		expect(component.render(WIDTH).join("\n")).toBe(a);
	});
});

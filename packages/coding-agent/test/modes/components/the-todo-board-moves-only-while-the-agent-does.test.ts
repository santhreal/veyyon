/**
 * The anchored todo board moves only while the agent is in motion.
 *
 * WHY THIS EXISTS.
 * The defect: The anchored todo board HUD above the composer previously animated
 * whenever a task was marked in progress — including while the session sat completely
 * idle waiting for operator input, because in-progress task marks persist across
 * turn boundaries. Motion was incorrectly keyed on task status rather than agent activity.
 *
 * THE CLASS IT CLOSES.
 * Motion sites recomposing their own animation predicates independently instead of
 * delegating to a single authoritative motion snapshot (`TodoBoardMotion`). Every motion
 * site (the task marker's breath, the rail highlight's travel, and the anchored clock ticker)
 * must read the single motion contract.
 *
 * WHAT IT DOES NOT CATCH.
 * Visual perception and contrast of glyphs on different terminal background themes
 * (which are proven by render fixtures / image captures), or the real-time event loop
 * ticker inside `interactive-mode.ts` that drives `#anchoredStep`.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	renderTodoBoardLines,
	TODO_BOARD_FRAME_DIVISOR,
	type TodoBoardMotion,
	type TodoBoardOptions,
	todoBoardMarkerAnimates,
	todoBoardRailTravels,
} from "@veyyon/coding-agent/modes/components/todo-board";
import { initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";
import type { TodoItem, TodoPhase } from "@veyyon/coding-agent/tools/todo";
import {
	RAIL_IDLE_ROW_MS,
	RAIL_IDLE_ROWS_PER_STEP,
	RAIL_IDLE_STEP_MS,
	railIdleHeadAtMs,
} from "@veyyon/coding-agent/tui/rail-motion";
import { type AnsiPolicy, getAnsiPolicy, setAnsiPolicy } from "@veyyon/tui";

const EXPECTED_MOTION_FIELDS = ["agentInMotion", "live", "transitions"] as const;

type MotionField = (typeof EXPECTED_MOTION_FIELDS)[number];

function phase(name: string, tasks: Array<[string, TodoItem["status"]]>): TodoPhase {
	return { name, tasks: tasks.map(([content, status]) => ({ content, status })) };
}

function options(overrides: Partial<TodoBoardOptions> = {}): TodoBoardOptions {
	return {
		columns: 100,
		maxRows: 14,
		expanded: false,
		owned: new Set<string>(),
		frame: 0,
		animate: true,
		live: false,
		...overrides,
	};
}

/** The block, stripped, without the leading blank the container expects. */
function rowsOf(phases: readonly TodoPhase[], overrides: Partial<TodoBoardOptions> = {}): string[] {
	return renderTodoBoardLines(phases, options(overrides))
		.slice(1)
		.map(line => Bun.stripANSI(line));
}

/** The row naming `text`, stripped of the rail and its space. */
function rowFor(phases: readonly TodoPhase[], text: string, overrides: Partial<TodoBoardOptions> = {}): string {
	const rail = theme.symbol("block.rail");
	const row = rowsOf(phases, overrides).find(line => line.includes(text)) ?? "";
	return row.startsWith(rail) ? row.slice(rail.length + 1) : row;
}

/** The glyph column of the row naming `text`: the first non-space after the indent. */
function glyphFor(phases: readonly TodoPhase[], text: string, overrides: Partial<TodoBoardOptions> = {}): string {
	const row = rowFor(phases, text, overrides);
	const before = row.slice(0, row.indexOf(text)).trimEnd();
	return before.slice(-1);
}

function generateAllMotions(): TodoBoardMotion[] {
	const motions: TodoBoardMotion[] = [];
	for (let i = 0; i < 8; i++) {
		motions.push({
			transitions: (i & 1) !== 0,
			agentInMotion: (i & 2) !== 0,
			live: (i & 4) !== 0,
		});
	}
	return motions;
}

describe("the todo board moves only while the agent does", () => {
	let policy: AnsiPolicy;

	beforeAll(async () => {
		await initTheme();
		policy = getAnsiPolicy();
		setAnsiPolicy("full");
	});

	afterAll(() => {
		setAnsiPolicy(policy);
	});

	describe("exhaustive TodoBoardMotion decision space", () => {
		it("enforces that TodoBoardMotion has exactly three fields", () => {
			const canonical: TodoBoardMotion = {
				transitions: true,
				agentInMotion: true,
				live: true,
			};
			const fields = Object.keys(canonical).sort() as MotionField[];
			expect(fields).toHaveLength(3);
			expect(fields).toEqual([...EXPECTED_MOTION_FIELDS].sort());
		});

		it("evaluates all 8 motion combinations against the canonical rules", () => {
			const allMotions = generateAllMotions();
			expect(allMotions).toHaveLength(8);

			for (const motion of allMotions) {
				const expectedMarker = motion.transitions && motion.agentInMotion;
				const expectedRail = motion.transitions && motion.live && motion.agentInMotion;

				expect(todoBoardMarkerAnimates(motion)).toBe(expectedMarker);
				expect(todoBoardRailTravels(motion)).toBe(expectedRail);
			}
		});
	});

	describe("core behavioral motion invariants", () => {
		it("transitions off is absolute for both marker animation and rail travel", () => {
			const disabledMotions = generateAllMotions().filter(m => !m.transitions);
			expect(disabledMotions).toHaveLength(4);
			for (const motion of disabledMotions) {
				expect(todoBoardMarkerAnimates(motion)).toBe(false);
				expect(todoBoardRailTravels(motion)).toBe(false);
			}
		});

		it("an idle agent with a task marked in progress gets no marker breath and no rail travel", () => {
			const idleWithActiveTask: TodoBoardMotion = {
				transitions: true,
				agentInMotion: false,
				live: true,
			};
			expect(todoBoardMarkerAnimates(idleWithActiveTask)).toBe(false);
			expect(todoBoardRailTravels(idleWithActiveTask)).toBe(false);
		});

		it("a live plan with a moving agent animates both the marker and the rail", () => {
			const liveMoving: TodoBoardMotion = {
				transitions: true,
				agentInMotion: true,
				live: true,
			};
			expect(todoBoardMarkerAnimates(liveMoving)).toBe(true);
			expect(todoBoardRailTravels(liveMoving)).toBe(true);
		});

		it("a moving agent on a settled non-live plan animates the marker but not the rail", () => {
			const settledMoving: TodoBoardMotion = {
				transitions: true,
				agentInMotion: true,
				live: false,
			};
			expect(todoBoardMarkerAnimates(settledMoving)).toBe(true);
			expect(todoBoardRailTravels(settledMoving)).toBe(false);
		});
	});

	describe("renderTodoBoardLines animation integration", () => {
		const testPhases = [
			phase("Active Phase", [
				["Active Task", "in_progress"],
				["Pending Task", "pending"],
			]),
		];

		it("with animate: false, every frame across multiple cycles produces byte-identical rows", () => {
			const frames = Array.from({ length: 16 }, (_, f) => f);
			const baseLines = renderTodoBoardLines(testPhases, options({ animate: false, frame: 0 }));

			for (const frame of frames) {
				const renderedLines = renderTodoBoardLines(testPhases, options({ animate: false, frame }));
				expect(renderedLines).toEqual(baseLines);

				const glyph = glyphFor(testPhases, "Active Task", { animate: false, frame });
				expect(glyph).toBe(theme.symbol("status.done"));
			}
		});

		it("with animate: true, the in-flight glyph alternates strictly between the two lowest theme ramp frames", () => {
			const frames = Array.from({ length: 16 }, (_, f) => f);
			const low = theme.symbol("status.shadowed");
			const high = theme.symbol("status.done");
			expect(low).toBeDefined();
			expect(high).toBeDefined();
			expect(low).not.toBe(high);

			const observedGlyphs = new Set<string>();
			for (const frame of frames) {
				const glyph = glyphFor(testPhases, "Active Task", { animate: true, frame });
				observedGlyphs.add(glyph);
				const expectedGlyph = frame % 2 === 0 ? low : high;
				expect(glyph).toBe(expectedGlyph);
			}

			expect(observedGlyphs).toEqual(new Set([low, high]));
		});
	});

	describe("clock divisor cadence", () => {
		it("pins the board frame to one glyph per four clock steps", () => {
			expect(TODO_BOARD_FRAME_DIVISOR).toBeGreaterThan(1);
			expect(TODO_BOARD_FRAME_DIVISOR).toBe(4);
		});

		// The rail has no divisor of its own: every rail in the product travels at
		// `RAIL_IDLE_ROW_MS` per row off one monotonic clock, so two blocks on
		// screen carry the same head and the board's edge does not crawl at a
		// different speed from the lane block one row above it.
		it("puts the board's rail on the house rate and gives it no divisor", () => {
			expect(RAIL_IDLE_ROW_MS).toBe(RAIL_IDLE_STEP_MS / RAIL_IDLE_ROWS_PER_STEP);
			expect(railIdleHeadAtMs(RAIL_IDLE_ROW_MS * 3)).toBe(3);
			expect(railIdleHeadAtMs(0)).toBe(0);
		});

		it("advances the board frame once per TODO_BOARD_FRAME_DIVISOR clock steps, holding glyph identical across each step block", () => {
			const testPhases = [phase("Active Phase", [["Active Task", "in_progress"]])];
			const low = theme.symbol("status.shadowed");
			const high = theme.symbol("status.done");

			const clockSteps = Array.from({ length: 16 }, (_, s) => s);
			const renderedGlyphs = clockSteps.map(step => {
				const boardFrame = Math.floor(step / TODO_BOARD_FRAME_DIVISOR);
				return glyphFor(testPhases, "Active Task", { animate: true, frame: boardFrame });
			});

			expect(renderedGlyphs.slice(0, 4)).toEqual([low, low, low, low]);
			expect(renderedGlyphs.slice(4, 8)).toEqual([high, high, high, high]);
			expect(renderedGlyphs.slice(8, 12)).toEqual([low, low, low, low]);
			expect(renderedGlyphs.slice(12, 16)).toEqual([high, high, high, high]);
		});
	});
});

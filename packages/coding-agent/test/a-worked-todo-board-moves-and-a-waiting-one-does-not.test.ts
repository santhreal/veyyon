/**
 * The anchored todo board says whether it is being worked, and it says so with
 * motion.
 *
 * WHAT THIS CLOSES. The board was drawn by `renderTreeList`, and a tree cannot be
 * alive: `findRailCell` only finds `block.rail` when it is the first non-space on
 * the row, so a row beginning with `├─` is unreachable by every animation this
 * product owns. The consequence was not cosmetic. A plan with a task in flight
 * and a plan sitting finished, waiting for the operator to say the next thing,
 * rendered BYTE-IDENTICALLY — the loudest region on the screen was the one that
 * could not tell you whose turn it was. Every case here is about a state pair the
 * old board could not distinguish: worked vs waiting, running vs pending,
 * delegated vs local, closing vs closed.
 *
 * THE CLASS, not the incident. The invariant is that each task status renders a
 * distinct GLYPH before any colour is applied, so the board survives a
 * low-contrast theme and a capture that dropped every SGR; that the completion
 * gesture TERMINATES on bytes identical to the settled render; and that the block
 * never exceeds the row budget it was given, because it is an anchored region
 * above the composer and a row that does not fit does not scroll away — it wraps,
 * and the region grows taller on every rebuild. The status sweep enumerates
 * `TODO_STATUSES` at run time, so a fifth status turns this suite red until
 * someone decides what it looks like.
 *
 * WHAT IT DOES NOT CATCH. Whether the sweep reads as motion to an eye, the hues
 * it passes through, or the contrast of a glyph on a grey ground: that is what
 * the image proofs from `scripts/demos/render-todo-board.ts` are for. It also
 * does not drive the interactive-mode timer that supplies `frame` — this is the
 * renderer's contract, and the ticker's is in `interactive-mode`'s own suites.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	activeTodoPhaseIndex,
	renderTodoBoardLines,
	type TodoBoardOptions,
	type TodoBoardOwner,
	todoBoardIsLive,
} from "@veyyon/coding-agent/modes/components/todo-board";
import { initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";
import type { TodoItem, TodoPhase } from "@veyyon/coding-agent/tools/todo";
import { TODO_STRIKE_TOTAL_FRAMES } from "@veyyon/coding-agent/tools/todo";
import { paintRailMotion, railIdleHeadAt } from "@veyyon/coding-agent/tui/rail-motion";
import { type AnsiPolicy, getAnsiPolicy, setAnsiPolicy } from "@veyyon/tui";
import { TODO_STATUSES } from "@veyyon/wire";

const OWNER: TodoBoardOwner = { id: "SecretModularityAudit", accentHex: "#f0863a" };

function phase(name: string, tasks: Array<[string, TodoItem["status"]]>): TodoPhase {
	return { name, tasks: tasks.map(([content, status]) => ({ content, status })) };
}

function options(overrides: Partial<TodoBoardOptions> = {}): TodoBoardOptions {
	return {
		columns: 100,
		maxRows: 14,
		expanded: false,
		owners: new Map(),
		striking: new Map(),
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
	return rowFor(phases, text, overrides).trimStart().slice(0, 1);
}

describe("the todo board's state", () => {
	// A test runner has no TTY, so the theme's own detector answers "plain" and
	// every colour these cases exist to assert would be stripped before the
	// assertion saw it. `setAnsiPolicy` is the documented override; the previous
	// value is restored so nothing that runs after this file inherits it.
	let policy: AnsiPolicy;
	beforeAll(async () => {
		await initTheme();
		policy = getAnsiPolicy();
		setAnsiPolicy("full");
	});
	afterAll(() => {
		setAnsiPolicy(policy);
	});

	/**
	 * The pair that motivated the whole redesign. A plan being worked and a plan
	 * waiting on the operator must not render the same, and the rail is where that
	 * difference lives, because it is the one part of the row that belongs to the
	 * block rather than to a task.
	 */
	it("colours the rail live while work is in flight and flat while it waits", () => {
		const plan = [phase("Auth", [["Refresh a stored token", "in_progress"]])];
		const waiting = [phase("Auth", [["Refresh a stored token", "pending"]])];
		expect(todoBoardIsLive(plan, new Map())).toBe(true);
		expect(todoBoardIsLive(waiting, new Map())).toBe(false);

		const worked = renderTodoBoardLines(plan, options({ live: true }));
		const idle = renderTodoBoardLines(waiting, options({ live: false }));
		const railHex = (lines: string[]): string | undefined =>
			lines[1]?.match(/\x1b\[38;2;(\d+);(\d+);(\d+)m/)?.[0] ??
			lines[1]?.match(/\x1b\[38;5;\d+m/)?.[0] ??
			lines[1]?.match(/\x1b\[\d+m/)?.[0];
		expect(railHex(worked)).not.toBe(railHex(idle));

		// And the sweep the caller paints over a live board moves, while the same
		// pass over the flat one is refused by every row it visits.
		const swept = (frame: number): string =>
			paintRailMotion(worked, { kind: "idle", head: railIdleHeadAt(frame) }, theme).join("\n");
		expect(new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(swept)).size).toBeGreaterThan(1);
	});

	/**
	 * Every status is a different SHAPE, decided before any colour is mixed. The
	 * table is pinned by exact equality and the statuses come from `TODO_STATUSES`
	 * at run time, so a fifth status cannot join the union and quietly inherit
	 * whatever the `default` branch happens to draw.
	 */
	it("draws a distinct glyph for every task status, and the set is decided", () => {
		const glyphs = new Map<string, string>();
		for (const status of TODO_STATUSES) {
			// A phase with no open work left draws its tally row and no task rows, so
			// every status needs one open sibling to be drawn beside at all.
			const plan = [
				phase("Auth", [
					[`task ${status}`, status],
					["sentinel", "pending"],
				]),
			];
			glyphs.set(status, glyphFor(plan, `task ${status}`));
		}
		expect([...glyphs.keys()].sort()).toEqual(["abandoned", "completed", "in_progress", "pending"]);
		expect(glyphs.get("pending")).toBe(theme.symbol("status.shadowed"));
		expect(glyphs.get("completed")).toBe(theme.symbol("status.done"));
		expect(glyphs.get("abandoned")).toBe(theme.symbol("status.aborted"));
		// The running row is a low-ink ramp cell, which is a spinner frame and so
		// is not pinned to one glyph — only to being none of the others.
		expect(new Set(glyphs.values()).size).toBe(TODO_STATUSES.length);
		// And no task row ever draws a checkbox: that vocabulary belongs to the
		// phase rows, which is what stops the two levels of the plan from wearing
		// the same mark.
		const checkboxes = new Set([theme.checkbox.checked, theme.checkbox.unchecked, theme.checkbox.progress]);
		for (const glyph of glyphs.values()) expect(checkboxes.has(glyph)).toBe(false);
	});

	/**
	 * A phase row is a checkbox and a task row never is: `■` for a stage with
	 * nothing open, `◧` for the stage in play, `□` for one nobody has reached. The
	 * stage in play is STATIC — it used to draw the breathing cell its own running
	 * task drew, so the two rows carried one animation between them and neither
	 * said what it meant.
	 */
	it("gives a phase row the checkbox vocabulary, and holds the worked one still", () => {
		const plan = [
			phase("Auth", [["Refresh a stored token", "in_progress"]]),
			phase("Ship", [["Cut the release", "pending"]]),
			phase("Done", [["Wire the store", "completed"]]),
		];
		expect(glyphFor(plan, "Auth")).toBe(theme.checkbox.progress);
		expect(glyphFor(plan, "Ship")).toBe(theme.checkbox.unchecked);
		expect(glyphFor(plan, "Done")).toBe(theme.checkbox.checked);

		const frames = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
		const worked = new Set(frames.map(frame => glyphFor(plan, "Auth", { frame, animate: true })));
		expect([...worked]).toEqual([theme.checkbox.progress]);
		// The task inside it is the row that moves, so the pair is never still together.
		expect(new Set(frames.map(frame => glyphFor(plan, "Refresh", { frame, animate: true }))).size).toBe(2);
	});

	/**
	 * The row in flight breathes with the SMALLEST mark on the surface: the two
	 * lowest ink levels of the ramp, alternating. The full ramp read as a block
	 * appearing and disappearing at the task indent, louder than the work it
	 * reports. With `display.transitions` off the cell must be STILL — a static
	 * glyph, not frame 0 of an animation leaking through as a default.
	 */
	it("breathes the running row with two low-ink cells and holds it still when transitions are off", () => {
		const plan = [phase("Auth", [["Refresh a stored token", "in_progress"]])];
		const frames = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
		const animated = new Set(frames.map(frame => glyphFor(plan, "Refresh", { frame, animate: true })));
		expect(animated.size).toBe(2);
		for (const glyph of animated) expect(theme.spinnerFrames.slice(0, 2)).toContain(glyph);

		const still = new Set(frames.map(frame => glyphFor(plan, "Refresh", { frame, animate: false })));
		expect([...still]).toEqual([theme.spinnerFrames[0]]);
	});

	/**
	 * A completion is a gesture with an END. The strike travels, the glyph exhales
	 * down the ramp, the colour cools — and then the row must be byte-identical to
	 * what the board draws for a task that closed long ago, or the board never
	 * settles and the anchored region repaints forever.
	 */
	it("sweeps a closing task and lands exactly on the settled row", () => {
		const closing = "Refresh a stored token before it expires";
		const plan = [
			phase("Auth", [
				[closing, "completed"],
				["sentinel", "pending"],
			]),
		];
		// The row is located by its STRIPPED text, because the sweep plants
		// `\x1b[29m` at the boundary it has reached and that boundary lands inside
		// a word on most frames — matching the raw line would silently stop finding
		// the row exactly where the gesture is most interesting.
		const at = (frames: number | undefined): string => {
			const striking = frames === undefined ? new Map<string, number>() : new Map([[closing, frames]]);
			const lines = renderTodoBoardLines(plan, options({ striking }));
			// The gesture never changes the shape of the block: same rows, same order.
			expect(lines.length).toBe(5);
			return lines.find(line => Bun.stripANSI(line).includes("expires")) ?? "";
		};
		const settled = at(undefined);
		expect(settled).not.toBe("");

		const window = Array.from({ length: TODO_STRIKE_TOTAL_FRAMES }, (_, frame) => at(frame));
		// The gesture is not a state flip: the envelope passes through several
		// distinct renderings rather than appearing whole.
		expect(new Set(window).size).toBeGreaterThan(2);
		// The strike only ever grows: the struck prefix is non-decreasing, so the
		// sweep cannot travel backwards on a frame the caller repeated.
		const struck = window.map(line => {
			const start = line.indexOf("\x1b[9m");
			if (start < 0) return 0;
			const end = line.indexOf("\x1b[29m", start);
			return Bun.stripANSI(line.slice(start, end < 0 ? undefined : end)).length;
		});
		for (let i = 1; i < struck.length; i++) {
			expect(struck[i]!).toBeGreaterThanOrEqual(struck[i - 1]!);
		}
		expect(struck.at(-1)!).toBeGreaterThan(struck[0]!);
		// And it terminates: the frame after the envelope is the settled row, to the
		// byte, and so is every frame after that.
		expect(at(TODO_STRIKE_TOTAL_FRAMES)).toBe(settled);
		expect(at(TODO_STRIKE_TOTAL_FRAMES + 5)).toBe(settled);
		expect(at(TODO_STRIKE_TOTAL_FRAMES + 400)).toBe(settled);
	});

	/**
	 * The board used to compute which pending task a detached subagent was on and
	 * then throw the agent away, keeping a boolean: it could say "someone is on
	 * this" and never "who", while the lane one row below said who and never which
	 * task. The owner id in that agent's own accent is the join.
	 */
	it("names the agent working a delegated row and breathes it like local work", () => {
		const plan = [phase("Auth", [["Audit the secrets subsystem", "pending"]])];
		const owners = new Map([["Audit the secrets subsystem", OWNER]]);
		const delegated = rowFor(plan, "Audit", { owners, live: true });
		expect(delegated).toContain(OWNER.id);
		// Right-aligned, so the id column lines up down the block.
		expect(delegated.trimEnd().endsWith(OWNER.id)).toBe(true);
		// A delegated row IS an in-progress row: same shape, different observer.
		expect(theme.spinnerFrames.slice(0, 2)).toContain(glyphFor(plan, "Audit", { owners, live: true }));
		// Unowned, the same task is a waiting mark and names nobody.
		expect(rowFor(plan, "Audit")).not.toContain(OWNER.id);
		expect(glyphFor(plan, "Audit")).toBe(theme.symbol("status.shadowed"));
	});

	/**
	 * A trim drops what the plan has FINISHED, oldest first, never the work in
	 * flight. Cutting the tail instead is what a ten-phase plan sitting in phase
	 * eight would have shown: a board of nothing but closed tallies.
	 */
	it("trims finished phases from the top and keeps the phase being worked", () => {
		const phases: TodoPhase[] = [];
		for (let i = 0; i < 8; i++) phases.push(phase(`Done ${i}`, [[`closed ${i}`, "completed"]]));
		phases.push(phase("Live", [["the work in flight", "in_progress"]]));
		phases.push(phase("Next", [["what comes after", "pending"]]));
		expect(activeTodoPhaseIndex(phases)).toBe(8);

		const rows = rowsOf(phases, { maxRows: 6, live: true });
		expect(rows.length).toBeLessThanOrEqual(6);
		expect(rows.join("\n")).toContain("the work in flight");
		expect(rows.join("\n")).toContain("Live");
		expect(rows.join("\n")).not.toContain("Done 0");
		// The count of what came off lives in the overflow row and nowhere else.
		const overflow = rows.find(row => row.includes("more")) ?? "";
		const hidden = Number.parseInt(overflow.match(/(\d+) more/)?.[1] ?? "0", 10);
		expect(hidden).toBeGreaterThan(0);
	});

	/**
	 * The block is anchored above the composer, so a row wider than the viewport
	 * does not scroll away: it wraps, and the region grows taller on every
	 * rebuild until it eats the screen. Swept rather than sampled, because a
	 * clamp that holds at 100 columns and fails at 31 is the normal shape of this
	 * defect.
	 */
	it("fits every terminal width, at every state it can draw", () => {
		const long = "x".repeat(300);
		const phases = [
			phase(`Stage ${long}`, [
				[`start ${long} end`, "in_progress"],
				[`closed ${long}`, "completed"],
				[`owned ${long}`, "pending"],
			]),
		];
		const owners = new Map([[`owned ${long}`, OWNER]]);
		const striking = new Map([[`closed ${long}`, 4]]);
		for (let columns = 1; columns <= 160; columns++) {
			for (const expanded of [false, true]) {
				const lines = renderTodoBoardLines(phases, options({ columns, expanded, owners, striking, live: true }));
				expect(lines.length).toBeLessThanOrEqual(15);
				for (const line of lines) {
					expect(Bun.stringWidth(Bun.stripANSI(line))).toBeLessThanOrEqual(columns - 1);
				}
			}
		}
	});

	/** Nothing to draw is an empty block, so the anchored container clears itself. */
	it("draws nothing for an empty plan", () => {
		expect(renderTodoBoardLines([], options())).toEqual([]);
		expect(renderTodoBoardLines([phase("Empty", [])], options())).toEqual([]);
	});
});

/**
 * The anchored todo board states whether work is in flight, and indicates motion
 * only while the agent is active.
 *
 * WHAT THIS CLOSES. The board was drawn by `renderTreeList`, and a tree cannot be
 * alive: `findRailCell` only finds `block.rail` when it is the first non-space on
 * the row, so a row beginning with `├─` is unreachable by every animation this
 * product owns. The consequence was not cosmetic. A plan with a task in flight
 * and a plan sitting finished, waiting for the operator to say the next thing,
 * rendered identically — the loudest region on the screen was the one that
 * could not tell you whose turn it was. Every case here is about a state pair the
 * old board could not distinguish: worked vs waiting, running vs pending,
 * delegated vs local.
 *
 * THE CLASS, not the incident. The invariant is that each task status renders a
 * distinct glyph or formatting state before any colour is applied, so the board
 * survives a low-contrast theme and a capture that dropped every SGR; that closed
 * tasks remain completely static across frames and animation settings; and that
 * the block never exceeds the row budget it was given, because it is an anchored
 * region above the composer and a row that does not fit does not scroll away — it
 * wraps, and the region grows taller on every rebuild. The status sweep enumerates
 * `TODO_STATUSES` at run time, so a fifth status turns this suite red until
 * someone decides what it looks like.
 *
 * WHAT IT DOES NOT CATCH. Whether the mark reads as motion to an eye, the hues
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
	todoBoardIsLive,
} from "@veyyon/coding-agent/modes/terminal/components/dashboard/todo-board";
import { initTheme, theme } from "@veyyon/coding-agent/theme/theme";
import type { TodoItem, TodoPhase } from "@veyyon/coding-agent/tools/todo";
import { todoStrikeReveal } from "@veyyon/coding-agent/tools/todo";
import { paintRailMotion, railIdleHeadAt } from "@veyyon/coding-agent/tui/rail-motion";
import { type AnsiPolicy, getAnsiPolicy, setAnsiPolicy } from "@veyyon/tui";
import { TODO_STATUSES } from "@veyyon/wire";

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

/** The raw line naming `text`. */
function rawRowFor(phases: readonly TodoPhase[], text: string, overrides: Partial<TodoBoardOptions> = {}): string {
	const lines = renderTodoBoardLines(phases, options(overrides)).slice(1);
	return lines.find(line => Bun.stripANSI(line).includes(text)) ?? "";
}

/** The row naming `text`, stripped of ANSI. */
function rowFor(phases: readonly TodoPhase[], text: string, overrides: Partial<TodoBoardOptions> = {}): string {
	return rowsOf(phases, overrides).find(line => line.includes(text)) ?? "";
}

/** The glyph preceding `text` in its row. */
function glyphFor(phases: readonly TodoPhase[], text: string, overrides: Partial<TodoBoardOptions> = {}): string {
	const row = rowFor(phases, text, overrides);
	const idx = row.indexOf(text);
	if (idx <= 0) return "";
	const before = row.slice(0, idx).trimEnd();
	const lastSpace = before.lastIndexOf(" ");
	return lastSpace >= 0 ? before.slice(lastSpace + 1) : before;
}

describe("the todo board's state", () => {
	let policy: AnsiPolicy;
	beforeAll(async () => {
		await initTheme();
		policy = getAnsiPolicy();
		setAnsiPolicy("full");
	});
	afterAll(() => {
		setAnsiPolicy(policy);
	});

	it("colours the rail live while work is in flight and flat while it waits", () => {
		const plan = [phase("Auth", [["Refresh a stored token", "in_progress"]])];
		const waiting = [phase("Auth", [["Refresh a stored token", "pending"]])];
		expect(todoBoardIsLive(plan, new Set())).toBe(true);
		expect(todoBoardIsLive(waiting, new Set())).toBe(false);

		const worked = renderTodoBoardLines(plan, options({ live: true }));
		const idle = renderTodoBoardLines(waiting, options({ live: false }));
		const railHex = (lines: string[]): string | undefined =>
			lines[1]?.match(/\x1b\[38;2;(\d+);(\d+);(\d+)m/)?.[0] ??
			lines[1]?.match(/\x1b\[38;5;\d+m/)?.[0] ??
			lines[1]?.match(/\x1b\[\d+m/)?.[0];
		expect(railHex(worked)).not.toBe(railHex(idle));

		const swept = (frame: number): string =>
			paintRailMotion(worked, { kind: "idle", head: railIdleHeadAt(frame) }, theme).join("\n");
		expect(new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(swept)).size).toBeGreaterThan(1);
	});

	it("draws a distinct glyph and styling for every task status, and the set is decided", () => {
		const glyphs = new Map<string, string>();
		for (const status of TODO_STATUSES) {
			const plan = [
				phase("Auth", [
					[`task ${status}`, status],
					["sentinel", "pending"],
				]),
			];
			glyphs.set(status, glyphFor(plan, `task ${status}`, { animate: false }));
		}
		expect([...glyphs.keys()].sort()).toEqual(["abandoned", "completed", "in_progress", "pending"]);
		expect(glyphs.get("pending")).toBe(theme.checkbox.unchecked);
		expect(glyphs.get("completed")).toBe(theme.checkbox.checked);
		expect(glyphs.get("abandoned")).toBe(theme.checkbox.unchecked);
		expect(glyphs.get("in_progress")).toBe(theme.symbol("status.done"));

		// Struck text and status colors separate completed and abandoned from pending.
		const plan = [
			phase("Auth", [
				["task completed", "completed"],
				["task abandoned", "abandoned"],
				["task in_progress", "in_progress"],
				["task pending", "pending"],
			]),
		];
		const completedRow = rawRowFor(plan, "task completed");
		expect(completedRow).toContain(
			theme.fg("success", `${theme.checkbox.checked} ${todoStrikeReveal("task completed", undefined)}`),
		);

		const abandonedRow = rawRowFor(plan, "task abandoned");
		expect(abandonedRow).toContain(
			theme.fg("error", `${theme.checkbox.unchecked} ${todoStrikeReveal("task abandoned", undefined)}`),
		);

		const inProgressRow = rawRowFor(plan, "task in_progress");
		expect(inProgressRow).toContain(theme.fg("accent", `${theme.symbol("status.shadowed")} task in_progress`));

		const pendingRow = rawRowFor(plan, "task pending");
		expect(pendingRow).toContain(theme.fg("dim", `${theme.checkbox.unchecked} task pending`));
	});

	it("renders phase rows with tallies and no glyphs, drawing tasks only for the active phase when collapsed", () => {
		const plan = [
			phase("Auth", [["Refresh a stored token", "in_progress"]]),
			phase("Ship", [["Cut the release", "pending"]]),
			phase("Done", [["Wire the store", "completed"]]),
		];

		const collapsedRows = rowsOf(plan, { expanded: false });
		const collapsedText = collapsedRows.join("\n");
		expect(collapsedText).toContain("I. Auth · 0/1");
		expect(collapsedText).toContain("II. Ship · 0/1");
		expect(collapsedText).toContain("III. Done · 1/1");
		expect(collapsedText).toContain("Refresh a stored token");
		expect(collapsedText).not.toContain("Cut the release");
		expect(collapsedText).not.toContain("Wire the store");

		const activeRow = rawRowFor(plan, "Auth", { expanded: false });
		expect(activeRow).toContain(theme.bold(theme.fg("accent", "I. Auth")));
		expect(activeRow).toContain(theme.fg("dim", " · 0/1"));

		const inactiveRow = rawRowFor(plan, "Ship", { expanded: false });
		expect(inactiveRow).toContain(theme.fg("muted", "II. Ship"));
		expect(inactiveRow).toContain(theme.fg("dim", " · 0/1"));

		const expandedRows = rowsOf(plan, { expanded: true });
		const expandedText = expandedRows.join("\n");
		expect(expandedText).toContain("Refresh a stored token");
		expect(expandedText).toContain("Cut the release");
		expect(expandedText).toContain("Wire the store");

		const frames = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
		const phaseHeaderRows = new Set(frames.map(frame => rowFor(plan, "Auth", { frame, animate: true })));
		expect(phaseHeaderRows.size).toBe(1);
	});

	it("alternates the in-flight mark between shadowed and done, and holds it on done when animate is false", () => {
		const plan = [phase("Auth", [["Refresh a stored token", "in_progress"]])];
		const frames = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
		const animated = new Set(frames.map(frame => glyphFor(plan, "Refresh", { frame, animate: true })));
		expect(animated).toEqual(new Set([theme.symbol("status.shadowed"), theme.symbol("status.done")]));

		const still = new Set(frames.map(frame => glyphFor(plan, "Refresh", { frame, animate: false })));
		expect(still).toEqual(new Set([theme.symbol("status.done")]));
	});

	it("holds a completed task's row still across frames and animation states", () => {
		const closing = "Refresh a stored token before it expires";
		const plan = [
			phase("Auth", [
				[closing, "completed"],
				["sentinel", "pending"],
			]),
		];
		const rendered = new Set<string>();
		for (let frame = 0; frame < 20; frame++) {
			for (const animate of [true, false]) {
				const row = rawRowFor(plan, "expires", { frame, animate });
				expect(row).not.toBe("");
				rendered.add(row);
			}
		}
		expect(rendered.size).toBe(1);
		const line = [...rendered][0]!;
		expect(line).toContain(theme.checkbox.checked);
		expect(line).toContain("\x1b[9m");
	});

	it("draws an owned pending task like in_progress and an unowned one in dim", () => {
		const plan = [phase("Auth", [["Audit the secrets subsystem", "pending"]])];
		const owned = new Set(["Audit the secrets subsystem"]);

		expect(todoBoardIsLive(plan, owned)).toBe(true);
		expect(todoBoardIsLive(plan, new Set())).toBe(false);

		const delegatedRaw = rawRowFor(plan, "Audit", { owned, live: true, animate: false });
		expect(delegatedRaw).toContain(theme.fg("accent", `${theme.symbol("status.done")} Audit the secrets subsystem`));
		expect(glyphFor(plan, "Audit", { owned, live: true, animate: false })).toBe(theme.symbol("status.done"));

		const delegatedAnimated = new Set(
			[0, 1, 2, 3, 4, 5].map(frame => glyphFor(plan, "Audit", { owned, live: true, frame, animate: true })),
		);
		expect(delegatedAnimated).toEqual(new Set([theme.symbol("status.shadowed"), theme.symbol("status.done")]));

		const unownedRaw = rawRowFor(plan, "Audit", { owned: new Set(), live: false });
		expect(unownedRaw).toContain(theme.fg("dim", `${theme.checkbox.unchecked} Audit the secrets subsystem`));
		expect(glyphFor(plan, "Audit", { owned: new Set() })).toBe(theme.checkbox.unchecked);
	});

	it("omits finished phases and bounds following phases when collapsed on an in-flight phase", () => {
		const phases: TodoPhase[] = [];
		for (let i = 0; i < 8; i++) {
			phases.push(phase(`Done ${i}`, [[`closed ${i}`, "completed"]]));
		}
		phases.push(phase("Live", [["the work in flight", "in_progress"]]));
		for (let i = 0; i < 6; i++) {
			phases.push(phase(`Next ${i}`, [[`future ${i}`, "pending"]]));
		}
		expect(activeTodoPhaseIndex(phases)).toBe(8);

		const rows = rowsOf(phases, { expanded: false, live: true });
		expect(rows[0]).toContain("phase 9/15");

		const bodyText = rows.join("\n");
		for (let i = 0; i < 8; i++) {
			expect(bodyText).not.toContain(`Done ${i}`);
			expect(bodyText).not.toContain(`closed ${i}`);
		}

		expect(bodyText).toContain("Live");
		expect(bodyText).toContain("the work in flight");

		// At most four subsequent phases are drawn.
		expect(bodyText).toContain("Next 0");
		expect(bodyText).toContain("Next 3");
		expect(bodyText).not.toContain("Next 4");
		expect(bodyText).not.toContain("Next 5");

		// Header (1) + Live phase (1) + Live task (1) + 4 subsequent phases (4) = 7 rows.
		expect(rows.length).toBe(7);
	});

	it("trims the tail of the block when rows exceed the row budget and reports overflow", () => {
		const phases: TodoPhase[] = [
			phase("Live", [
				["task 1", "in_progress"],
				["task 2", "pending"],
				["task 3", "pending"],
			]),
			phase("Next 1", [["next 1", "pending"]]),
			phase("Next 2", [["next 2", "pending"]]),
		];
		const rows = rowsOf(phases, { maxRows: 4, live: true });
		expect(rows.length).toBeLessThanOrEqual(4);
		const overflow = rows.find(row => row.includes("more")) ?? "";
		const hidden = Number.parseInt(overflow.match(/… (\d+) more/)?.[1] ?? "0", 10);
		expect(hidden).toBeGreaterThan(0);
	});

	it("fits every terminal width, at every state it can draw", () => {
		const long = "x".repeat(300);
		const phases = [
			phase(`Stage ${long}`, [
				[`start ${long} end`, "in_progress"],
				[`closed ${long}`, "completed"],
				[`owned ${long}`, "pending"],
			]),
		];
		const owned = new Set([`owned ${long}`]);
		for (let columns = 1; columns <= 160; columns++) {
			for (const expanded of [false, true]) {
				const lines = renderTodoBoardLines(phases, options({ columns, expanded, owned, live: true }));
				expect(lines.length).toBeLessThanOrEqual(15);
				for (const line of lines) {
					if (columns >= 20) {
						expect(Bun.stringWidth(Bun.stripANSI(line))).toBeLessThanOrEqual(columns - 1);
					}
				}
			}
		}
	});

	it("draws nothing for an empty plan", () => {
		expect(renderTodoBoardLines([], options())).toEqual([]);
		expect(renderTodoBoardLines([phase("Empty", [])], options())).toEqual([]);
	});
});

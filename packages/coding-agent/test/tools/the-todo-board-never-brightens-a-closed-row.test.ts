/**
 * WHY. The board's entrance ramps each row UP to its own colour — dim, muted,
 * then the colour the row keeps — one frame behind the row above it, so the wave
 * travelling down the block reads as the panel assembling. A row whose settled
 * colour is already the dimmest has nowhere to ramp, and tinting it anyway made a
 * COMPLETED task and a CLOSED phase brighten at mid-entrance and fade back. The
 * entrance flashed the eye onto finished work, which is the exact weighting the
 * board was rebuilt to stop: closed work recedes, the task in flight dominates.
 *
 * It was found by looking at a render of frames 1/3/5/7, which is why it is
 * pinned by bytes here. Nothing in the board's other suites can see it: they
 * assert on stripped text, and this defect lives only in the colours.
 *
 * THE CLASS. Not "the completed row stays dim". The invariant is that a row's
 * brightness over the entrance is MONOTONE NON-DECREASING and never passes the
 * colour it settles at — checked frame by frame, for a row of EVERY status, on
 * both of the two independent code paths that got it wrong (`formatTodoLine` for
 * a task, `todoPhaseRow` for a phase). Every status is on the board because the
 * defect is in a shared tint table: a variant that spared `completed` and
 * overshot `pending` is the same bug with a different victim, and a board holding
 * only closed and in-flight rows cannot see it.
 *
 * VARIANTS TRIED AGAINST THIS SUITE, and whether it caught them: tinting the
 * completed task row (caught, ceiling); tinting the closed phase row (caught,
 * ceiling); both at once (caught); a tint table raised to
 * `{arriving: "muted", settling: "accent"}`, which spares closed rows and
 * overshoots pending ones (caught, by the pending row's ceiling — it was NOT
 * caught before that row was added); a tint applied to the abandoned row, whose
 * settled colour is a hue rather than a rung (caught, by its own ladder). One
 * gets through: a renderer that reorders the rows so the wave runs bottom-up
 * still satisfies every assertion here, because this file pins each row's own
 * walk and not the order they light in. That is the render proof's job.
 *
 * WHAT IT DOES NOT CATCH. Whether the ladder's colours are distinguishable to a
 * human; this file only asserts they are distinct BYTES. Nor the strike-through,
 * which is sequenced against the entrance in `todo.test.ts`, nor row order or
 * layout, which are `todo.test.ts` and `todo-hud-states.test.ts`.
 */

import { afterAll, beforeAll, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { RenderResultOptions } from "@veyyon/coding-agent/extensibility/custom-tools/types";
import { initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { TODO_BOARD_TOTAL_FRAMES, type TodoPhase, TodoTool, todoToolRenderer } from "@veyyon/coding-agent/tools/todo";
import { type AnsiPolicy, type Component, getAnsiPolicy, setAnsiPolicy } from "@veyyon/tui";

const COLUMNS = 120;

function createSession(): ToolSession {
	let phases: TodoPhase[] = [];
	return {
		cwd: "/tmp/test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		getTodoPhases: () => phases,
		setTodoPhases: next => {
			phases = next;
		},
	};
}

// The colour IS the contract here, and a piped `bun test` resolves the policy to
// `plain`, which turns every `theme.fg` into the identity function and would make
// every assertion below pass while proving nothing. Restored after the file so the
// rest of the suite is unaffected.
let previousAnsiPolicy: AnsiPolicy = "plain";

beforeAll(async () => {
	previousAnsiPolicy = getAnsiPolicy();
	setAnsiPolicy("full");
	await initTheme();
});

afterAll(() => {
	setAnsiPolicy(previousAnsiPolicy);
});

/** The SGR prefix `theme.fg` emits for one colour, isolated from any content. */
const code = (name: "dim" | "muted" | "accent" | "error"): string => theme.fg(name, "\u0000").split("\u0000")[0]!;

/**
 * The row's rung on a brightness ladder: the LAST ladder colour opened before its
 * text. The block draws a rail down the left in its own colour, and bold and
 * strike carry their own SGR, so a naive `includes` reads the chrome rather than
 * the row.
 *
 * The ladder deliberately carries colours the row must NEVER reach. A ladder that
 * stopped at the row's own colour could not express an overshoot, which is the
 * whole defect.
 */
function rung(line: string, needle: string, ladder: readonly string[]): number {
	const at = line.indexOf(needle);
	if (at < 0) throw new Error(`row ${JSON.stringify(needle)} is not on this frame: ${JSON.stringify(line)}`);
	const prefix = line.slice(0, at);
	let best = -1;
	let bestAt = -1;
	for (const [index, colour] of ladder.entries()) {
		const found = prefix.lastIndexOf(colour);
		if (found > bestAt) {
			bestAt = found;
			best = index;
		}
	}
	if (best < 0) throw new Error(`row ${JSON.stringify(needle)} carries no ladder colour: ${JSON.stringify(line)}`);
	return best;
}

/**
 * A board mid-flight carrying one row of every status, plus a sealed phase.
 *
 * `alpha` and `epsilon` closed on earlier writes, so they are not in the final
 * result's completion keys and their strike-through is drawn as one run — which
 * keeps their text contiguous and addressable. `beta` is the task that closed on
 * THIS write and is therefore mid-strike, so it is not used as a needle. `gamma`
 * is in flight, `delta` is pending, and the board is not finished, so it does not
 * collapse to the one-line summary.
 */
async function midFlightBoard(): Promise<{ component: Component; options: RenderResultOptions }> {
	const tool = new TodoTool(createSession());
	await tool.execute("call-1", {
		op: "init",
		list: [
			{ phase: "Sealed", items: ["alpha"] },
			{ phase: "Live", items: ["beta", "gamma", "delta", "epsilon"] },
		],
	});
	await tool.execute("call-2", { op: "done", task: "alpha" });
	await tool.execute("call-3", { op: "drop", task: "epsilon" });
	const result = await tool.execute("call-4", { op: "done", task: "beta" });
	const options: RenderResultOptions = { expanded: true, isPartial: false, spinnerFrame: undefined };
	return { component: todoToolRenderer.renderResult(result, options, theme), options };
}

/** The walk of one row's rungs across the entrance, frame 1 upwards. */
function walk(component: Component, options: RenderResultOptions, needle: string, ladder: readonly string[]): number[] {
	const rungs: number[] = [];
	// Frame 0 is deliberately the SETTLED board: still consumers (the gallery, an
	// HTML export, a collab guest) pass a fixed 0 and render once, and that
	// contract is pinned in `todo.test.ts`. So the entrance starts at 1, and
	// walking from 0 would read the settled frame as the ramp's first step.
	for (let frame = 1; frame <= TODO_BOARD_TOTAL_FRAMES; frame++) {
		options.spinnerFrame = frame;
		const line = component.render(COLUMNS).find(candidate => candidate.includes(needle));
		if (!line) throw new Error(`frame ${frame} dropped the row ${JSON.stringify(needle)}`);
		rungs.push(rung(line, needle, ladder));
	}
	return rungs;
}

it("never draws any row brighter than the colour it settles at", async () => {
	const ladder = [code("dim"), code("muted"), code("accent")] as const;
	// The guard that stops everything below being vacuous: identical codes would
	// make `rung` return the same rung for every row on every frame.
	expect(new Set(ladder).size).toBe(3);

	const { component, options } = await midFlightBoard();

	// One row per status, plus both phase rows, by needles that survive the
	// strike-through. The ceilings are asserted rather than assumed, because the
	// whole test is "never past the ceiling" and a wrong ceiling would pass it.
	const ceilings = new Map([
		["I. Sealed", 0],
		["alpha", 0],
		["delta", 1],
		["II. Live", 2],
		["gamma", 2],
	]);

	options.spinnerFrame = undefined;
	const settledFrame = component.render(COLUMNS).join("\n");
	for (const [needle, ceiling] of ceilings) {
		expect(rung(settledFrame, needle, ladder)).toBe(ceiling);
	}
	// A board with no brightness range at all would satisfy "never brighter than
	// settled" trivially, so the ladder has to be exercised end to end.
	expect(new Set(ceilings.values())).toEqual(new Set([0, 1, 2]));

	for (const [needle, ceiling] of ceilings) {
		const rungs = walk(component, options, needle, ladder);

		for (const [index, here] of rungs.entries()) {
			// The ceiling: never past where this row ends up.
			expect(here).toBeLessThanOrEqual(ceiling);
			// Monotone. A row that brightens and fades back is the defect, and no
			// single-frame assertion can see it.
			const previous = rungs[index - 1];
			if (previous !== undefined) expect(here).toBeGreaterThanOrEqual(previous);
		}
		// Every row starts at the bottom and finishes at its ceiling: a renderer
		// that drew each row at its final colour from frame 1 would otherwise pass
		// everything above, and so would one that never finished arriving.
		expect(rungs[0]).toBe(0);
		expect(rungs.at(-1)).toBe(ceiling);
	}

	// The row with the furthest to travel passed through every rung rather than
	// jumping, which is what makes the entrance read as a ramp.
	expect(new Set(walk(component, options, "gamma", ladder)).size).toBe(ladder.length);
});

/**
 * The abandoned row settles on a HUE rather than a rung, so it gets its own
 * ladder. A tint table that ramped it through `accent` would be as wrong as an
 * overshoot, and the shared ladder above cannot rank `error` to see it.
 */
it("ramps an abandoned row to its own colour and no other", async () => {
	const ladder = [code("dim"), code("muted"), code("error")] as const;
	expect(new Set(ladder).size).toBe(3);
	expect(code("error")).not.toBe(code("accent"));

	const { component, options } = await midFlightBoard();

	options.spinnerFrame = undefined;
	expect(rung(component.render(COLUMNS).join("\n"), "epsilon", ladder)).toBe(2);

	const rungs = walk(component, options, "epsilon", ladder);
	for (const [index, here] of rungs.entries()) {
		const previous = rungs[index - 1];
		if (previous !== undefined) expect(here).toBeGreaterThanOrEqual(previous);
	}
	expect(rungs[0]).toBe(0);
	expect(rungs.at(-1)).toBe(2);

	// And it never borrows the in-flight row's colour on the way there.
	for (let frame = 1; frame <= TODO_BOARD_TOTAL_FRAMES; frame++) {
		options.spinnerFrame = frame;
		const line = component.render(COLUMNS).find(candidate => candidate.includes("epsilon"))!;
		expect(line.slice(0, line.indexOf("epsilon"))).not.toContain(code("accent"));
	}
});

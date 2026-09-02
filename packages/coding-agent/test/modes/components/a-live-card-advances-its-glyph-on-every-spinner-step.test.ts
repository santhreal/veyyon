/**
 * A card that declares it animates paints a different glyph on the next spinner step.
 *
 * WHY THIS SUITE EXISTS. A tool's own terminal renderer used to draw its glyph inside its paint
 * closure, reading `options.spinnerFrame` off the mutable render state at the moment the terminal
 * composed it. So a spinner tick could update that one field and ask for a repaint, and the glyph
 * advanced with no shape rebuilt. A `ToolView` is not a closure over that state: `drawToolView` is
 * HANDED a frame number and returns rows, so the glyph a converted card paints is the frame the card
 * was BUILT with. The tick updated the field, asked for a component-scoped repaint, and the terminal
 * re-composed children that had already resolved their bytes -- every converted card's streaming
 * glyph sat frozen on the frame it was born with, for as long as the tool ran.
 *
 * THE CLASS, NOT THE INCIDENT. The defect is not "the eval card stopped spinning". It is "a glyph
 * step is a shape change for a view-drawn card, and the tick did not rebuild the shape". So the tick
 * rebuilds, and this suite sweeps `toolRenderers` at run time for every entry that declares
 * `animatedPendingPreview` or `animatedPartialResult` -- in either the boolean or the predicate form
 * -- and drives each one through a real `ToolExecutionComponent` at the width the transcript gives
 * it. A tool that starts animating, or an entry whose declaration stops reaching the bytes, turns
 * this red instead of paying for repaints nobody can see.
 *
 * WHAT WAS TRIED AGAINST IT. Three smuggles, each red on all nine moving rows. Reverting the rebuild
 * in the tick, which is the defect itself. Dropping `#spinnerFrame` from `#updateDisplay`'s key, so
 * the tick rebuilds nothing and the first step already sits still. Narrowing that key entry to
 * whether a frame is set at all, which rebuilds once on the first tick and then goes still -- caught
 * by the second step, which is why the sweep takes two. Asserting only that the frame field moved
 * stays green against the whole defect, since the field always moved: the assertion is on the painted
 * bytes.
 *
 * THE RAIL IS PINNED OFF, and that pin is load-bearing rather than tidy. A live card runs a second
 * interval that walks a tone down the rail column, and at truecolor depth that walk moves a row's
 * bytes on its own -- so a card whose glyph sat frozen would still pass a byte comparison, and the
 * still rows below would move on a workstation and sit still on a runner whose 256-colour ramp
 * quantizes two adjacent tones onto one index. `display.transitions: off` disarms that interval, so
 * the only thing left that can move a byte here is the glyph, and the cell below reddens if the pin
 * stops taking.
 *
 * WHAT IT DOES NOT CATCH. It proves a step changes the bytes, not that the glyph is the one the
 * theme names for that frame, which `theme-spinner-frames.test.ts` owns. It says nothing about the
 * rail's own motion, which it switches off and which has its own suite, and nothing about a tool
 * that animates without declaring it, since there is no declaration to sweep.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolExecutionComponent } from "@veyyon/coding-agent/modes/terminal/components/transcript/tool-execution";
import { SPINNER_GLYPH_ADVANCE_MS } from "@veyyon/coding-agent/modes/terminal/components/transcript/tool-execution";
import { transitionsEnabled } from "@veyyon/coding-agent/theme/shimmer";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { toolRenderers } from "@veyyon/coding-agent/tools/renderers";
import type { TUI } from "@veyyon/tui";
import { createToolExecution } from "../../helpers/tool-execution";

/** The columns the transcript gives a card, which is where a shed segment is decided. */
const WIDTH = 80;

/** Which declaration a row of the sweep exercises. */
type Mode = "pending" | "partial";

interface AnimatingEntry {
	animatedPendingPreview?: boolean | ((args: unknown) => boolean);
	animatedPartialResult?: boolean | ((args: unknown) => boolean);
}

/**
 * The call a tool's animating card is driven with, per tool.
 *
 * A predicate declaration only animates for the call it names (`browser` for `run`, `launch` for an
 * op that can sit), so the args are part of the claim rather than filler: the sweep asserts the
 * declaration says yes to them before it asserts anything about bytes.
 */
const CALLS: Record<string, unknown> = {
	browser: { action: "run", name: "main", code: "await tab.goto('https://example.com');" },
	debug: { action: "launch", program: "./build/app", args: ["--flag"] },
	eval: { language: "py", code: "import time\ntime.sleep(10)" },
	launch: { op: "start", name: "web", application: "bun", args: ["run", "dev"] },
	ssh: { host: "build-01", command: "cargo build --release" },
	vibe_send: { name: "worker-1", message: "take the next task" },
	vibe_spawn: { cli: "claude", name: "worker-1", prompt: "port the loader" },
	vibe_wait: { name: "worker-1" },
};

/**
 * The in-flight result a card is handed when its `animatedPartialResult` row is exercised.
 *
 * The details are the shape the card reads while the run is still going, not filler: a card handed
 * text alone has no cell, no daemon and no worker to report, so it draws the text and nothing that
 * a frame could move -- which is a fixture that cannot see the defect rather than a card that does
 * not animate.
 */
const PARTIALS: Record<string, { content: Array<{ type: string; text?: string }>; details?: unknown }> = {
	browser: { content: [{ type: "text", text: "still going" }] },
	debug: { content: [{ type: "text", text: "still going" }] },
	eval: {
		content: [{ type: "text", text: "still going" }],
		details: {
			language: "py",
			cells: [{ index: 0, code: "import time\ntime.sleep(10)", language: "py", output: "", status: "running" }],
		},
	},
	launch: {
		content: [{ type: "text", text: "still going" }],
		details: {
			op: "start",
			daemon: {
				name: "web",
				id: "d1",
				state: "starting",
				createdAt: 0,
				startedAt: 0,
				restartCount: 0,
				outputBytes: 0,
				persist: false,
				detached: false,
				readyPending: ["log"],
			},
		},
	},
	vibe_wait: {
		content: [{ type: "text", text: "still going" }],
		details: {
			op: "wait",
			screens: [],
			wait: { settled: [], stillRunning: ["worker-1"], timedOut: false, waiting: true },
		},
	},
};

let ui: TUI;

beforeAll(async () => {
	await initTheme();
	resetSettingsForTest();
	await Settings.init({ inMemory: true, overrides: { "display.transitions": "off" } });
});

afterAll(() => {
	resetSettingsForTest();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

/** Every registry entry that declares animation, as the (tool, mode) rows it declares. */
function declaredRows(): Array<{ tool: string; mode: Mode }> {
	const rows: Array<{ tool: string; mode: Mode }> = [];
	for (const [tool, renderer] of Object.entries(toolRenderers)) {
		const entry = renderer as AnimatingEntry;
		if (entry.animatedPendingPreview !== undefined) rows.push({ tool, mode: "pending" });
		if (entry.animatedPartialResult !== undefined) rows.push({ tool, mode: "partial" });
	}
	return rows.sort((a, b) => `${a.tool}:${a.mode}`.localeCompare(`${b.tool}:${b.mode}`));
}

/**
 * The rows whose card paints no byte a frame can move, each with the reason it is here.
 *
 * A declaration asks the block for a repaint every 80ms; a card that draws no frame spends those
 * repaints on identical bytes. These two are not this branch's doing -- the renderers they replaced
 * read `options.spinnerFrame` in their CALL render and never in their result -- so the declaration
 * has always bought a still frame there. Pinned by exact equality rather than skipped, so a card
 * that starts drawing its frame turns the negative control below red and the row leaves this list.
 */
const STILL: ReadonlyArray<{ tool: string; mode: Mode; why: string }> = [
	{
		tool: "launch",
		mode: "partial",
		why: "the result row reports the daemon's own state (starting, waiting on log, uptime), so what the operator watches is the state text rather than a glyph",
	},
	{
		tool: "vibe_wait",
		mode: "partial",
		why: "the interim wait row reports which workers are still running, and the mark it carries is the wait's outcome rather than a spinner",
	},
];

function rowKey(row: { tool: string; mode: Mode }): string {
	return `${row.tool}:${row.mode}`;
}

const STILL_KEYS = new Set(STILL.map(rowKey));

/** The declared rows whose bytes a glyph step must move. */
function movingRows(): Array<{ tool: string; mode: Mode }> {
	return declaredRows().filter(row => !STILL_KEYS.has(rowKey(row)));
}

/** Whether the declaration says yes to the call the sweep drives it with. */
function declarationAccepts(tool: string, mode: Mode, args: unknown): boolean {
	const entry = toolRenderers[tool] as AnimatingEntry;
	const declaration = mode === "pending" ? entry.animatedPendingPreview : entry.animatedPartialResult;
	return typeof declaration === "function" ? declaration(args) : declaration === true;
}

function liveCard(tool: string, mode: Mode): ToolExecutionComponent {
	const component = createToolExecution(tool, CALLS[tool], {}, undefined, ui, process.cwd());
	if (mode === "partial") component.updateResult(PARTIALS[tool] as Parameters<typeof component.updateResult>[0], true);
	return component;
}

describe("a card that declares it animates", () => {
	beforeAll(() => {
		ui = { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI;
	});

	/**
	 * The anti-vacuity cell for the rail pin. With the rail's interval armed, its tone walk moves a
	 * row's bytes at truecolor depth and every comparison below passes whether the glyph advanced or
	 * not, so a settings default that stops reaching `transitionsEnabled` has to redden here rather
	 * than quietly turn the sweep into a test of the rail.
	 */
	it("takes every comparison with the rail's own motion disarmed", () => {
		expect(transitionsEnabled()).toBe(false);
	});

	/**
	 * The sweep is derived, so a tool that starts animating arrives here with no call to drive it
	 * with and this cell names it. Pinned by exact equality in both directions: an entry that stops
	 * declaring animation leaves a call behind that nothing exercises, which is the same silence.
	 */
	it("is one of the tools this suite drives, and no others", () => {
		const rows = declaredRows();
		expect([...new Set(rows.map(row => row.tool))].sort()).toEqual(Object.keys(CALLS).sort());
		const partialTools = rows.filter(row => row.mode === "partial").map(row => row.tool);
		expect(partialTools.sort()).toEqual(Object.keys(PARTIALS).sort());
	});

	/**
	 * The rows that buy a repaint and paint the same bytes, pinned exactly. A count would let one
	 * card go still as another started animating, which is the trade this cell exists to refuse.
	 */
	it("declares exactly two rows whose card paints no frame", () => {
		expect(STILL.map(rowKey).sort()).toEqual(["launch:partial", "vibe_wait:partial"]);
		for (const row of STILL) expect(row.why.length).toBeGreaterThan(40);
		const declared = new Set(declaredRows().map(rowKey));
		for (const key of STILL_KEYS) expect(declared.has(key)).toBe(true);
	});

	it.each(movingRows())("paints new bytes on each glyph step (%o)", ({ tool, mode }) => {
		expect(declarationAccepts(tool, mode, CALLS[tool])).toBe(true);

		vi.useFakeTimers();
		const component = liveCard(tool, mode);

		const frames: string[] = [];
		for (let step = 0; step < 3; step++) {
			frames.push(component.render(WIDTH).join("\n"));
			vi.advanceTimersByTime(SPINNER_GLYPH_ADVANCE_MS);
		}

		// Two steps, not one: a rebuild whose key omits the frame repaints the first step (the card is
		// built once on construction and once on the first tick) and then goes still.
		expect(frames[1]).not.toBe(frames[0]);
		expect(frames[2]).not.toBe(frames[1]);
		component.stopAnimation();
	});

	/**
	 * The interval is bounded by the block's life, so a stopped card is silent however long the
	 * process runs. Without this a fix that animated by scheduling more work would pass the sweep
	 * above and leak a repaint per 80ms for every card the transcript ever held.
	 */
	it.each(declaredRows())("stops ticking once stopped (%o)", ({ tool, mode }) => {
		vi.useFakeTimers();
		const component = liveCard(tool, mode);
		component.render(WIDTH);
		vi.advanceTimersByTime(SPINNER_GLYPH_ADVANCE_MS);

		component.stopAnimation();
		const stopped = component.render(WIDTH).join("\n");
		vi.advanceTimersByTime(SPINNER_GLYPH_ADVANCE_MS * 40);
		expect(component.render(WIDTH).join("\n")).toBe(stopped);
	});

	/**
	 * The negative control for the list above: a pinned row that starts moving means the card grew a
	 * frame and the row's reason is now false, so it has to leave the list rather than sit there
	 * describing a card that no longer behaves that way.
	 */
	it.each(STILL)("paints the same bytes across a glyph step, as recorded (%o)", ({ tool, mode }) => {
		vi.useFakeTimers();
		const component = liveCard(tool, mode);
		const first = component.render(WIDTH).join("\n");
		vi.advanceTimersByTime(SPINNER_GLYPH_ADVANCE_MS * 3);
		expect(component.render(WIDTH).join("\n")).toBe(first);
		component.stopAnimation();
	});
});

/**
 * Whichever way a frame is asked for, an unchanged screen is not repainted.
 *
 * WHY THIS SUITE EXISTS:
 * The neighbouring suite proves that three particular situations — an overlay, a frozen scroll
 * slice, an idle request — write nothing when the frame matches the screen. That closes those
 * three and nothing else, and the defect it came from was never about the situation: it was about
 * a caller reaching the renderer through a path where the diff had already been widened away. So
 * the variant that matters is not what the screen holds, it is how the frame was asked for.
 *
 * WHAT THIS SUITE PROVES:
 * Every request kind this renderer exposes is exercised against a screen that already shows the
 * frame it will produce, and each one is held to its own contract: silence, or a repaint it is
 * defined to perform. The kinds that are allowed to repaint are pinned by exact equality, so a
 * new one arriving silently on the permitted side turns this red rather than passing.
 *
 * WHAT IT DOES NOT CATCH:
 * A frame that genuinely differs. Every case here holds the content still and varies only the
 * request, which is the axis the sibling suites do not vary.
 */

import { describe, expect, it } from "bun:test";
import { createFrameRecorder, type FrameEmission, StressRenderScheduler, VirtualTerminal } from "@veyyon/render-oracle";
import { type Component, TUI } from "@veyyon/tui/tui";

class StaticContentComponent implements Component {
	constructor(private readonly lines: readonly string[]) {}

	render(_width: number): readonly string[] {
		return this.lines;
	}
}

const BODY_ROWS = [
	"Row 0: transcript content that stays put",
	"Row 1: second line of persistent text",
	"Row 2: third line of persistent text",
	"Row 3: fourth line of persistent text",
	"Row 4: bottom status area",
];

/** A settled screen already showing the frame every request below will produce again. */
interface SettledScreen {
	term: VirtualTerminal;
	tui: TUI;
	scheduler: StressRenderScheduler;
	body: StaticContentComponent;
	collectFrame: () => FrameEmission;
}

async function settledScreen(): Promise<SettledScreen> {
	const term = new VirtualTerminal(60, 12);
	const scheduler = new StressRenderScheduler();
	const tui = new TUI(term, undefined, { renderScheduler: scheduler });
	const recorder = createFrameRecorder(term);
	const body = new StaticContentComponent(BODY_ROWS);
	tui.addChild(body);
	tui.start();
	await scheduler.drain(term);
	recorder.collectFrame();
	return { term, tui, scheduler, body, collectFrame: recorder.collectFrame };
}

/**
 * One way of asking the renderer for a frame.
 *
 * `repaints` states whether that request is defined to put bytes on the wire even when the frame
 * it produces is the one already there. A forced repaint is: it exists because a caller has
 * decided the screen cannot be trusted. An ordinary request is not.
 */
interface RequestKind {
	name: string;
	repaints: boolean;
	ask: (screen: SettledScreen) => void;
}

const REQUEST_KINDS: readonly RequestKind[] = [
	{ name: "requestRender()", repaints: false, ask: s => s.tui.requestRender() },
	{
		name: "requestRender() twice",
		repaints: false,
		ask: s => {
			s.tui.requestRender();
			s.tui.requestRender();
		},
	},
	{ name: "requestComponentRender(child)", repaints: false, ask: s => s.tui.requestComponentRender(s.body) },
	{
		name: "an input event that changes nothing",
		repaints: false,
		// No component holds focus, so the byte is dropped by the dispatch and the frame it may
		// schedule is the same frame. What is being checked is the schedule, not the key.
		ask: s => s.term.sendInput("\x1b[Z"),
	},
	{ name: "requestRender(true)", repaints: true, ask: s => s.tui.requestRender(true) },
	{
		name: "requestRender(true, { clearScrollback: true })",
		repaints: true,
		ask: s => s.tui.requestRender(true, { clearScrollback: true }),
	},
];

describe("no way of asking for a frame repaints an unchanged screen", () => {
	it("pins which request kinds are allowed to repaint an unchanged screen", () => {
		const allowed = REQUEST_KINDS.filter(kind => kind.repaints).map(kind => kind.name);

		expect(allowed).toEqual(["requestRender(true)", "requestRender(true, { clearScrollback: true })"]);
	});

	for (const kind of REQUEST_KINDS) {
		it(`${kind.repaints ? "repaints on" : "writes no erase or row for"} ${kind.name}`, async () => {
			const screen = await settledScreen();
			const before = screen.term.getViewport();

			kind.ask(screen);
			await screen.scheduler.drain(screen.term);
			const frame = screen.collectFrame();

			expect(screen.term.getViewport()).toEqual(before);
			if (kind.repaints) {
				expect(frame.rowsRewritten).toBeGreaterThan(0);
			} else {
				expect(frame.eraseDisplayCount).toBe(0);
				expect(frame.eraseLineCount).toBe(0);
				expect(frame.rowsRewritten).toBe(0);
			}
		});
	}

	it("stays silent for every ordinary request kind applied one after another", async () => {
		const screen = await settledScreen();
		const before = screen.term.getViewport();

		for (const kind of REQUEST_KINDS.filter(k => !k.repaints)) {
			kind.ask(screen);
			await screen.scheduler.drain(screen.term);
		}
		const frame = screen.collectFrame();

		expect(screen.term.getViewport()).toEqual(before);
		expect(frame.rowsRewritten).toBe(0);
		expect(frame.eraseDisplayCount).toBe(0);
	});

	it("returns to silence after a forced repaint has done its work", async () => {
		const screen = await settledScreen();

		screen.tui.requestRender(true);
		await screen.scheduler.drain(screen.term);
		const forced = screen.collectFrame();
		expect(forced.rowsRewritten).toBeGreaterThan(0);

		screen.tui.requestRender();
		await screen.scheduler.drain(screen.term);
		const after = screen.collectFrame();

		expect(after.rowsRewritten).toBe(0);
		expect(after.eraseDisplayCount).toBe(0);
		expect(after.eraseLineCount).toBe(0);
	});
});

/**
 * WHY THIS SUITE EXISTS.
 *
 * The composer chips ("escape interrupt", "alt+up dequeue") were shipped as
 * click targets: ComposerShortcutsBar implements MouseRoutable and the pinned
 * footer route delivers clicks to it. They were nonetheless dead in a fresh
 * session, and a real recording proved it: a click on "escape interrupt" left
 * the turn running. The terminal was never asked to report buttons. The engine
 * held the mouse for exactly one reason, scroll isolation with a frame taller
 * than the viewport, so a short session reported nothing and every footer
 * target in it was inert text.
 *
 * The class this closes is wider than the chips: ANY pinned-footer component
 * that owns a click target, present or future, is unreachable whenever the
 * frame happens to fit. So the assertions sit at the choke point that decides
 * the grab -- TUI#syncWheelTracking -- rather than on one component. A new
 * footer component with targets needs no new test here; it needs to answer
 * MouseRoutable.wantsPointer(), and the boundary does the rest.
 *
 * What it does NOT catch: whether a given host component answers wantsPointer()
 * at the right times. That is the component's own contract (the chip bar's is
 * pinned in packages/coding-agent/test/a-clicked-composer-chip-runs-its-action.test.ts).
 * It also says nothing about the alternate screen, where overlays own the full
 * tracking set including any-motion hover.
 */
import { describe, expect, it } from "bun:test";
import { type Component, CURSOR_MARKER, type Focusable, TUI } from "@veyyon/tui";
import type { MouseRoutable, SgrMouseEvent } from "@veyyon/tui/mouse";
import { StressRenderScheduler } from "./render-stress-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

const WIDTH = 40;
const HEIGHT = 12;

/** Button reporting: the byte that takes the mouse from the terminal. */
const TRACKING_BUTTONS_ON = "\x1b[?1000h";
/** SGR coordinates, written with it. */
const TRACKING_SGR_ON = "\x1b[?1006h";
/** Any-motion. Never wanted on the normal screen: it floods input with moves. */
const TRACKING_MOTION_ON = "\x1b[?1003h";
/** The teardown pair. */
const TRACKING_OFF = "\x1b[?1006l\x1b[?1000l";

class RecordingTerminal extends VirtualTerminal {
	written: string[] = [];
	override write(data: string): void {
		this.written.push(data);
		super.write(data);
	}
	output(): string {
		return this.written.join("");
	}
	/** Bytes written since the caller last cleared the log. */
	drainOutput(): string {
		const out = this.output();
		this.written = [];
		return out;
	}
}

/** Transcript body, short enough that the frame never overflows. */
class Body implements Component {
	rows: string[] = ["turn-1", "turn-2"];
	invalidate(): void {}
	render(): readonly string[] {
		return this.rows;
	}
}

/** Stand-in for the composer input card. */
class Composer implements Component, Focusable {
	focused = true;
	invalidate(): void {}
	setUseTerminalCursor(): void {}
	handleInput(): void {}
	render(): readonly string[] {
		return [`>${CURSOR_MARKER}`];
	}
}

/**
 * Stand-in for the chip bar: one row, click targets that come and go, and the
 * same shape of answer the real bar gives (targets exist -> wants the pointer).
 */
class ChipBar implements Component, MouseRoutable {
	chips = true;
	clicks: Array<{ line: number; col: number }> = [];
	invalidate(): void {}
	render(): readonly string[] {
		return [this.chips ? "  escape interrupt" : ""];
	}
	wantsPointer(): boolean {
		return this.chips;
	}
	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		if (!event.leftClick) return;
		this.clicks.push({ line, col });
	}
}

/** A footer child with a route but nothing on screen to click. */
class InertFooter implements Component, MouseRoutable {
	clicks = 0;
	invalidate(): void {}
	render(): readonly string[] {
		return [""];
	}
	wantsPointer(): boolean {
		return false;
	}
	routeMouse(): void {
		this.clicks++;
	}
}

interface Rig {
	term: RecordingTerminal;
	tui: TUI;
	scheduler: StressRenderScheduler;
	body: Body;
	stop: () => void;
}

async function rig(
	footer: Component[],
	options: {
		isolation?: boolean;
		transport?: "mouse" | "alt-arrows";
		/** Children ABOVE the pinned footer, in the transcript region. */
		above?: Component[];
	} = {},
): Promise<Rig> {
	const term = new RecordingTerminal(WIDTH, HEIGHT, 5_000);
	const scheduler = new StressRenderScheduler();
	const tui = new TUI(term, true, { renderScheduler: scheduler });
	const body = new Body();
	const composer = new Composer();
	for (const child of options.above ?? []) tui.addChild(child);
	tui.addChild(body);
	for (const child of footer) tui.addChild(child);
	tui.addChild(composer);
	tui.setFocus(composer);
	tui.setPinnedFooterChildCount(footer.length + 1);
	tui.setScrollbackRebuild(false); // env-derived default, stated
	tui.setScrollTransport(options.transport ?? "mouse"); // env-derived default, stated
	tui.setScrollIsolation(options.isolation ?? true);
	tui.start();
	await scheduler.drain(term);
	return { term, tui, scheduler, body, stop: () => tui.stop() };
}

/** SGR left-button press at 0-based screen (row, col). */
function leftClickAt(row: number, col: number): string {
	return `\x1b[<0;${col + 1};${row + 1}M`;
}

describe("a footer click target holds the mouse in a session that never scrolls", () => {
	it("grabs button reporting for a declared target with nothing scrolled off", async () => {
		const bar = new ChipBar();
		const { term, tui, stop } = await rig([bar]);
		try {
			// The precondition that used to be the ONLY reason for the grab: the
			// frame fits, so there is nothing to scroll and no isolation need.
			expect(tui.scrollTapeRows).toBe(0);
			const output = term.output();
			expect(output).toContain(`${TRACKING_BUTTONS_ON}${TRACKING_SGR_ON}`);
			// Any-motion stays with the terminal; the chips take clicks, not hover.
			expect(output).not.toContain(TRACKING_MOTION_ON);
		} finally {
			stop();
		}
	});

	it("delivers the click that the grab makes possible", async () => {
		const bar = new ChipBar();
		const { term, stop } = await rig([bar]);
		try {
			// Footer is the last two frame rows: chip bar then composer. The chip
			// row is therefore the second-to-last screen row, and the click must
			// arrive as line 0 of the bar.
			term.sendInput(leftClickAt(HEIGHT - 2, 4));
			expect(bar.clicks).toEqual([{ line: 0, col: 4 }]);
		} finally {
			stop();
		}
	});

	it("takes nothing from the terminal while no target is on screen", async () => {
		// The differential. "No tracking bytes" is also what a broken build
		// produces, so the previous cases only mean something beside this one:
		// same frame, same footer route, targets withheld.
		const inert = new InertFooter();
		const { term, stop } = await rig([inert]);
		try {
			const output = term.output();
			expect(output).not.toContain(TRACKING_BUTTONS_ON);
			expect(output).not.toContain(TRACKING_SGR_ON);
		} finally {
			stop();
		}
	});

	it("ignores a declared target that is not in the pinned footer", async () => {
		// The footer route is the only path that reaches a component with a
		// click; a transcript child asking for the pointer would buy the grab
		// and deliver nothing, so the ledger scan stops at the footer boundary.
		const stray = new ChipBar();
		const { term, stop } = await rig([new InertFooter()], { above: [stray] });
		try {
			expect(term.output()).not.toContain(TRACKING_BUTTONS_ON);
		} finally {
			stop();
		}
	});

	it("hands the mouse back when the targets clear", async () => {
		const bar = new ChipBar();
		const { term, tui, scheduler, stop } = await rig([bar]);
		try {
			expect(term.drainOutput()).toContain(TRACKING_BUTTONS_ON);
			// The turn ends: the bar renders blank and declares no target.
			bar.chips = false;
			tui.requestComponentRender(bar);
			await scheduler.drain(term);
			const after = term.drainOutput();
			expect(after).toContain(TRACKING_OFF);
			expect(after).not.toContain(TRACKING_BUTTONS_ON);
			// And the grab really is gone: a click on the row is not routed.
			term.sendInput(leftClickAt(HEIGHT - 2, 4));
			expect(bar.clicks).toEqual([]);
		} finally {
			stop();
		}
	});

	it("keeps the grab while the frame is scrollable even after the targets clear", async () => {
		// The two reasons are independent. A long session holds the mouse for
		// isolation, and the chips coming and going must not drop it mid-scroll.
		const bar = new ChipBar();
		const { term, tui, scheduler, body, stop } = await rig([bar]);
		try {
			body.rows = Array.from({ length: HEIGHT + 20 }, (_, i) => `h${i}`);
			tui.requestRender();
			await scheduler.drain(term);
			expect(tui.scrollTapeRows).toBeGreaterThan(0);
			term.drainOutput();

			bar.chips = false;
			tui.requestComponentRender(bar);
			await scheduler.drain(term);
			expect(term.drainOutput()).not.toContain(TRACKING_OFF);
		} finally {
			stop();
		}
	});

	it("never takes the mouse on the alt-arrows transport, target or not", async () => {
		// That transport exists to leave drag-select alone; a click target is not
		// a reason to overrule the operator's choice.
		const bar = new ChipBar();
		const { term, stop } = await rig([bar], { transport: "alt-arrows" });
		try {
			expect(term.output()).not.toContain(TRACKING_BUTTONS_ON);
		} finally {
			stop();
		}
	});

	it("never takes the mouse with scroll isolation off, target or not", async () => {
		const bar = new ChipBar();
		const { term, stop } = await rig([bar], { isolation: false });
		try {
			expect(term.output()).not.toContain(TRACKING_BUTTONS_ON);
		} finally {
			stop();
		}
	});

	it("releases the grab on stop", async () => {
		const bar = new ChipBar();
		const { term, tui } = await rig([bar]);
		term.drainOutput();
		tui.stop();
		expect(term.drainOutput()).toContain(TRACKING_OFF);
	});
});

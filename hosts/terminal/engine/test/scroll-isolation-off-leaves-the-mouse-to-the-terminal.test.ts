import { describe, expect, it } from "bun:test";
import { type Component, CURSOR_MARKER, type Focusable, TUI } from "@veyyon/tui";
import { StressRenderScheduler } from "./render-stress-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

/**
 * Who owns the mouse when scroll isolation is off.
 *
 * Scroll isolation scrolls the transcript with the prompt pinned, and the only
 * way to read a wheel tick is to turn on mouse tracking, which takes the mouse
 * away from the terminal: plain drag-to-select stops working, and an operator
 * concludes copy is broken ("i cant copy and paste from the terminal",
 * 2026-07-24). So the setting is a genuine trade, and OFF has to mean the
 * terminal keeps the mouse completely.
 *
 * "Completely" is the part worth pinning. A default that merely stops veyyon
 * from ACTING on wheel reports while still enabling tracking would look correct
 * in every behavioural test and still break selection, because the damage is
 * done by the enable sequence itself, not by what we do with the reports. The
 * only assertion that can tell those two apart is on the bytes.
 *
 * These cases are a differential: identical content, identical scroll depth,
 * the setting the only difference. Off writes no tracking enable; on does. A
 * single-state test would prove nothing, since "no tracking bytes" is also what
 * a TUI that never scrolled would produce.
 *
 * Nothing asserted mouse-tracking bytes anywhere before this suite, which is
 * how the shipped default drifted to ON while the docs, the settings reference,
 * the internal renderer notes and the changelog all said OFF.
 */

const WIDTH = 30;
const HEIGHT = 8;

/** The wheel-tracking enable pair the engine writes to read scroll events. */
const TRACKING_ENABLE_BUTTONS = "\x1b[?1000h";
const TRACKING_ENABLE_SGR = "\x1b[?1006h";

/** Records every byte the engine writes, then feeds the real VT engine. */
class RecordingTerminal extends VirtualTerminal {
	written: string[] = [];
	override write(data: string): void {
		this.written.push(data);
		super.write(data);
	}
	/** Everything the engine has emitted this run, as one string. */
	output(): string {
		return this.written.join("");
	}
}

class Body implements Component {
	rows: string[] = [];
	invalidate(): void {}
	render(): readonly string[] {
		return this.rows;
	}
}

class Composer implements Component, Focusable {
	focused = false;
	invalidate(): void {}
	setUseTerminalCursor(): void {}
	handleInput(): void {}
	render(): readonly string[] {
		return [`>${CURSOR_MARKER}`];
	}
}

interface Rig {
	term: RecordingTerminal;
	tui: TUI;
	scheduler: StressRenderScheduler;
}

/**
 * A session with far more history than fits, which is what arms the capture
 * gate. Anything less and the engine would decline tracking for lack of
 * anything above the window, and the "off" case would pass for the wrong
 * reason.
 */
async function rig(isolation: boolean): Promise<Rig> {
	const term = new RecordingTerminal(WIDTH, HEIGHT, 5_000);
	const scheduler = new StressRenderScheduler();
	const tui = new TUI(term, true, { renderScheduler: scheduler });
	const body = new Body();
	const composer = new Composer();
	body.rows = Array.from({ length: 40 }, (_, i) => `h${i}`);
	tui.addChild(body);
	tui.addChild(composer);
	tui.setFocus(composer);
	tui.setScrollIsolation(isolation);
	tui.setPinnedFooterChildCount(1);
	tui.setScrollbackRebuild(false); // env-derived default, stated
	tui.start();
	await scheduler.drain(term);
	return { term, tui, scheduler };
}

describe("scroll isolation off leaves the mouse to the terminal", () => {
	it("never enables mouse tracking, however much has scrolled off", async () => {
		// The operator's contract: a default install behaves like every other
		// terminal program. If either enable sequence appears, their drag-select is
		// gone no matter what the engine does with the reports afterwards.
		const { term, tui, scheduler } = await rig(false);
		try {
			expect(tui.scrollIsolation).toBe(false);
			await scheduler.drain(term);
			const output = term.output();
			expect(output).not.toContain(TRACKING_ENABLE_BUTTONS);
			expect(output).not.toContain(TRACKING_ENABLE_SGR);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("enables tracking when it is on, so the off case is a real difference", async () => {
		// The negative control lives in the suite. Same content, same depth, only
		// the setting differs -- without this, "no tracking bytes" could just mean
		// the rig never scrolled and the case above would be vacuous.
		const { term, tui, scheduler } = await rig(true);
		try {
			expect(tui.scrollIsolation).toBe(true);
			await scheduler.drain(term);
			const output = term.output();
			expect(output).toContain(TRACKING_ENABLE_BUTTONS);
			expect(output).toContain(TRACKING_ENABLE_SGR);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("does not grab the mouse when switched off mid-session", async () => {
		// Turning the setting off in /settings has to hand the mouse back on the
		// spot. An operator who hits the copy problem and goes looking for the fix
		// finds this setting; if it only took effect on the next launch, the fix
		// would appear not to work and they would conclude copy is simply broken.
		const { term, tui, scheduler } = await rig(true);
		try {
			await scheduler.drain(term);
			term.written = [];
			tui.setScrollIsolation(false);
			await scheduler.drain(term);
			const output = term.output();
			expect(output).not.toContain(TRACKING_ENABLE_BUTTONS);
			expect(output).not.toContain(TRACKING_ENABLE_SGR);
		} finally {
			tui.stop();
			await term.flush();
		}
	});
});

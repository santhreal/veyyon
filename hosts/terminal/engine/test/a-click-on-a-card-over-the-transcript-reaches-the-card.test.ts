/**
 * WHY THIS SUITE EXISTS.
 *
 * A card shown with `showOverlay` and no `fullscreen` draws over the normal
 * screen, where every SGR report was owned by scroll isolation: the wheel
 * scrolled the transcript under the card and a click was swallowed, so a
 * console drawn above the composer took keys and nothing else. The defect
 * class is "an interactive surface that paints on the normal screen and never
 * hears the mouse". The engine now records where each overlay landed and hands
 * a report inside the topmost interactive card to its `routeMouse`, in the
 * card's own cells, and holds the button grab for as long as such a card is up.
 *
 * What it does not catch: a component that records the wrong geometry for its
 * own rows (that is each component's suite), and an overlay that overflows and
 * is clipped at the top, which is pinned by `lineOffset` in one case only.
 */
import { describe, expect, it } from "bun:test";
import type { MouseRoutable, SgrMouseEvent } from "@veyyon/utils/mouse";
import { type Component, type Focusable, TUI } from "../src";
import { StressRenderScheduler } from "./render-stress-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

const WIDTH = 40;
const HEIGHT = 12;

const TRACKING_BUTTONS_ON = "\x1b[?1000h";
const TRACKING_MOTION_ON = "\x1b[?1003h";

class RecordingTerminal extends VirtualTerminal {
	written: string[] = [];
	override write(data: string): void {
		this.written.push(data);
		super.write(data);
	}
	output(): string {
		return this.written.join("");
	}
}

/** Transcript body: `rows` lines, so the frame can be made to fit or overflow. */
class Body implements Component {
	constructor(readonly rows: number) {}
	invalidate(): void {}
	render(): readonly string[] {
		return Array.from({ length: this.rows }, (_, i) => `transcript ${i}`);
	}
}

class Composer implements Component, Focusable {
	focused = false;
	keys: string[] = [];
	invalidate(): void {}
	render(): readonly string[] {
		return ["> "];
	}
	handleInput(data: string): void {
		this.keys.push(data);
	}
}

interface Routed {
	line: number;
	col: number;
	wheel: -1 | 1 | null;
	leftClick: boolean;
}

/** A three-row card that records every report it is handed. */
class Card implements Component, MouseRoutable {
	routed: Routed[] = [];
	pointer = true;
	keys: string[] = [];
	invalidate(): void {}
	render(): readonly string[] {
		return ["┌ card ┐", "│ row  │", "└──────┘"];
	}
	handleInput(data: string): void {
		this.keys.push(data);
	}
	wantsPointer(): boolean {
		return this.pointer;
	}
	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		this.routed.push({ line, col, wheel: event.wheel, leftClick: event.leftClick });
	}
}

/** The same card with no route at all: the control arm. */
class DeafCard implements Component {
	keys: string[] = [];
	invalidate(): void {}
	render(): readonly string[] {
		return ["┌ card ┐", "│ row  │", "└──────┘"];
	}
	handleInput(data: string): void {
		this.keys.push(data);
	}
}

async function rig(bodyRows: number) {
	const term = new RecordingTerminal(WIDTH, HEIGHT, 5_000);
	const scheduler = new StressRenderScheduler();
	const tui = new TUI(term, true, { renderScheduler: scheduler });
	const composer = new Composer();
	tui.addChild(new Body(bodyRows));
	tui.addChild(composer);
	tui.setFocus(composer);
	tui.setPinnedFooterChildCount(1);
	tui.setScrollbackRebuild(false);
	tui.setScrollTransport("mouse");
	tui.setScrollIsolation(true);
	tui.start();
	await scheduler.drain(term);
	return { term, tui, scheduler, composer, stop: () => tui.stop() };
}

/** Screen row (0-based) of the card's top border, read from the painted viewport. */
function cardTop(term: VirtualTerminal): number {
	const row = term.getViewport().findIndex(line => line.includes("┌ card ┐"));
	expect(row).toBeGreaterThanOrEqual(0);
	return row;
}

function leftClickAt(row: number, col: number): string {
	return `\x1b[<0;${col + 1};${row + 1}M`;
}

function wheelAt(row: number, col: number, direction: -1 | 1): string {
	return `\x1b[<${direction === -1 ? 64 : 65};${col + 1};${row + 1}M`;
}

const INLINE = { anchor: "bottom-center", width: "100%", maxHeight: "100%", margin: 0, aboveFooter: true } as const;
/** Transcript rows that make the frame exactly the viewport: nothing to scroll, room for the card. */
const FITS = HEIGHT - 1;

describe("a click on a card over the transcript reaches the card", () => {
	it("grabs button reporting for a routable card in a session that never scrolls", async () => {
		const { term, tui, scheduler, stop } = await rig(FITS);
		try {
			expect(term.output()).not.toContain(TRACKING_BUTTONS_ON);
			const card = new Card();
			tui.showOverlay(card, INLINE);
			await scheduler.drain(term);
			const output = term.output();
			expect(output).toContain(TRACKING_BUTTONS_ON);
			// Any-motion stays with the terminal on the normal screen.
			expect(output).not.toContain(TRACKING_MOTION_ON);
		} finally {
			stop();
		}
	});

	it("hands a click and a wheel inside the card to routeMouse in the card's cells", async () => {
		const { term, tui, scheduler, stop } = await rig(FITS);
		try {
			const card = new Card();
			tui.showOverlay(card, INLINE);
			await scheduler.drain(term);
			const top = cardTop(term);
			// The card is full width, so its column 0 is the screen's.
			term.sendInput(leftClickAt(top + 1, 2));
			term.sendInput(wheelAt(top + 1, 3, 1));
			expect(card.routed).toEqual([
				{ line: 1, col: 2, wheel: null, leftClick: true },
				{ line: 1, col: 3, wheel: 1, leftClick: false },
			]);
			// The bytes never reach handleInput as keys.
			expect(card.keys).toEqual([]);
		} finally {
			stop();
		}
	});

	it("hands a wheel beside the card to the engine, not to the card or the focused component", async () => {
		// Enough transcript to scroll. An overlay keeps the window on the live
		// tail (the engine resumes it on every frame a card is up), so the wheel
		// cannot be seen to move the view; what is observable is who did not
		// hear it: the card, and the composer that would otherwise get raw SGR.
		const { term, tui, scheduler, composer, stop } = await rig(HEIGHT + 6);
		try {
			const card = new Card();
			tui.showOverlay(card, INLINE);
			await scheduler.drain(term);
			const top = cardTop(term);
			expect(top).toBeGreaterThan(0);
			term.sendInput(wheelAt(0, 0, -1));
			await scheduler.drain(term);
			expect(card.routed).toEqual([]);
			expect(composer.keys).toEqual([]);
			expect(tui.virtualScrollActive).toBe(false);
		} finally {
			stop();
		}
	});

	it("takes no grab for a card that declines the pointer, and none for one with no route", async () => {
		const { term, tui, scheduler, stop } = await rig(FITS);
		try {
			const deaf = new DeafCard();
			const handle = tui.showOverlay(deaf, INLINE);
			await scheduler.drain(term);
			expect(term.output()).not.toContain(TRACKING_BUTTONS_ON);
			handle.hide();
			await scheduler.drain(term);
			const card = new Card();
			card.pointer = false;
			tui.showOverlay(card, INLINE);
			await scheduler.drain(term);
			expect(term.output()).not.toContain(TRACKING_BUTTONS_ON);
		} finally {
			stop();
		}
	});

	it("counts the rows a clipped card lost off its top", async () => {
		// Two transcript rows leave the card two rows above the composer, so its
		// top border is cut: the first painted row is the card's line 1.
		const { term, tui, scheduler, stop } = await rig(2);
		try {
			const card = new Card();
			tui.showOverlay(card, INLINE);
			await scheduler.drain(term);
			const row = term.getViewport().findIndex(line => line.includes("│ row  │"));
			expect(row).toBe(0);
			term.sendInput(leftClickAt(0, 2));
			expect(card.routed).toEqual([{ line: 1, col: 2, wheel: null, leftClick: true }]);
		} finally {
			stop();
		}
	});

	it("stops routing once the card is gone", async () => {
		const { term, tui, scheduler, stop } = await rig(FITS);
		try {
			const card = new Card();
			const handle = tui.showOverlay(card, INLINE);
			await scheduler.drain(term);
			const top = cardTop(term);
			handle.hide();
			await scheduler.drain(term);
			term.sendInput(leftClickAt(top + 1, 2));
			expect(card.routed).toEqual([]);
		} finally {
			stop();
		}
	});
});

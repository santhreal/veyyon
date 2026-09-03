/**
 * WHY THIS SUITE EXISTS.
 *
 * A bottom-anchored, full-height overlay (the interactive console, the
 * autoresearch dashboard) painted over the whole window, so while a PTY
 * command ran the prompt, the status line and the footline were gone. The
 * `aboveFooter` overlay option reserves the screen rows from the pinned
 * footer's top down, and the layout resolver treats that reserve as bottom
 * margin: the overlay sits on the transcript region and the composer zone
 * under it stays painted.
 *
 * Covered: the footer rows are untouched with the option on; the overlay's
 * last row sits directly above the footer; a 100% overlay is clamped to the
 * rows above the footer; a footer that sits mid-screen (frame shorter than
 * the viewport) is still respected; the reserve tracks a footer that grows
 * between frames; an explicit bottom margin adds to the reserve; and a TUI
 * with no pinned footer is unchanged. The option OFF arm pins the pre-change
 * behavior so a resolver that reserved the footer unconditionally fails too.
 *
 * Not covered: how the host sizes the component it shows (the console reads
 * `tui.pinnedFooterRows` for that), and mouse routing into a footer under an
 * overlay.
 */
import { describe, expect, it } from "bun:test";
import { type Component, CURSOR_MARKER, type Focusable, TUI } from "@veyyon/tui";
import { settleFrames } from "./helpers/settle-frames";
import { VirtualTerminal } from "./virtual-terminal";

const WIDTH = 40;
const HEIGHT = 16;

class Lines implements Component {
	rows: string[];
	constructor(prefix: string, count: number) {
		this.rows = Array.from({ length: count }, (_v, i) => `${prefix}${i}`);
	}
	invalidate(): void {}
	render(): readonly string[] {
		return this.rows;
	}
}

class Composer implements Component, Focusable {
	focused = true;
	invalidate(): void {}
	setUseTerminalCursor(): void {}
	handleInput(): void {}
	render(): readonly string[] {
		return [`>${CURSOR_MARKER}`];
	}
}

interface Rig {
	term: VirtualTerminal;
	tui: TUI;
	footer: Lines;
	stop: () => void;
}

async function rig(options: { footerRows: number; pinned: boolean; bodyRows?: number; height?: number }): Promise<Rig> {
	const term = new VirtualTerminal(WIDTH, options.height ?? HEIGHT, 1_000);
	const tui = new TUI(term, true);
	const footer = new Lines("footer-", options.footerRows);
	const composer = new Composer();
	// A transcript taller than the screen by default, so the frame overflows
	// and the pinned footer lands on the last screen rows the way a session does.
	tui.addChild(new Lines("body-", options.bodyRows ?? 30));
	tui.addChild(footer);
	tui.addChild(composer);
	tui.setFocus(composer);
	if (options.pinned) tui.setPinnedFooterChildCount(2);
	tui.setScrollbackRebuild(false);
	tui.start();
	await settleFrames(term, tui);
	return { term, tui, footer, stop: () => tui.stop() };
}

/** Screen row index of the first row whose text starts with `prefix`, or -1. */
function firstRowStartingWith(term: VirtualTerminal, prefix: string): number {
	return term.getViewport().findIndex(line => line.trimStart().startsWith(prefix));
}

/** Screen row index of the last row whose text starts with `prefix`, or -1. */
function lastRowStartingWith(term: VirtualTerminal, prefix: string): number {
	return term.getViewport().findLastIndex(line => line.trimStart().startsWith(prefix));
}

const FULL_BOTTOM_OVERLAY = { anchor: "bottom-center", width: "100%", maxHeight: "100%", margin: 0 } as const;

describe("an overlay above the footer leaves the composer painted", () => {
	it("keeps every pinned footer row on screen under a bottom-anchored 100% overlay", async () => {
		const { term, tui, stop } = await rig({ footerRows: 3, pinned: true });
		try {
			tui.showOverlay(new Lines("ov-", 40), { ...FULL_BOTTOM_OVERLAY, aboveFooter: true });
			await settleFrames(term, tui);

			const viewport = term.getViewport().map(line => line.trimEnd());
			// The footer (3 rows + the composer) occupies the last 4 screen rows.
			expect(viewport.slice(HEIGHT - 4)).toEqual(["footer-0", "footer-1", "footer-2", ">"]);
			// The overlay fills every row above it: bottom-anchored, so the tail
			// of the overlay is what shows, ending directly above the footer.
			expect(firstRowStartingWith(term, "ov-")).toBe(0);
			expect(lastRowStartingWith(term, "ov-")).toBe(HEIGHT - 5);
			expect(viewport[HEIGHT - 5]).toBe("ov-39");
			expect(tui.pinnedFooterRows).toBe(4);
		} finally {
			stop();
		}
	});

	it("paints over the footer when the option is off", async () => {
		const { term, tui, stop } = await rig({ footerRows: 3, pinned: true });
		try {
			tui.showOverlay(new Lines("ov-", 40), FULL_BOTTOM_OVERLAY);
			await settleFrames(term, tui);

			expect(term.getViewport()[HEIGHT - 1]?.trimEnd()).toBe("ov-39");
			expect(firstRowStartingWith(term, "footer-")).toBe(-1);
		} finally {
			stop();
		}
	});

	it("ends above a footer that sits mid-screen on a frame shorter than the viewport", async () => {
		const { term, tui, stop } = await rig({ footerRows: 2, pinned: true, bodyRows: 6 });
		try {
			tui.showOverlay(new Lines("ov-", 40), { ...FULL_BOTTOM_OVERLAY, aboveFooter: true });
			await settleFrames(term, tui);

			// Frame = 6 body + 2 footer + composer = 9 rows; the footer starts at
			// screen row 6, so the overlay is confined to rows 0-5 and, being
			// bottom-anchored, shows its last six rows there.
			expect(term.getViewport().slice(0, 9).map(line => line.trimEnd())).toEqual([
				"ov-34",
				"ov-35",
				"ov-36",
				"ov-37",
				"ov-38",
				"ov-39",
				"footer-0",
				"footer-1",
				">",
			]);
		} finally {
			stop();
		}
	});

	it("adds the reserve to an explicit bottom margin instead of replacing it", async () => {
		const { term, tui, stop } = await rig({ footerRows: 2, pinned: true });
		try {
			tui.showOverlay(new Lines("ov-", 40), { ...FULL_BOTTOM_OVERLAY, margin: { bottom: 2 }, aboveFooter: true });
			await settleFrames(term, tui);

			// footer = 2 rows + composer = 3, plus 2 rows of margin: the overlay
			// ends 5 rows above the bottom edge.
			expect(lastRowStartingWith(term, "ov-")).toBe(HEIGHT - 6);
			expect(term.getViewport()[HEIGHT - 1]?.trimEnd()).toBe(">");
		} finally {
			stop();
		}
	});

	it("tracks a footer that grows between frames", async () => {
		const { term, tui, footer, stop } = await rig({ footerRows: 1, pinned: true });
		try {
			tui.showOverlay(new Lines("ov-", 40), { ...FULL_BOTTOM_OVERLAY, aboveFooter: true });
			await settleFrames(term, tui);
			expect(lastRowStartingWith(term, "ov-")).toBe(HEIGHT - 3);

			footer.rows = ["footer-0", "footer-1", "footer-2", "footer-3"];
			tui.requestRender();
			await settleFrames(term, tui);

			expect(tui.pinnedFooterRows).toBe(5);
			expect(lastRowStartingWith(term, "ov-")).toBe(HEIGHT - 6);
			expect(firstRowStartingWith(term, "footer-")).toBe(HEIGHT - 5);
		} finally {
			stop();
		}
	});

	it("is a no-op without a pinned footer", async () => {
		const { term, tui, stop } = await rig({ footerRows: 3, pinned: false });
		try {
			tui.showOverlay(new Lines("ov-", 40), { ...FULL_BOTTOM_OVERLAY, aboveFooter: true });
			await settleFrames(term, tui);

			expect(tui.pinnedFooterRows).toBe(0);
			expect(term.getViewport()[HEIGHT - 1]?.trimEnd()).toBe("ov-39");
		} finally {
			stop();
		}
	});

	it("never reserves the whole screen: one row stays for the overlay", async () => {
		const { term, tui, stop } = await rig({ footerRows: 10, pinned: true, bodyRows: 0, height: 4 });
		try {
			tui.showOverlay(new Lines("ov-", 6), { ...FULL_BOTTOM_OVERLAY, aboveFooter: true });
			await settleFrames(term, tui);

			// Footer span (11) exceeds the 4-row screen: the reserve is clamped to
			// rows - 1 so the overlay still paints one row, at the top.
			expect(term.getViewport()[0]?.trimEnd()).toBe("ov-5");
		} finally {
			stop();
		}
	});
});

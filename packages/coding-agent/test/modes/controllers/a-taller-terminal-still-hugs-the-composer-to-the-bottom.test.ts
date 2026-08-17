/**
 * A terminal that grows leaves the composer on the bottom row.
 *
 * WHY THIS SUITE EXISTS. `HomeAnchorLayout.sync` sizes the fills from
 * `ui.composedFrameRows`, which is the PREVIOUS frame's height. On the frame a
 * resize lands, that number belongs to the old viewport: measured against a
 * window that just grew from 30 rows to 48, it under-reports the slack by the 18
 * rows the terminal gained, and the composer is left stranded mid-screen with
 * blank rows under it. That is the same defect as the blank band above the
 * conversation, wearing the opposite sign, and it is the sign no deterministic
 * paint-sim arm can reach: the resize path defers its authoritative replay past a
 * real 120ms settle window, and that family's charter forbids wall-clock sleeps.
 * So it is pinned here, where a sleep is the idiom.
 *
 * THE CLASS. Not "48 rows": any growth of the window while the conversation is
 * young enough that the fill is what puts the composer on the bottom edge. Both
 * transcript kinds are swept, because the anchor reads the frame and a
 * virtualized transcript reports a different frame than a plain container.
 *
 * WHAT IT DOES NOT CATCH. A shrink (the window getting smaller) is the blank-band
 * suite's question, and a session long enough to have scrolled has no slack to
 * route at all — this suite deliberately stays young, which is the only state
 * where a fill row is the feature rather than a defect.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { TranscriptContainer } from "@veyyon/coding-agent/modes/components/transcript-container";
import { HomeAnchorLayout } from "@veyyon/coding-agent/modes/controllers/home-anchor-layout";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { type Component, Container, CURSOR_MARKER, type Focusable, TUI } from "@veyyon/tui";
import { settleFrames } from "../../../../tui/test/helpers/settle-frames";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal";

class Block implements Component {
	constructor(private readonly lines: readonly string[]) {}
	invalidate(): void {}
	render(): string[] {
		return [...this.lines];
	}
}

class Composer implements Component, Focusable {
	focused = true;
	invalidate(): void {}
	setUseTerminalCursor(): void {}
	handleInput(): void {}
	render(): string[] {
		return [`> ask anything${CURSOR_MARKER}`];
	}
}

/**
 * The resize path re-measures behind a 120ms real-time settle, so the frames have
 * to be drained AFTER that window rather than on the next tick.
 */
async function settleResize(term: VirtualTerminal, tui: TUI): Promise<void> {
	await Bun.sleep(160);
	await settleFrames(term, tui);
}

function lastPaintedRow(term: VirtualTerminal): number {
	return term
		.getViewport()
		.map(row => Bun.stripANSI(row).trimEnd())
		.reduce((last, row, i) => (row.trim().length > 0 ? i : last), -1);
}

describe("a taller terminal still hugs the composer to the bottom", () => {
	beforeAll(async () => {
		await initTheme(false, "unicode", false, "titanium", "dark");
	});

	for (const kind of ["plain", "virtualized"] as const) {
		for (const [from, to] of [
			[30, 48],
			[24, 60],
		] as const) {
			test(`${kind} transcript, ${from} rows grown to ${to}`, async () => {
				const term = new VirtualTerminal(80, from, 5_000);
				const tui = new TUI(term, true);
				const transcript = kind === "plain" ? new Container() : new TranscriptContainer();
				const layout = new HomeAnchorLayout({
					ui: tui,
					transcriptChildCount: () => transcript.children.length,
					hasHero: () => false,
				});
				tui.addChild(layout.topFill);
				tui.addChild(transcript);
				tui.addChild(layout.bottomFill);
				tui.addChild(new Composer());
				tui.setPinnedFooterChildCount(1);
				tui.onFrameComposed = () => layout.onFrameComposed();
				tui.start();
				transcript.addChild(new Block(["> hello", "", "  hi back", ""]));
				tui.requestRender();
				await settleFrames(term, tui);

				// Before the resize the fill is already doing its job, or the arm
				// would prove nothing about what the resize preserved.
				expect({ where: "before", last: lastPaintedRow(term), bottom: from - 1 }).toEqual({
					where: "before",
					last: from - 1,
					bottom: from - 1,
				});

				term.resize(80, to);
				await settleResize(term, tui);

				const viewport = term.getViewport();
				expect({ where: "after", rows: viewport.length, last: lastPaintedRow(term), bottom: to - 1 }).toEqual({
					where: "after",
					rows: to,
					last: to - 1,
					bottom: to - 1,
				});
				// And the row it lands on is the composer, not the tail of a
				// transcript that grew into the space.
				expect(Bun.stripANSI(viewport[to - 1] ?? "")).toContain("> ask anything");

				tui.stop();
				await term.flush();
			}, 30_000);
		}
	}
});

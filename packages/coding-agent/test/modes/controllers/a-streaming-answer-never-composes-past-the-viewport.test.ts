/**
 * A streaming answer never composes past the viewport.
 *
 * THE DEFECT. An operator sending a message watched the composer jump and the
 * screen shake back and forth for as long as the answer streamed.
 * `HomeAnchorLayout.sync` sizes the anchor fills from `ui.composedFrameRows`,
 * which is the PREVIOUS frame's height. A turn that grows in place between one
 * frame and the next is measured at its old height, so the slack routed above
 * it is sized for rows the content has already taken. The frame composes one
 * row taller than the viewport, the engine moves the window down to fit, the
 * post-commit correction then shrinks the fill by that row, and the window
 * moves back — once per streamed chunk, each cycle costing a full repaint.
 *
 * THE CLASS. Not "streaming". Any content that changes height between a frame
 * composing and the next measurement of it, while the conversation is young
 * enough that the fill is what puts the composer on the bottom edge. Growth in
 * place is the arm no post-compose correction can reach on its own, because the
 * frame it reads has already composed too tall; that is why the anchor is sized
 * from `TUI.onBeforeCompose`, while the children measured are still the children
 * about to render.
 *
 * THE RULE, in two halves that only make sense together. The frame never
 * exceeds the viewport while slack is positive, because a frame that does is
 * what moves the window. And the composer stays on the bottom row throughout,
 * because a suite that only banned overflow would be satisfied by deleting the
 * anchor and letting the composer float wherever the content ends.
 *
 * WHAT IT DOES NOT CATCH. Wrapping: the anchor's own measurement of the live
 * children counts rendered rows and cannot see a row that wraps, so the
 * composed frame is still the authority where it is the larger of the two. A
 * session long enough to have scrolled has no slack to route and is the blank
 * band suite's question. Nothing here speaks about colour or styling.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { TranscriptContainer } from "@veyyon/coding-agent/modes/components/transcript-container";
import { HomeAnchorLayout } from "@veyyon/coding-agent/modes/controllers/home-anchor-layout";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { type Component, Container, CURSOR_MARKER, type Focusable, TUI } from "@veyyon/tui";
import { settleFrames } from "../../../../tui/test/helpers/settle-frames";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal";

/** A block that grows in place, the way a streaming answer does. */
class GrowingBlock implements Component {
	rows = 1;
	invalidate(): void {}
	render(): string[] {
		return Array.from({ length: this.rows }, (_, i) => `  answer row ${i + 1}`);
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

function lastPaintedRow(term: VirtualTerminal): number {
	return term
		.getViewport()
		.map(row => Bun.stripANSI(row).trimEnd())
		.reduce((last, row, i) => (row.trim().length > 0 ? i : last), -1);
}

describe("a streaming answer never composes past the viewport", () => {
	beforeAll(async () => {
		await initTheme(false, "unicode", false, "titanium", "dark");
	});

	// Both transcript kinds, because the anchor reads the frame and a virtualized
	// transcript reports a different frame than a plain container.
	for (const kind of ["plain", "virtualized"] as const) {
		for (const rows of [24, 40] as const) {
			test(`${kind} transcript, ${rows} rows`, async () => {
				const term = new VirtualTerminal(80, rows, 5_000);
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
				// Every composed frame is recorded, not the settled one. The
				// overflow lasts a single frame and the post-commit correction
				// removes it, so a measurement taken after the frames drain reads
				// the repaired height and sees nothing.
				const composed: number[] = [];
				tui.onBeforeCompose = () => layout.sync();
				tui.onFrameComposed = () => {
					composed.push(tui.composedFrameRows);
					layout.onFrameComposed();
				};
				tui.start();

				const answer = new GrowingBlock();
				transcript.addChild(answer);
				tui.requestRender();
				await settleFrames(term, tui);

				// The fill is what holds the composer down at this height, or the
				// arm proves nothing about what streaming preserved.
				expect({ where: "seed", last: lastPaintedRow(term) }).toEqual({ where: "seed", last: rows - 1 });

				// Stream one row at a time up to and past the point the content
				// fills the viewport, which is where the slack runs out.
				const floated: number[] = [];
				for (let grownTo = 2; grownTo <= rows + 4; grownTo++) {
					answer.rows = grownTo;
					transcript.invalidate();
					composed.length = 0;
					tui.requestRender();
					await settleFrames(term, tui);

					// A frame taller than the viewport while slack remains is what
					// moves the window, and moving it back on the next frame is the
					// shake. Once the content itself outgrows the viewport the frame
					// is legitimately longer and the anchor routes nothing.
					const contentFits = grownTo + 1 <= rows;
					if (contentFits) {
						const tallest = Math.max(0, ...composed);
						expect({ grownTo, tallest, viewport: rows }).toEqual({
							grownTo,
							tallest: Math.min(tallest, rows),
							viewport: rows,
						});
					}
					if (lastPaintedRow(term) !== rows - 1) floated.push(grownTo);
				}

				// And the composer never left the bottom row on the way.
				expect(floated).toEqual([]);
				expect(Bun.stripANSI(term.getViewport()[rows - 1] ?? "")).toContain("> ask anything");

				tui.stop();
				await term.flush();
			}, 60_000);
		}
	}
});

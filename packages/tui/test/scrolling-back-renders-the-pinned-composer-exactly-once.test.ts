/**
 * Scrolling back in scroll isolation renders the pinned composer exactly once.
 *
 * WHY THIS SUITE EXISTS. In scroll isolation, the scrollable transcript region
 * renders from `#scrollSnapshot` while the pinned footer renders the live tail.
 * Previously, `#scrollSnapshot` took `frame.slice(this.#committedRows)` without
 * excluding `#pinnedFooterRows`. Because `frame` contains all root children
 * (transcript plus pinned footer), the composer rows were baked into the tail
 * of the snapshot. Once the reader scrolled back far enough that `viewTop`
 * reached the snapshot tail (for example when new content arrived while reading
 * history and the user scrolled back down toward the tail), the baked-in
 * composer rows were painted inside the transcript region, while simultaneously
 * the live composer was painted in the footer region — duplicating the composer
 * and causing the stale copy to drift upward as the user scrolled.
 *
 * THE CLASS. Any scroll-isolation view where a pinned footer is active across
 * arbitrary viewport heights, transcript lengths, footer heights, and scroll
 * positions (from initial wheel-up through top of scroll space and back down).
 *
 * WHAT IT DOES NOT CATCH. Unpinned footers (where the composer is part of normal
 * scrollable flow) and sessions with scroll isolation disabled.
 */
import { describe, expect, it } from "bun:test";
import { type Component, CURSOR_MARKER, type Focusable, TUI } from "@veyyon/tui";
import { settleFrames } from "./helpers/settle-frames";
import { VirtualTerminal } from "./virtual-terminal";

class Transcript implements Component {
	lines: string[] = [];

	invalidate(): void {}

	render(_width: number): readonly string[] {
		return this.lines;
	}
}

class PinnedComposer implements Component, Focusable {
	focused = true;
	lines: string[];

	constructor(lines: string[] = ["> [PINNED_COMPOSER_INPUT]" + CURSOR_MARKER]) {
		this.lines = lines;
	}

	invalidate(): void {}

	setUseTerminalCursor(): void {}

	handleInput(): void {}

	render(_width: number): readonly string[] {
		return this.lines;
	}
}

const WHEEL_UP = "\x1b[<64;5;5M";
const WHEEL_DOWN = "\x1b[<65;5;5M";

function makeTranscriptRows(count: number, start = 0): string[] {
	return Array.from({ length: count }, (_, i) => `transcript-line-${String(start + i).padStart(4, "0")}`);
}

describe("scrolling back renders the pinned composer exactly once", () => {
	const VIEWPORT_HEIGHTS = [8, 12, 20, 30] as const;
	const FOOTER_CONFIGS = [
		{ name: "single-row footer", lines: ["> [PINNED_COMPOSER_INPUT]" + CURSOR_MARKER], marker: "[PINNED_COMPOSER_INPUT]" },
		{
			name: "multi-row footer",
			lines: ["--- [COMPOSER_HEADER_DIVIDER] ---", "> [PINNED_COMPOSER_INPUT]" + CURSOR_MARKER],
			marker: "[PINNED_COMPOSER_INPUT]",
		},
	] as const;

	for (const height of VIEWPORT_HEIGHTS) {
		for (const footerConfig of FOOTER_CONFIGS) {
			it(`renders composer exactly once when scrolling down after new lines arrive (height=${height}, ${footerConfig.name})`, async () => {
				const term = new VirtualTerminal(60, height, 1_000);
				const tui = new TUI(term, true);
				tui.setScrollbackRebuild(false);

				const transcript = new Transcript();
				const composer = new PinnedComposer(footerConfig.lines);
				const footerRows = footerConfig.lines.length;

				tui.addChild(transcript);
				tui.addChild(composer);
				tui.setFocus(composer);
				tui.setScrollIsolation(true);
				tui.setPinnedFooterChildCount(1);

				const initialCount = height * 2;
				transcript.lines = makeTranscriptRows(initialCount);

				tui.start();
				await settleFrames(term, tui);

				try {
					// 1. Scroll back into history to freeze the snapshot.
					const stepsUp = Math.ceil(initialCount / 3);
					for (let i = 0; i < stepsUp; i++) {
						term.sendInput(WHEEL_UP);
						await settleFrames(term, tui);
					}

					expect(tui.virtualScrollActive).toBe(true);

					// 2. New transcript lines arrive while scrolled back (e.g. streaming output).
					transcript.lines = makeTranscriptRows(initialCount + height * 2);
					tui.requestRender();
					await settleFrames(term, tui);

					// 3. Scroll all the way down toward the new live tail.
					// Under the defect, when viewTop passes through the old snapshot tail,
					// the baked-in composer in the snapshot appears in the transcript region
					// while the live composer also renders at the bottom (duplicated).
					const stepsDown = stepsUp * 3;
					for (let step = 0; step < stepsDown; step++) {
						term.sendInput(WHEEL_DOWN);
						await settleFrames(term, tui);

						const matches = term
							.getViewport()
							.map((row, idx) => ({ row: Bun.stripANSI(row), idx }))
							.filter(item => item.row.includes(footerConfig.marker));

						expect(matches.length).toBe(1);
						expect(matches[0]!.idx).toBeGreaterThanOrEqual(height - footerRows);
					}
				} finally {
					tui.stop();
					await term.flush();
				}
			});
		}
	}

	it("never paints composer in the transcript region across exhaustive scroll offsets", async () => {
		const height = 10;
		const term = new VirtualTerminal(60, height, 1_000);
		const tui = new TUI(term, true);
		tui.setScrollbackRebuild(false);

		const transcript = new Transcript();
		const marker = "[PINNED_COMPOSER_INPUT]";
		const composer = new PinnedComposer([`> ${marker}${CURSOR_MARKER}`]);

		tui.addChild(transcript);
		tui.addChild(composer);
		tui.setFocus(composer);
		tui.setScrollIsolation(true);
		tui.setPinnedFooterChildCount(1);

		transcript.lines = makeTranscriptRows(30);

		tui.start();
		await settleFrames(term, tui);

		try {
			// Scroll back 5 steps to freeze snapshot
			for (let i = 0; i < 5; i++) {
				term.sendInput(WHEEL_UP);
				await settleFrames(term, tui);
			}
			expect(tui.virtualScrollActive).toBe(true);

			// Append new transcript lines to extend live scroll space
			transcript.lines = makeTranscriptRows(60);
			tui.requestRender();
			await settleFrames(term, tui);

			// Scroll down 1 step at a time through all offsets
			for (let i = 0; i < 30; i++) {
				term.sendInput(WHEEL_DOWN);
				await settleFrames(term, tui);

				const viewport = term.getViewport().map(r => Bun.stripANSI(r));
				const transcriptRegion = viewport.slice(0, height - 1);
				const footerRegion = viewport.slice(height - 1);

				// Pinned composer must NEVER appear in the transcript region
				expect(transcriptRegion.some(row => row.includes(marker))).toBe(false);
				// Pinned composer must appear in footer region
				expect(footerRegion.some(row => row.includes(marker))).toBe(true);
			}
		} finally {
			tui.stop();
			await term.flush();
		}
	});
});

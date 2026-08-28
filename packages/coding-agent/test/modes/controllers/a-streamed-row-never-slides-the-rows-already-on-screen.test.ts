/**
 * A streamed row lands in the empty space; it never slides the rows above it.
 *
 * WHY THIS SUITE EXISTS. `HomeAnchorLayout` routed every slack row ABOVE the
 * transcript once a conversation existed, anchoring the content's BOTTOM to the
 * composer. While an answer streamed into a screen that was not yet full, each
 * new row shrank that top fill by one, so every row already painted slid up one
 * row and was rewritten. The rewrite count grew with the answer — three rows on
 * the first token, the whole viewport by the tenth — which reads as the screen
 * shaking for as long as the model is talking.
 *
 * THE CLASS. Not "one terminal height": any conversation frame with slack left
 * to route. The invariant is positional, not numeric — a row that is on screen
 * before a streamed row arrives is on the SAME screen row after it, and the
 * composer keeps the bottom of the viewport throughout. Both transcript kinds
 * are swept because the anchor measures the composed frame and a virtualized
 * transcript reports a different frame than a plain container, and several
 * heights and per-token growths are swept because the defect scaled with the
 * distance between the content and the bottom edge.
 *
 * WHAT IT DOES NOT CATCH. Once the content fills the viewport there is no slack
 * to route and the engine scrolls, which is the render engine's contract and is
 * covered by the tui scrollback suites. Nor does it judge how the terminal
 * schedules the bytes: a minimal repaint here can still tear over a slow link.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { TranscriptContainer } from "@veyyon/coding-agent/modes/components/transcript-container";
import { HomeAnchorLayout } from "@veyyon/coding-agent/modes/controllers/home-anchor-layout";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { settleFrames, VirtualTerminal } from "@veyyon/render-oracle";
import { type Component, Container, CURSOR_MARKER, type Focusable, TUI } from "@veyyon/tui";

class Block implements Component {
	#lines: string[];
	constructor(lines: readonly string[]) {
		this.#lines = [...lines];
	}
	setLines(lines: readonly string[]): void {
		this.#lines = [...lines];
	}
	invalidate(): void {}
	// Transcript components wrap their own text to the render width rather than
	// handing the engine an over-wide row, so a wide logical row is several
	// screen rows here too.
	render(width: number): string[] {
		const wrapped: string[] = [];
		for (const line of this.#lines) {
			if (line.length <= width) {
				wrapped.push(line);
				continue;
			}
			for (let start = 0; start < line.length; start += width) {
				wrapped.push(line.slice(start, start + width));
			}
		}
		return wrapped;
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

function paintedRows(term: VirtualTerminal): string[] {
	return term.getViewport().map(row => Bun.stripANSI(row).trimEnd());
}

/** Rows carrying content, paired with the screen row they were painted on. */
function occupiedRows(rows: readonly string[]): Map<number, string> {
	const occupied = new Map<number, string>();
	rows.forEach((row, index) => {
		if (row.trim().length > 0) occupied.set(index, row);
	});
	return occupied;
}

describe("a streamed row never slides the rows already on screen", () => {
	beforeAll(async () => {
		await initTheme(false, "unicode", false, "titanium", "dark");
	});

	for (const kind of ["plain", "virtualized"] as const) {
		for (const rows of [16, 24, 40] as const) {
			for (const rowsPerToken of [1, 3] as const) {
				// A row wider than the terminal is measured by the composed frame and
				// approximated by the child walk, which is where an anchor sized from
				// the wrong one bounces the composer a row and back.
				for (const width of [40, 200] as const) {
					test(`${kind} transcript, ${rows} rows, ${rowsPerToken} row(s) per token, ${width}-column rows`, async () => {
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
						tui.onFrameComposed = () => layout.onFrameComposed();
						tui.start();

						const answer = new Block(["  assistant:"]);
						transcript.addChild(new Block(["> hello", ""]));
						transcript.addChild(answer);
						tui.requestRender();
						await settleFrames(term, tui);

						// The arm only proves something while the screen has room left to
						// route: with zero slack the engine scrolls and every row moves by
						// contract.
						expect(layout.bottomFill.render(80).length).toBeGreaterThan(0);

						const body = ["  assistant:"];
						const slid: Array<{ token: number; row: number; before: string; after: string }> = [];
						const composerOffBottom: Array<{ token: number; last: number }> = [];
						const overslid: Array<{ token: number; deficit: number; row: number; after: string }> = [];
						let previous = occupiedRows(paintedRows(term));
						let token = 0;
						let fittingSteps = 0;
						let overflowSteps = 0;
						while (layout.bottomFill.render(80).length > 0) {
							// Rows a step cannot fit are rows the engine must scroll for, so the
							// two cases are judged apart: a step that fits moves nothing, and a
							// step that overflows moves everything up by exactly its deficit.
							const slackBefore = layout.bottomFill.render(80).length;
							const screenRowsPerToken = rowsPerToken * Math.ceil(width / 80);
							const deficit = Math.max(0, screenRowsPerToken - slackBefore);
							for (let line = 0; line < rowsPerToken; line++) {
								body.push(`  answer row ${token}-${line} `.padEnd(width, "x"));
							}
							answer.setLines(body);
							layout.sync(true);
							tui.requestRender();
							await settleFrames(term, tui);

							const current = paintedRows(term);
							if (deficit === 0) {
								fittingSteps += 1;
								for (const [row, text] of previous) {
									const after = current[row] ?? "";
									if (after !== text) slid.push({ token, row, before: text, after });
								}
							} else {
								overflowSteps += 1;
								// The pinned footer does not travel with the scroll — the engine
								// holds it on the bottom rows — so the shift is judged over the
								// transcript rows only, bounded by the renderer's own placement.
								const { footerTop } = tui.pinnedFooterScreenBounds;
								for (const [row, text] of previous) {
									const landed = row - deficit;
									if (landed < 0 || row >= footerTop) continue;
									const after = current[landed] ?? "";
									if (after !== text) overslid.push({ token, deficit, row: landed, after });
								}
							}
							const last = current.reduce((seen, row, index) => (row.trim().length > 0 ? index : seen), -1);
							if (last !== rows - 1) composerOffBottom.push({ token, last });
							previous = occupiedRows(current);
							token += 1;
						}

						// CONTRACT DEFENSE: while the answer fits, every row that was on screen
						// is still on the same screen row; when it stops fitting, each row moves
						// up by exactly the rows that did not fit and no further. The composer
						// owns the bottom edge throughout. All three are read off the terminal,
						// so the arm carries no expected geometry of its own.
						expect({ slid, overslid, composerOffBottom }).toEqual({
							slid: [],
							overslid: [],
							composerOffBottom: [],
						});
						expect(fittingSteps).toBeGreaterThan(0);
						expect(overflowSteps).toBeLessThanOrEqual(1);
						expect(Bun.stripANSI(term.getViewport()[rows - 1] ?? "")).toContain("> ask anything");

						tui.stop();
						await term.flush();
					}, 30_000);
				}
			}
		}
	}
});

/**
 * No frame composes past the viewport while the anchor still has slack.
 *
 * THE DEFECT CLASS. `HomeAnchorLayout` routes the rows between the content and
 * the composer. It sized that slack from `ui.composedFrameRows`, the PREVIOUS
 * frame's height, so any content whose height changed since that frame was
 * measured at its old height. The frame then composed taller than the viewport,
 * the engine moved the window down to fit, and the post-commit correction moved
 * it back on the next frame. One streamed chunk per cycle, each a full repaint:
 * that alternation is what reached an operator as a shaking screen and a
 * scattered composer. The anchor now reads the live children and nothing else,
 * and there is no post-commit correction left to alternate with.
 *
 * WHY A SWEEP AND NOT A CASE. Streaming was the reported trigger and is not the
 * class. Anything that changes a child's height between one frame and the next
 * reaches the same defect: a tool card expanding when its result lands, a HUD
 * collapsing, a block mounting, content arriving in a burst rather than a row
 * at a time. Each is swept here against one invariant, at the one place that
 * decides it, rather than one suite per trigger.
 *
 * WHY EVERY FRAME IS RECORDED. An overflow can last a single frame and be gone
 * from the terminal by the time the frames drain, so a suite that measures the
 * settled screen passes against the live defect — the first version of the
 * streaming suite did precisely that, and its mutation gate came back green
 * while the bug was present. `TUI.onFrameComposed` fires once per composed
 * frame, so the transient is only visible from inside it.
 *
 * WHY BOTH REPAINT KINDS. A frame is either full or component-scoped, and the
 * shipped streaming path takes the second one: `ChatBlock.requestRender` calls
 * `TUI.requestComponentRender`, which re-renders the requested subtree and
 * REUSES the previous rows of every other root child — including the fill the
 * sizing pass just resized for this frame, whose new height is then dropped and
 * whose old height overflows the frame by the rows the answer gained. Nothing
 * repairs that one downstream either: the fill component already holds the right
 * number, so any later comparison against it reads equal. Every arm below is
 * therefore swept under both kinds; the full-frame arm alone passed against
 * that defect for every trigger.
 *
 * THE INVARIANT, in two halves that only work together. While the content fits,
 * no composed frame exceeds the viewport, because a frame that does is what
 * moves the window. AND the composer sits on the bottom row throughout, because
 * a suite asserting only the first half is satisfied by deleting the anchor and
 * letting the composer float wherever the content happens to end.
 *
 * WHAT IT DOES NOT CATCH. A width reduction that rewraps content already on
 * screen: the frame holds one entry per line and the terminal wraps at paint, so
 * the frame length does not move when a line gets longer. Nor a child whose
 * `render(width)` returns a different height on a second call in the same frame,
 * which would make the sizing pass and the compose disagree by construction —
 * every component here renders from its own state, as the shipped ones do.
 * Frames composed DURING a resize are also excluded: the engine deliberately
 * re-anchors and repaints across a resize, so "taller than the viewport" is not
 * a defect mid-resize — the resize arm asserts the settled position and then
 * sweeps growth on the new geometry, which is where the invariant applies
 * again. A session long enough to have scrolled has no slack at all and is the
 * blank-band suite's question.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { TranscriptContainer } from "@veyyon/coding-agent/modes/components/transcript-container";
import { HomeAnchorLayout } from "@veyyon/coding-agent/modes/controllers/home-anchor-layout";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { type Component, Container, CURSOR_MARKER, type Focusable, TUI } from "@veyyon/tui";
import { settleFrames } from "../../../../tui/test/helpers/settle-frames";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal";

/** A block whose height is set from the test, the way live content changes it. */
class HeightBlock implements Component {
	rows = 1;
	constructor(private readonly label: string) {}
	invalidate(): void {}
	render(): string[] {
		return Array.from({ length: this.rows }, (_, i) => `  ${this.label} row ${i + 1}`);
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

/** One observed state: what the content asked for, and the frames it composed. */
interface Step {
	contentRows: number;
	viewportRows: number;
	/** Tallest frame composed while reaching this state. */
	tallest: number;
	/** Row the composer landed on once the frames drained. */
	lastPainted: number;
}

interface Harness {
	term: VirtualTerminal;
	transcript: Container;
	block: HeightBlock;
	/**
	 * Apply a change, drain the frames it causes, and record the tallest frame
	 * composed while doing so. The recorder is cleared first, so each step
	 * reports only its own frames.
	 */
	step(contentRows: number, apply: () => void): Promise<Step>;
	settle(): Promise<void>;
	rows(): number;
	resizeTo(rows: number): void;
}

type Trigger = (harness: Harness) => Promise<Step[]>;

/**
 * The two shapes a frame comes in. `full` re-renders every root child;
 * `component` re-renders the requested subtree and reuses the previous rows of
 * every other root child, which is what the shipped streaming path requests
 * (`ChatBlock.requestRender`).
 */
const PAINTS = ["component", "full"] as const;

const TRIGGERS: Record<string, Trigger> = {
	/** A streaming answer: one row at a time, up to and past the slack. */
	async grow(h) {
		const steps: Step[] = [];
		for (let rows = 2; rows <= h.rows() + 4; rows++) {
			steps.push(
				await h.step(rows, () => {
					h.block.rows = rows;
					h.transcript.invalidate();
				}),
			);
		}
		return steps;
	},

	/** A tool card whose result lands at once, several rows in a single frame. */
	async burst(h) {
		const steps: Step[] = [];
		for (const rows of [4, 9, 15, h.rows() + 2]) {
			steps.push(
				await h.step(rows, () => {
					h.block.rows = rows;
					h.transcript.invalidate();
				}),
			);
		}
		return steps;
	},

	/** A HUD or answer collapsing: the height falls and the slack has to grow back. */
	async collapse(h) {
		const tall = Math.max(2, h.rows() - 6);
		await h.step(tall, () => {
			h.block.rows = tall;
			h.transcript.invalidate();
		});

		const steps: Step[] = [];
		for (let rows = tall; rows >= 1; rows -= 3) {
			steps.push(
				await h.step(rows, () => {
					h.block.rows = rows;
					h.transcript.invalidate();
				}),
			);
		}
		return steps;
	},

	/** A second block mounting into a transcript that already has one. */
	async mount(h) {
		const steps: Step[] = [];
		let total = h.block.rows;
		for (const rows of [3, 5, 7]) {
			total += rows;
			steps.push(
				await h.step(total, () => {
					const extra = new HeightBlock(`mounted-${rows}`);
					extra.rows = rows;
					h.transcript.addChild(extra);
				}),
			);
		}
		return steps;
	},

	/** Growth on geometry that just changed, which is where the fill is resized. */
	async growAfterResize(h) {
		h.resizeTo(h.rows() + 16);
		// The resize path re-measures behind a real settle window. Frames
		// composed inside it are excluded by charter: the engine re-anchors
		// there deliberately, so the invariant resumes once it has settled.
		await Bun.sleep(160);
		await h.settle();

		const steps: Step[] = [];
		for (let rows = 2; rows <= h.rows() + 2; rows += 2) {
			steps.push(
				await h.step(rows, () => {
					h.block.rows = rows;
					h.transcript.invalidate();
				}),
			);
		}
		return steps;
	},
};

describe("no frame composes past the viewport while slack remains", () => {
	beforeAll(async () => {
		await initTheme(false, "unicode", false, "titanium", "dark");
	});

	test("the swept trigger and repaint sets are the ones that were decided", () => {
		// A new way for content to change height is a new arm, not a silent
		// addition. Pinned by exact equality: a count would admit a swap.
		expect(Object.keys(TRIGGERS).sort()).toEqual(["burst", "collapse", "grow", "growAfterResize", "mount"]);
		// The engine composes a frame in exactly these two shapes, and only one
		// of them reuses a sibling's previous rows.
		expect([...PAINTS]).toEqual(["component", "full"]);
	});

	for (const [name, trigger] of Object.entries(TRIGGERS)) {
		// Both transcript kinds: the anchor reads the composed frame, and a
		// virtualized transcript reports a different frame than a plain one.
		for (const kind of ["plain", "virtualized"] as const) {
			for (const paint of PAINTS) {
				test(`${name}, ${kind} transcript, ${paint} repaint`, async () => {
					const term = new VirtualTerminal(80, 24, 5_000);
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

					const composed: number[] = [];
					tui.onBeforeCompose = () => layout.sync();
					tui.onFrameComposed = () => composed.push(tui.composedFrameRows);
					tui.start();

					const block = new HeightBlock("answer");
					transcript.addChild(block);
					tui.requestRender();
					await settleFrames(term, tui);

					// The fill is what holds the composer down at this point, or the
					// arm proves nothing about what the trigger preserved.
					expect({ where: "seed", last: lastPaintedRow(term) }).toEqual({
						where: "seed",
						last: term.rows - 1,
					});

					const harness: Harness = {
						term,
						transcript,
						block,
						rows: () => term.rows,
						resizeTo: rows => term.resize(80, rows),
						settle: () => settleFrames(term, tui),
						step: async (contentRows, apply) => {
							composed.length = 0;
							apply();
							// The block is a transcript child, so a component-scoped
							// request resolves to the transcript root exactly as a
							// streamed chunk's does.
							if (paint === "component") tui.requestComponentRender(block);
							else tui.requestRender();
							await settleFrames(term, tui);
							return {
								contentRows,
								viewportRows: term.rows,
								tallest: Math.max(0, ...composed),
								lastPainted: lastPaintedRow(term),
							};
						},
					};

					const steps = await trigger(harness);
					expect(steps.length).toBeGreaterThan(0);

					const overflowed = steps
						// Once the content itself outgrows the viewport the frame is
						// legitimately longer and the anchor routes nothing.
						.filter(step => step.contentRows + 1 <= step.viewportRows && step.tallest > step.viewportRows)
						.map(step => ({ contentRows: step.contentRows, tallest: step.tallest, viewport: step.viewportRows }));
					expect(overflowed).toEqual([]);

					const floated = steps
						.filter(
							step => step.contentRows + 1 <= step.viewportRows && step.lastPainted !== step.viewportRows - 1,
						)
						.map(step => ({ contentRows: step.contentRows, lastPainted: step.lastPainted }));
					expect(floated).toEqual([]);

					// And the row it lands on is the composer, not the tail of content
					// that grew into the space.
					expect(Bun.stripANSI(term.getViewport()[term.rows - 1] ?? "")).toContain("> ask anything");

					tui.stop();
					await term.flush();
				}, 120_000);
			}
		}
	}
});

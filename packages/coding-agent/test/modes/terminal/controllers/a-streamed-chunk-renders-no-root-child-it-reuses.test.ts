/**
 * A streamed chunk renders no root child its frame reuses, the anchor's sizing pass included.
 *
 * THE DEFECT. A streamed chunk requests a component-scoped frame (`ChatBlock.requestRender`), which
 * re-renders the transcript and reuses the previous rows of every other root child. The anchor's
 * sizing pass (`HomeAnchorLayout.sync`, run from `TUI.onBeforeCompose`) measured every root child by
 * rendering it, so the status rows, the composer and its footline rendered once per chunk for a
 * height the engine already held: the composer footline alone was 5% of a streaming turn's CPU. The
 * pass reads those heights through `TUI.reusedRows` now.
 *
 * THE CLASS. Every root child outside the requested subtree, swept by counting the renders of each
 * one the harness mounts, in both transcript kinds and on both sides of the point where the content
 * fills the viewport (the measurement saturates there and stops early).
 *
 * WHAT IT DOES NOT CATCH. Whether the fills the pass sizes are exact: that is
 * `no-frame-composes-past-the-viewport-while-slack-remains.test.ts`, which runs every trigger
 * under component-scoped frames. Nor the transcript's own measurement, which renders the bottom of
 * the transcript the frame is about to render anyway.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { TranscriptContainer } from "@veyyon/coding-agent/modes/terminal/components/transcript/transcript-container";
import { HomeAnchorLayout } from "@veyyon/coding-agent/modes/terminal/controllers/home-anchor-layout";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { type Component, Container, TUI } from "@veyyon/tui";
import { StressRenderScheduler } from "../../../../../../hosts/terminal/engine/test/render-stress-scheduler";
import { VirtualTerminal } from "../../../../../../hosts/terminal/engine/test/virtual-terminal";

class Rows implements Component {
	renders = 0;
	readonly name: string;
	rows: number;

	constructor(name: string, rows: number) {
		this.name = name;
		this.rows = rows;
	}

	invalidate(): void {}

	render(): string[] {
		this.renders++;
		return Array.from({ length: this.rows }, (_, i) => `${this.name} ${i + 1}`);
	}
}

const VIEWPORT = 16;

describe("a streamed chunk renders no root child it reuses", () => {
	beforeAll(async () => {
		await initTheme(false, "unicode", false, "titanium", "dark");
	});

	for (const kind of ["plain", "virtualized"] as const) {
		for (const [where, answerRows] of [
			["while the content fits", 2],
			["once the content fills the viewport", VIEWPORT + 4],
		] as const) {
			it(`${kind} transcript, ${where}`, async () => {
				const term = new VirtualTerminal(60, VIEWPORT, 2_000);
				const scheduler = new StressRenderScheduler();
				const tui = new TUI(term, true, { renderScheduler: scheduler });
				const transcript = kind === "plain" ? new Container() : new TranscriptContainer();
				const layout = new HomeAnchorLayout({
					ui: tui,
					transcriptChildCount: () => transcript.children.length,
					hasHero: () => false,
				});
				const reusedRoots = [new Rows("status", 1), new Rows("composer", 2), new Rows("footline", 1)];
				tui.addChild(layout.topFill);
				tui.addChild(transcript);
				tui.addChild(layout.bottomFill);
				for (const root of reusedRoots) tui.addChild(root);
				tui.onBeforeCompose = () => layout.sync();
				let composed = 0;
				tui.onFrameComposed = () => composed++;

				const answer = new Rows("answer", answerRows);
				transcript.addChild(answer);
				try {
					tui.start();
					await scheduler.drain(term);

					const before = reusedRoots.map(root => root.renders);
					const framesBefore = composed;
					for (let i = 0; i < 6; i++) {
						answer.rows++;
						tui.requestComponentRender(answer);
						await scheduler.drain(term);
					}

					expect({
						frames: composed - framesBefore,
						renders: Object.fromEntries(reusedRoots.map((root, i) => [root.name, root.renders - before[i]!])),
					}).toEqual({ frames: 6, renders: { status: 0, composer: 0, footline: 0 } });
					// The reused rows still close the frame: the footline sits on the bottom row.
					expect(Bun.stripANSI(term.getViewport()[VIEWPORT - 1] ?? "").trimEnd()).toBe("footline 1");
				} finally {
					tui.stop();
					await term.flush();
				}
			});
		}
	}
});

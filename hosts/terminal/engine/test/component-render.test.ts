import { describe, expect, it } from "bun:test";
import {
	type Component,
	Container,
	CURSOR_MARKER,
	type NativeScrollbackCommittedRows,
	type NativeScrollbackCompaction,
	type NativeScrollbackLiveRegion,
	type NativeScrollbackReplay,
	TUI,
} from "@veyyon/tui";
import { StressRenderScheduler } from "./render-stress-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

// Behavioral tests for TUI.requestComponentRender: a component whose own
// content changed (spinner frame, blink) asks for a component-scoped frame.
// When every request since the last frame is component-scoped and the frame is
// otherwise quiet, the compose re-renders only the root subtrees containing
// the requesting components and reuses the previous segment — rows and seam
// report — of every other root child. Any concurrent full request or unsafe
// condition must downgrade to a normal full compose.

/** Ref-stable leaf: fresh array per change, counts render() calls. */
class CountingLines implements Component {
	renders = 0;
	#lines: string[];

	constructor(lines: string[]) {
		this.#lines = lines;
	}

	set(lines: string[]): void {
		this.#lines = lines;
	}

	invalidate(): void {}

	render(_width: number): readonly string[] {
		this.renders++;
		return this.#lines;
	}
}

/** Transcript-shaped head: final rows committed, the last row stays live. */
class LiveHead extends CountingLines implements NativeScrollbackLiveRegion {
	#seam = 0;

	setSeam(seam: number): void {
		this.#seam = seam;
	}

	getNativeScrollbackLiveRegionStart(): number | undefined {
		return this.#seam;
	}
}

class AnchoredStatusContainer extends Container implements NativeScrollbackLiveRegion {
	getNativeScrollbackLiveRegionStart(): number | undefined {
		const hasAnchoredRows = this.children.length > 0;
		return hasAnchoredRows ? 0 : undefined;
	}
}

function strip(rows: string[]): string[] {
	return rows.map(row => Bun.stripANSI(row).trimEnd());
}

function visible(term: VirtualTerminal): string[] {
	return strip(term.getViewport()).filter(row => row.length > 0);
}

class RenderCountingTUI extends TUI {
	renders = 0;

	override render(width: number): readonly string[] {
		this.renders++;
		return super.render(width);
	}
}

class ReplayVirtualizedLines
	implements Component, NativeScrollbackCommittedRows, NativeScrollbackCompaction, NativeScrollbackReplay
{
	readonly lines: readonly string[];
	replayPreparations = 0;
	/** Whether this root reports its drops, i.e. implements the compaction seam. */
	readonly reportsDrops: boolean;
	#compacted = false;
	#replayPending = false;
	#dropped = 0;

	constructor(lines: readonly string[], reportsDrops = true) {
		this.lines = lines;
		this.reportsDrops = reportsDrops;
	}

	invalidate(): void {}

	setNativeScrollbackCommittedRows(rows: number): void {
		if (rows >= 4 && !this.#compacted) {
			this.#compacted = true;
			this.#dropped += 4;
		}
	}

	takeNativeScrollbackDroppedRows(): number {
		if (!this.reportsDrops) return 0;
		const dropped = this.#dropped;
		this.#dropped = 0;
		return dropped;
	}

	prepareNativeScrollbackReplay(): void {
		this.replayPreparations++;
		this.#replayPending = true;
		this.#compacted = false;
		this.#dropped = 0;
	}

	render(_width: number): readonly string[] {
		if (this.#replayPending) {
			this.#replayPending = false;
			return this.lines;
		}
		return this.#compacted ? this.lines.slice(4) : this.lines;
	}
}

describe("TUI native scrollback replay", () => {
	/**
	 * A root that reports its drops (the `NativeScrollbackCompaction` seam) is
	 * rehydrated exactly once, by the explicit replace: the engine slides its
	 * commit index by the reported rows, so the compaction itself never reads
	 * as a divergence and never asks for the history back.
	 */
	it("rehydrates a reporting virtualized root once, for the destructive full paint only", async () => {
		const term = new VirtualTerminal(40, 4, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new ReplayVirtualizedLines([
			"history-0",
			"history-1",
			"history-2",
			"history-3",
			"tail-0",
			"tail-1",
			"tail-2",
			"tail-3",
		]);
		tui.addChild(transcript);

		try {
			tui.start();
			await scheduler.drain(term);
			tui.requestRender();
			await scheduler.drain(term);

			tui.requestRender(true, { clearScrollback: true });
			await scheduler.drain(term);

			expect(transcript.replayPreparations).toBe(1);
			const buffer = strip(term.getScrollBuffer());
			expect(buffer).toContain("history-0");
			expect(buffer).toContain("tail-3");
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	/**
	 * A root that drops rows WITHOUT reporting them still must not lose them.
	 * The engine cannot see the shift, so the shrunken frame reads as a
	 * committed-prefix divergence; with `tui.scrollbackRebuild` on, that erases
	 * native scrollback and replays. Replaying the dropped frame is what
	 * deleted whole transcripts, so the engine asks for the rows back first and
	 * pays an extra rehydration — the cost of not reporting.
	 */
	it("rehydrates a silent virtualized root rather than replaying a frame it emptied", async () => {
		const term = new VirtualTerminal(40, 4, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		tui.setScrollbackRebuild(true);
		const transcript = new ReplayVirtualizedLines(
			["history-0", "history-1", "history-2", "history-3", "tail-0", "tail-1", "tail-2", "tail-3"],
			false,
		);
		tui.addChild(transcript);

		try {
			tui.start();
			await scheduler.drain(term);
			tui.requestRender();
			await scheduler.drain(term);

			expect(transcript.replayPreparations).toBeGreaterThanOrEqual(1);
			const buffer = strip(term.getScrollBuffer());
			expect(buffer).toContain("history-0");
			expect(buffer).toContain("tail-3");
		} finally {
			tui.stop();
			await term.flush();
		}
	});
});

describe("TUI.requestComponentRender", () => {
	it("re-renders only the requesting subtree on a quiet frame", async () => {
		const term = new VirtualTerminal(40, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new CountingLines(["msg-0", "msg-1", "msg-2"]);
		const status = new Container();
		const spinner = new CountingLines(["spin-0"]);
		status.addChild(spinner);
		tui.addChild(transcript);
		tui.addChild(status);

		try {
			tui.start();
			await scheduler.drain(term);
			expect(visible(term)).toEqual(["msg-0", "msg-1", "msg-2", "spin-0"]);
			const transcriptRenders = transcript.renders;

			// Spinner tick: component-scoped request, nested one level deep.
			spinner.set(["spin-1"]);
			tui.requestComponentRender(spinner);
			await scheduler.drain(term);

			expect(visible(term)).toEqual(["msg-0", "msg-1", "msg-2", "spin-1"]);
			// The transcript subtree was reused, not re-rendered.
			expect(transcript.renders).toBe(transcriptRenders);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("downgrades to a full compose when a full request shares the frame", async () => {
		const term = new VirtualTerminal(40, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new CountingLines(["msg-0"]);
		const spinner = new CountingLines(["spin-0"]);
		tui.addChild(transcript);
		tui.addChild(spinner);

		try {
			tui.start();
			await scheduler.drain(term);
			const transcriptRenders = transcript.renders;

			// Both a component-scoped and a full request coalesce into one
			// frame; the full request wins regardless of arrival order.
			spinner.set(["spin-1"]);
			tui.requestComponentRender(spinner);
			transcript.set(["msg-0", "msg-edited"]);
			tui.requestRender();
			await scheduler.drain(term);

			expect(visible(term)).toEqual(["msg-0", "msg-edited", "spin-1"]);
			expect(transcript.renders).toBeGreaterThan(transcriptRenders);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("falls back to a full compose while an overlay is up", async () => {
		const term = new VirtualTerminal(40, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new CountingLines(["msg-0"]);
		const spinner = new CountingLines(["spin-0"]);
		tui.addChild(transcript);
		tui.addChild(spinner);

		try {
			tui.start();
			await scheduler.drain(term);
			tui.showOverlay(new CountingLines(["modal"]), { width: 10 });
			await scheduler.drain(term);
			const transcriptRenders = transcript.renders;

			spinner.set(["spin-1"]);
			tui.requestComponentRender(spinner);
			await scheduler.drain(term);

			// Unsafe condition: the frame rendered fully (and correctly).
			expect(transcript.renders).toBeGreaterThan(transcriptRenders);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("falls back to a full compose when the root child list changed", async () => {
		const term = new VirtualTerminal(40, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new CountingLines(["msg-0"]);
		const spinner = new CountingLines(["spin-0"]);
		tui.addChild(transcript);
		tui.addChild(spinner);

		try {
			tui.start();
			await scheduler.drain(term);

			// Structural change with only a component-scoped request pending:
			// the segment ledger no longer matches the root list, so the frame
			// must compose fully and paint the new child.
			tui.addChild(new CountingLines(["banner"]));
			spinner.set(["spin-1"]);
			tui.requestComponentRender(spinner);
			await scheduler.drain(term);

			expect(visible(term)).toEqual(["msg-0", "spin-1", "banner"]);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("falls back to a full compose when the component is not in the tree", async () => {
		const term = new VirtualTerminal(40, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new CountingLines(["msg-0"]);
		const status = new Container();
		const spinner = new CountingLines(["spin-0"]);
		status.addChild(spinner);
		tui.addChild(transcript);
		tui.addChild(status);

		try {
			tui.start();
			await scheduler.drain(term);
			const transcriptRenders = transcript.renders;

			// A detached component (cleared status container) can still fire a
			// trailing tick; the frame must not skip anything based on it.
			status.removeChild(spinner);
			tui.requestComponentRender(spinner);
			await scheduler.drain(term);

			expect(visible(term)).toEqual(["msg-0"]);
			expect(transcript.renders).toBeGreaterThan(transcriptRenders);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("replays the seam report of a skipped root child across partial frames", async () => {
		const term = new VirtualTerminal(40, 4, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const markers = Array.from({ length: 8 }, (_unused, i) => `ROW-${String(i).padStart(3, "0")}`);
		// All but the last head row are final; the tail row stays live.
		const head = new LiveHead([...markers, "streaming"]);
		head.setSeam(markers.length);
		const spinner = new CountingLines(["spin-0"]);
		tui.addChild(head);
		tui.addChild(spinner);

		try {
			tui.start();
			await scheduler.drain(term);
			const headRenders = head.renders;

			// Several spinner-only frames while the head (and its commit seam)
			// ride the reused segment.
			for (let tick = 1; tick <= 3; tick++) {
				spinner.set([`spin-${tick}`]);
				tui.requestComponentRender(spinner);
				await scheduler.drain(term);
			}
			expect(head.renders).toBe(headRenders);
			expect(visible(term).at(-1)).toBe("spin-3");

			// A later full frame must still commit exactly once: every final
			// row appears exactly once across history + grid, in order.
			head.set([...markers, "streamed-final", "tail"]);
			head.setSeam(markers.length + 2);
			tui.requestRender();
			await scheduler.drain(term);

			const buffer = strip(term.getScrollBuffer()).join("\n");
			const missing = markers.filter(mark => buffer.split(mark).length - 1 === 0);
			const duplicated = markers.filter(mark => buffer.split(mark).length - 1 > 1);
			expect(missing).toEqual([]);
			expect(duplicated).toEqual([]);
			const observed = Array.from(buffer.matchAll(/ROW-\d{3}/g), match => match[0]);
			expect(observed).toEqual(markers);
		} finally {
			tui.stop();
			await term.flush();
		}
	});
});

// Pending image data requires a complete compose before either shortcut can reuse
// segments. This covers transmit queues, not image demotion or purge scheduling.
describe("pending image data prevents composed-layout reuse", () => {
	it.each(["requestDirectWrite", "requestComponentRender"] as const)(
		"%s composes every root before committing queued image data",
		async request => {
			const term = new VirtualTerminal(40, 8, 1_000);
			const scheduler = new StressRenderScheduler();
			const tui = new RenderCountingTUI(term, undefined, { renderScheduler: scheduler });
			const transcript = new CountingLines(["message"]);
			const spinner = new CountingLines(["spin-0"]);
			tui.addChild(transcript);
			tui.addChild(spinner);
			try {
				tui.start();
				await scheduler.drain(term);
				const renders = tui.renders;
				const transcriptRenders = transcript.renders;
				const id = tui.imageBudget.acquireId();
				// One black RGB pixel, queued through the same budget API as Image.
				tui.imageBudget.enqueueTransmit(id, `\x1b_Ga=t,f=24,s=1,v=1,i=${id};AAAA\x1b\\`);
				spinner.set(["spin-1"]);
				tui[request](spinner);
				await scheduler.drain(term);
				expect(tui.renders).toBe(renders + 1);
				expect(transcript.renders).toBe(transcriptRenders + 1);
				expect(tui.imageBudget.hasPendingTransmits()).toBe(false);
				expect(visible(term)).toEqual(["message", "spin-1"]);
			} finally {
				tui.stop();
				await term.flush();
			}
		},
	);
});

describe("TUI.requestDirectWrite", () => {
	it("directly rewrites a visible unchanged-size root segment without a full render", async () => {
		const term = new VirtualTerminal(40, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new RenderCountingTUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new CountingLines(["msg-0", "msg-1"]);
		const spinner = new CountingLines(["spin-0"]);
		const footer = new CountingLines(["footer"]);
		tui.addChild(transcript);
		tui.addChild(spinner);
		tui.addChild(footer);

		try {
			tui.start();
			await scheduler.drain(term);
			expect(visible(term)).toEqual(["msg-0", "msg-1", "spin-0", "footer"]);
			const tuiRenders = tui.renders;
			const transcriptRenders = transcript.renders;
			const footerRenders = footer.renders;

			spinner.set(["spin-1"]);
			tui.requestDirectWrite(spinner);
			await scheduler.drain(term);

			expect(visible(term)).toEqual(["msg-0", "msg-1", "spin-1", "footer"]);
			expect(tui.renders).toBe(tuiRenders);
			expect(transcript.renders).toBe(transcriptRenders);
			expect(footer.renders).toBe(footerRenders);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("directly rewrites fully live anchored status segments", async () => {
		const term = new VirtualTerminal(40, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new RenderCountingTUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new CountingLines(["msg-0", "msg-1"]);
		const status = new AnchoredStatusContainer();
		const spinner = new CountingLines(["spin-0"]);
		status.addChild(spinner);
		tui.addChild(transcript);
		tui.addChild(status);

		try {
			tui.start();
			await scheduler.drain(term);
			expect(visible(term)).toEqual(["msg-0", "msg-1", "spin-0"]);
			const tuiRenders = tui.renders;
			const transcriptRenders = transcript.renders;

			spinner.set(["spin-1"]);
			tui.requestDirectWrite(spinner);
			await scheduler.drain(term);

			expect(visible(term)).toEqual(["msg-0", "msg-1", "spin-1"]);
			expect(tui.renders).toBe(tuiRenders);
			expect(transcript.renders).toBe(transcriptRenders);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("falls back to a full render while a visible overlay is up", async () => {
		const term = new VirtualTerminal(40, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new RenderCountingTUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new CountingLines(["msg-0"]);
		const spinner = new CountingLines(["spin-0"]);
		const footer = new CountingLines(["footer"]);
		tui.addChild(transcript);
		tui.addChild(spinner);
		tui.addChild(footer);

		try {
			tui.start();
			await scheduler.drain(term);
			tui.showOverlay(new CountingLines(["modal"]), { width: 5, anchor: "top-left" });
			await scheduler.drain(term);
			expect(visible(term)).toEqual(["modal", "spin-0", "footer"]);
			const tuiRenders = tui.renders;
			const transcriptRenders = transcript.renders;

			spinner.set(["spin-1"]);
			tui.requestDirectWrite(spinner);
			await scheduler.drain(term);
			expect(visible(term)).toEqual(["modal", "spin-1", "footer"]);
			expect(tui.renders).toBeGreaterThan(tuiRenders);
			expect(transcript.renders).toBeGreaterThan(transcriptRenders);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("falls back to a scheduled render while the alternate screen is active", async () => {
		const term = new VirtualTerminal(40, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new RenderCountingTUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new CountingLines(["msg-0"]);
		const spinner = new CountingLines(["spin-0"]);
		tui.addChild(transcript);
		tui.addChild(spinner);

		try {
			tui.start();
			await scheduler.drain(term);
			expect(visible(term)).toEqual(["msg-0", "spin-0"]);

			const overlay = new CountingLines(["fullscreen-modal"]);
			const handle = tui.showOverlay(overlay, { fullscreen: true });
			await scheduler.drain(term);
			expect(visible(term)).toEqual(["fullscreen-modal"]);

			// Direct write while alt is active must not perform a direct write
			// that corrupts the alt-screen viewport; it falls back to scheduled render.
			spinner.set(["spin-1"]);
			tui.requestDirectWrite(spinner);
			await scheduler.drain(term);
			expect(visible(term)).toEqual(["fullscreen-modal"]);

			// When the modal overlay closes, returning to the normal screen shows
			// the updated spinner state.
			handle.hide();
			await scheduler.drain(term);
			expect(visible(term)).toEqual(["msg-0", "spin-1"]);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("schedules direct writes for an alternate-screen transcript without an overlay", async () => {
		const term = new VirtualTerminal(40, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new RenderCountingTUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new CountingLines(Array.from({ length: 40 }, (_, index) => `history-${index}`));
		const spinner = new CountingLines(["spin-0"]);
		tui.addChild(transcript);
		tui.addChild(spinner);
		tui.setPinnedFooterChildCount(1);
		tui.setScrollTransport("mouse");
		tui.setScrollIsolation(false);
		try {
			tui.start();
			await scheduler.drain(term);
			tui.setScrollTransport("alt-arrows");
			tui.setScrollIsolation(true);
			await scheduler.drain(term);
			expect(visible(term).at(-1)).toBe("spin-0");
			const renders = tui.renders;
			const transcriptRenders = transcript.renders;
			spinner.set(["spin-1"]);
			tui.requestDirectWrite(spinner);
			await scheduler.drain(term);
			expect(tui.renders).toBe(renders + 1);
			expect(transcript.renders).toBe(transcriptRenders);
			expect(visible(term).at(-1)).toBe("spin-1");
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("falls back to an ordinary render when the root child list changed", async () => {
		const term = new VirtualTerminal(40, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new RenderCountingTUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new CountingLines(["msg-0"]);
		const spinner = new CountingLines(["spin-0"]);
		tui.addChild(transcript);
		tui.addChild(spinner);

		try {
			tui.start();
			await scheduler.drain(term);
			expect(visible(term)).toEqual(["msg-0", "spin-0"]);
			const tuiRenders = tui.renders;

			tui.removeChild(transcript);
			const newTranscript = new CountingLines(["msg-1"]);
			tui.addChild(newTranscript);

			spinner.set(["spin-1"]);
			tui.requestDirectWrite(spinner);
			await scheduler.drain(term);

			expect(visible(term)).toEqual(["spin-1", "msg-1"]);
			expect(tui.renders).toBeGreaterThan(tuiRenders);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("positions cursor at the bottom-most visible marker during direct write updates", async () => {
		const term = new VirtualTerminal(40, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new RenderCountingTUI(term, undefined, { renderScheduler: scheduler });
		const top = new CountingLines([`top ${CURSOR_MARKER}field`]);
		const spinner = new CountingLines(["spin-0"]);
		const bottom = new CountingLines([`bottom ${CURSOR_MARKER}input`]);
		tui.addChild(top);
		tui.addChild(spinner);
		tui.addChild(bottom);

		try {
			tui.start();
			await scheduler.drain(term);
			expect(term.getCursor()).toEqual({ row: 2, col: 7 });

			spinner.set(["spin-1"]);
			tui.requestDirectWrite(spinner);
			await scheduler.drain(term);

			expect(visible(term)).toEqual(["top field", "spin-1", "bottom input"]);
			expect(term.getCursor()).toEqual({ row: 2, col: 7 });
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("selects marker at windowTop boundary and ignores history markers during direct write", async () => {
		const term = new VirtualTerminal(40, 4, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new RenderCountingTUI(term, undefined, { renderScheduler: scheduler });
		// 6 rows total in 4-row viewport -> windowTop = 2
		const hist = new CountingLines([`hist0 ${CURSOR_MARKER}`, "hist1"]); // rows 0, 1
		const bound = new CountingLines([`bound ${CURSOR_MARKER}at-top`]); // row 2 (windowTop = 2)
		const body = new CountingLines(["body0", "body1"]); // rows 3, 4
		const spinner = new CountingLines(["spin-0"]); // row 5
		tui.addChild(hist);
		tui.addChild(bound);
		tui.addChild(body);
		tui.addChild(spinner);

		try {
			tui.start();
			await scheduler.drain(term);
			// Marker at row 2 sits at screen row 2 - 2 = 0
			expect(term.getCursor()).toEqual({ row: 0, col: 6 });

			spinner.set(["spin-1"]);
			tui.requestDirectWrite(spinner);
			await scheduler.drain(term);

			// Marker at windowTop boundary is selected at screen row 0, ignoring row 0
			expect(visible(term)).toEqual(["bound at-top", "body0", "body1", "spin-1"]);
			expect(term.getCursor()).toEqual({ row: 0, col: 6 });
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("completes direct write and ignores history markers when all markers are above windowTop", async () => {
		const term = new VirtualTerminal(40, 4, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new RenderCountingTUI(term, undefined, { renderScheduler: scheduler });
		// 6 rows total in 4-row viewport -> windowTop = 2
		const hist = new CountingLines([`hist0 ${CURSOR_MARKER}`, `hist1_unique_col_thirty_two_chars_${CURSOR_MARKER}`]);
		const plain = new CountingLines(["vis0", "vis1"]);
		const spinner = new CountingLines(["spin-0", "tail"]);
		tui.addChild(hist);
		tui.addChild(plain);
		tui.addChild(spinner);

		try {
			tui.start();
			await scheduler.drain(term);
			const rendersBeforeWrite = tui.renders;

			spinner.set(["spin-1", "tail"]);
			tui.requestDirectWrite(spinner);
			await scheduler.drain(term);

			expect(visible(term)).toEqual(["vis0", "vis1", "spin-1", "tail"]);
			expect(term.getCursor()).toEqual({ row: 2, col: 6 });
			expect(tui.renders).toBe(rendersBeforeWrite);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("completes direct write when no visible cursor marker exists in the frame", async () => {
		const term = new VirtualTerminal(40, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new RenderCountingTUI(term, undefined, { renderScheduler: scheduler });
		const transcript = new CountingLines(["msg-0", "msg-1"]);
		const spinner = new CountingLines(["spin-0"]);
		tui.addChild(transcript);
		tui.addChild(spinner);

		try {
			tui.start();
			await scheduler.drain(term);
			spinner.set(["spin-1"]);
			tui.requestDirectWrite(spinner);
			await scheduler.drain(term);

			expect(visible(term)).toEqual(["msg-0", "msg-1", "spin-1"]);
		} finally {
			tui.stop();
			await term.flush();
		}
	});
});

describe("TUI cursor marker selection", () => {
	it("positions the hardware cursor at the bottom-most visible marker in the window", async () => {
		const term = new VirtualTerminal(40, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const top = new CountingLines([`top ${CURSOR_MARKER}text`]);
		const mid = new CountingLines([`mid ${CURSOR_MARKER}middle`]);
		const bottom = new CountingLines([`bottom ${CURSOR_MARKER}field`]);
		tui.addChild(top);
		tui.addChild(mid);
		tui.addChild(bottom);

		try {
			tui.start();
			await scheduler.drain(term);
			const cursor = term.getCursor();
			expect(cursor.row).toBe(2);
			expect(cursor.col).toBe(7);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("selects marker at windowTop boundary and ignores markers in history above windowTop", async () => {
		const term = new VirtualTerminal(40, 4, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		// 6 rows total in 4-row viewport -> windowTop = 2
		const hist = new CountingLines([`hist0 ${CURSOR_MARKER}`, "hist1"]); // rows 0, 1
		const atBoundary = new CountingLines([`top-vis ${CURSOR_MARKER}first`]); // row 2 (screen row 0)
		const active = new CountingLines(["body", `live ${CURSOR_MARKER}here`]); // rows 3, 4 (screen row 2)
		const tail = new CountingLines(["tail"]); // row 5 (screen row 3)
		tui.addChild(hist);
		tui.addChild(atBoundary);
		tui.addChild(active);
		tui.addChild(tail);

		try {
			tui.start();
			await scheduler.drain(term);
			const cursor = term.getCursor();
			// Bottom-most visible marker is `active` at frame row 4 -> screen row 4 - 2 = 2
			expect(cursor.row).toBe(2);
			expect(cursor.col).toBe(5);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("ignores all markers when all markers sit in history above windowTop", async () => {
		const term = new VirtualTerminal(40, 4, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		// 6 rows total in 4-row viewport -> windowTop = 2
		const hist = new CountingLines([`hist0 ${CURSOR_MARKER}`, `hist1_unique_col_thirty_two_chars_${CURSOR_MARKER}`]);
		const plain = new CountingLines(["vis0", "vis1", "vis2", "vis3"]);
		tui.addChild(hist);
		tui.addChild(plain);

		try {
			tui.start();
			await scheduler.drain(term);
			expect(visible(term)).toEqual(["vis0", "vis1", "vis2", "vis3"]);
			expect(term.getCursor()).toEqual({ row: 3, col: 4 });
		} finally {
			tui.stop();
			await term.flush();
		}
	});
	it("renders cleanly when no component in the tree emits cursor markers", async () => {
		const term = new VirtualTerminal(40, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		tui.addChild(new CountingLines(["line0", "line1"]));

		try {
			tui.start();
			await scheduler.drain(term);
			expect(visible(term)).toEqual(["line0", "line1"]);
		} finally {
			tui.stop();
			await term.flush();
		}
	});
});

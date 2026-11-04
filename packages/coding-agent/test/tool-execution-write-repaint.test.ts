import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { ToolExecutionComponent } from "@veyyon/coding-agent/modes/terminal/components/transcript/tool-execution";
import { RAIL_SETTLE_FRAME_MS, RAIL_SETTLE_FRAMES } from "@veyyon/coding-agent/modes/terminal/draw/rail-motion";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { type Component, TUI } from "@veyyon/tui";
import { StressRenderScheduler } from "../../../hosts/terminal/engine/test/render-stress-scheduler";
import { VirtualTerminal } from "../../../hosts/terminal/engine/test/virtual-terminal";
import { createToolExecution } from "./helpers/tool-execution";

function writeArgs(lineCount: number) {
	return {
		path: "notes.txt",
		content: Array.from({ length: lineCount }, (_, i) => `line ${i + 1}`).join("\n"),
	};
}

function partialWriteResult(text = "Writing notes.txt...") {
	return { content: [{ type: "text", text }] };
}

class Footer implements Component {
	constructor(readonly rows: number) {}
	invalidate(): void {}
	render(_width: number): string[] {
		return Array.from({ length: this.rows }, (_, i) => `editor-${i}`);
	}
}

function plainBuffer(term: VirtualTerminal): string[] {
	return term
		.getScrollBuffer()
		.map(row => Bun.stripANSI(row).trimEnd())
		.filter(Boolean);
}

describe("ToolExecutionComponent write repaint seam", () => {
	const components: ToolExecutionComponent[] = [];

	beforeAll(async () => {
		await initTheme();
	});

	afterEach(() => {
		for (const component of components) component.stopAnimation();
		components.length = 0;
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	function makeComponent(args: unknown) {
		const resetDisplay = vi.fn();
		const ui = { requestRender() {}, requestComponentRender() {}, resetDisplay } as unknown as TUI;
		const component = createToolExecution("write", args, {}, undefined, ui);
		components.push(component);
		resetDisplay.mockClear();
		return { component, resetDisplay };
	}

	it("forces a viewport repaint when a painted collapsed tail window receives its first result", () => {
		// 20 lines > WRITE_STREAMING_PREVIEW_LINES (12): the pending preview is a
		// tail window the first-result render re-anchors to the top of the file.
		const { component, resetDisplay } = makeComponent(writeArgs(20));
		component.render(80);

		component.updateResult(partialWriteResult(), true);

		expect(resetDisplay).toHaveBeenCalledTimes(1);
	});

	it("does not repaint when the pending tail window never reaches the terminal", () => {
		const { component, resetDisplay } = makeComponent(writeArgs(20));
		// No render() before the result: a resetDisplay here would wipe native
		// scrollback for a shape the user never saw.

		component.updateResult(partialWriteResult(), true);

		expect(resetDisplay).not.toHaveBeenCalled();
	});

	it("does not repaint a collapsed preview that fits the streaming window", () => {
		// 12 lines render top-anchored without a tail window, so the first result
		// does not re-anchor the frame; wiping scrollback would be gratuitous.
		const { component, resetDisplay } = makeComponent(writeArgs(12));
		component.render(80);

		component.updateResult(partialWriteResult(), true);

		expect(resetDisplay).not.toHaveBeenCalled();
	});

	it("does not repaint an expanded pending preview", () => {
		// Expanded previews show the whole file top-anchored — no tail window to
		// re-anchor.
		const { component, resetDisplay } = makeComponent(writeArgs(20));
		component.setExpanded(true);
		component.render(80);

		component.updateResult(partialWriteResult(), true);

		expect(resetDisplay).not.toHaveBeenCalled();
	});

	it("removes stale pending tail rows from the terminal buffer when the first partial result arrives", async () => {
		// Fake timers so the rail settle animation a coloured live card plays after
		// its final result can be run to its end below; the stress scheduler drains
		// renders but never advances a real interval.
		vi.useFakeTimers();
		const term = new VirtualTerminal(80, 8, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		const component = createToolExecution("write", writeArgs(20), {}, undefined, tui);
		components.push(component);
		tui.addChild(component);
		tui.addChild(new Footer(5));

		try {
			tui.start();
			await scheduler.drain(term);
			const pendingRows = plainBuffer(term);
			// Counted rather than merely present, for the same reason as the SSH
			// repaint suite: the bug this exists to catch is a frame drawn a second
			// time below the first, and `some(...)` is true whether the row was
			// repainted in place or duplicated. The card is live and taller than the
			// three rows above the editor, so only its tail is on screen: its earlier
			// rows, the host's elision note among them, are not final and never
			// enter native scrollback.
			expect(pendingRows.filter(row => row.includes("earlier lines"))).toHaveLength(0);
			expect(pendingRows.filter(row => row.includes("… (streaming)"))).toHaveLength(1);
			expect(pendingRows.filter(row => row.includes("20 line 20"))).toHaveLength(1);

			component.setArgsComplete();
			tui.requestRender();
			await scheduler.drain(term);

			component.updateResult(partialWriteResult(), true);
			tui.requestRender();
			await scheduler.drain(term);

			const rows = plainBuffer(term);
			// The stale pending tail window must not survive above the new frame.
			expect(rows.some(row => row.includes("… (streaming)"))).toBe(false);
			expect(rows.some(row => row.includes("earlier lines"))).toBe(false);
			expect(rows.some(row => row.includes("20 line 20"))).toBe(false);
			// The first partial-result frame's tail is what the window shows: the
			// top-anchored preview's last line and its continuation note.
			expect(rows.filter(row => row.includes("  6 line 6"))).toHaveLength(1);
			expect(rows.filter(row => row.includes("… 14 more lines"))).toHaveLength(1);

			component.updateResult(partialWriteResult("Wrote notes.txt"), false);
			// A card that streamed under a coloured rail settles for RAIL_SETTLE_FRAMES
			// frames and stays in the live region until the last one. With no colour
			// (NO_COLOR) there is no rail to animate and the card is final at once.
			vi.advanceTimersByTime(RAIL_SETTLE_FRAME_MS * RAIL_SETTLE_FRAMES);
			tui.requestRender();
			await scheduler.drain(term);

			// Settled, the card is final and enters native scrollback whole and
			// once, with nothing of the pending tail window above it.
			const settledRows = plainBuffer(term);
			expect(settledRows.some(row => row.includes("… (streaming)"))).toBe(false);
			expect(settledRows.some(row => row.includes("20 line 20"))).toBe(false);
			expect(settledRows.filter(row => row.includes("Write: notes.txt"))).toHaveLength(1);
			expect(settledRows.filter(row => row.includes("  1 line 1"))).toHaveLength(1);
			expect(settledRows.filter(row => row.includes("  6 line 6"))).toHaveLength(1);
			expect(settledRows.filter(row => row.includes("… 14 more lines"))).toHaveLength(1);
		} finally {
			tui.stop();
			await term.flush();
		}
	});
});

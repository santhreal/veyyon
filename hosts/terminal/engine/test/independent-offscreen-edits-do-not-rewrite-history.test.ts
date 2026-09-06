import { describe, expect, it } from "bun:test";
import { type Component, type NativeScrollbackLiveRegion, TUI } from "@veyyon/tui";
import { settleFrames } from "./helpers/settle-frames";
import { VirtualTerminal } from "./virtual-terminal";

/**
 * Independent accepted edits must not accumulate into a false row shift and an
 * erase-and-replay of history under a scrolled reader. Exercise the real TUI
 * against the terminal parser, including frozen rows becoming final and a real
 * insertion after accepted edits. This does not infer native scroll position or
 * change the existing policy for simultaneous multi-row structural divergence.
 */
class Rows implements Component, NativeScrollbackLiveRegion {
	lines = Array.from({ length: 16 }, (_, index) => `row-${index}`);
	seam: number | undefined;

	invalidate(): void {}

	render(): readonly string[] {
		return this.lines;
	}

	getNativeScrollbackLiveRegionStart(): number | undefined {
		return this.seam;
	}

	edit(index: number): void {
		this.lines = this.lines.map((line, row) => (row === index ? `${line}-界` : line));
	}
}

function buffer(term: VirtualTerminal): string[] {
	return term.getScrollBuffer().map(line => line.trimEnd());
}

describe("independent offscreen edits preserve committed history", () => {
	it.each([false, true])(
		"preserves plain history with an unrelated finalization component: %s",
		async withFinalization => {
			const term = new VirtualTerminal(32, 4);
			const tui = new TUI(term);
			tui.setScrollbackRebuild(false);
			let leading = Array.from({ length: 16 }, (_, index) => `leading-${index}`);
			const following = Array.from({ length: 8 }, (_, index) => `following-${index}`);
			try {
				tui.addChild({ render: () => leading, invalidate() {} });
				tui.addChild({ render: () => following, invalidate() {} });
				if (withFinalization) {
					const unrelated = new Rows();
					unrelated.lines = [];
					tui.addChild(unrelated);
				}
				tui.start();
				await settleFrames(term, tui);
				term.scrollLines(-3);
				const position = term.getBufferPosition();
				const historyVisible = position.baseY - position.viewportY;
				const view = term.getViewport();
				expect(view.map(line => line.trimEnd())).toEqual(following.slice(1, 5));
				for (let index = 0; index < following.length; index++) {
					leading = [...leading, `append-${index}`];
					tui.requestRender();
					await settleFrames(term, tui);
					expect(term.getBufferPosition().viewportY).toBe(position.viewportY);
					// Only the committed portion is immutable; the live row may repaint.
					expect(term.getViewport().slice(0, historyVisible)).toEqual(view.slice(0, historyVisible));
				}
				tui.requestRender(true, { clearScrollback: true });
				await settleFrames(term, tui);
				expect(buffer(term)).toEqual([...leading, ...following]);
			} finally {
				tui.stop();
			}
		},
	);

	it("keeps every committed row unchanged across successive edits and still appends new output", async () => {
		const term = new VirtualTerminal(32, 4);
		const tui = new TUI(term);
		const rows = new Rows();
		try {
			tui.addChild(rows);
			tui.start();
			await settleFrames(term, tui);
			const original = buffer(term);
			const historyRows = term.getBufferPosition().baseY;
			expect(historyRows).toBe(12);
			term.scrollLines(-3);
			const position = term.getBufferPosition();
			const view = term.getViewport();
			for (let index = historyRows - 1; index >= 0; index--) {
				rows.edit(index);
				tui.requestRender();
				await settleFrames(term, tui);
				expect(term.getBufferPosition()).toEqual(position);
				expect(term.getViewport()).toEqual(view);
				expect(buffer(term)).toEqual(original);
			}
			term.scrollLines(historyRows);
			rows.lines = [...rows.lines, "new-output"];
			tui.requestRender();
			await settleFrames(term, tui);
			expect(buffer(term)).toEqual([...original, "new-output"]);
		} finally {
			tui.stop();
		}
	});

	it("retains frozen snapshots until their source becomes final", async () => {
		const term = new VirtualTerminal(32, 4);
		const tui = new TUI(term);
		const rows = new Rows();
		rows.seam = 6;
		try {
			tui.addChild(rows);
			tui.start();
			await settleFrames(term, tui);
			const original = buffer(term);
			for (let index = 0; index < term.getBufferPosition().baseY; index++) {
				rows.edit(index);
				tui.requestRender();
				await settleFrames(term, tui);
				expect(buffer(term)).toEqual(original);
			}
			rows.seam = Number.POSITIVE_INFINITY;
			tui.requestRender();
			await settleFrames(term, tui);
			expect(buffer(term)).toEqual(rows.lines);
		} finally {
			tui.stop();
		}
	});

	it("still reconciles a real insertion after accepting independent edits", async () => {
		const term = new VirtualTerminal(32, 4);
		const tui = new TUI(term);
		const rows = new Rows();
		try {
			tui.addChild(rows);
			tui.start();
			await settleFrames(term, tui);
			for (let index = 11; index >= 8; index--) {
				rows.edit(index);
				tui.requestRender();
				await settleFrames(term, tui);
			}
			rows.lines = [...rows.lines.slice(0, 3), "inserted", ...rows.lines.slice(3)];
			tui.requestRender();
			await settleFrames(term, tui);
			expect(buffer(term)).toEqual(rows.lines);
		} finally {
			tui.stop();
		}
	});
});

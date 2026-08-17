// SCRATCH PROBE (not a shipped test): does the pinned footer ever land on the
// screen twice, with two DIFFERENT spinner frames?
//
// Hypothesis under test: the scroll-isolation composite at tui.ts:4020-4030
// builds `#scrollSnapshot` as `[...scrollTape, ...frame.slice(committedRows)]`,
// which INCLUDES the pinned footer as it looked when the view froze. The frozen
// region reads that array with no exclusion of the footer band, and the only
// guard (tui.ts:3984, `virtualScrollTop >= liveTop` -> resume) measures the LIVE
// scroll space, which grows while the snapshot does not. Grow the frame while
// frozen, walk back down toward the tail, and the stale footer walks into the
// region directly above the live one.

import { describe, expect, it } from "bun:test";
import { type Component, CURSOR_MARKER, type Focusable, TUI } from "@veyyon/tui";
import { StressRenderScheduler } from "../packages/tui/test/render-stress-scheduler";
import { VirtualTerminal } from "../packages/tui/test/virtual-terminal";

class Transcript implements Component {
	lines: string[] = [];
	invalidate(): void {}
	render(_width: number): readonly string[] {
		return this.lines;
	}
}

/** The composer loader row: one spinner glyph, advanced by the caller. */
class Loader implements Component {
	frame = 0;
	static readonly GLYPHS = ["A", "B", "C", "D"];
	invalidate(): void {}
	render(_width: number): readonly string[] {
		return [`${Loader.GLYPHS[this.frame % Loader.GLYPHS.length]} working`];
	}
}

class Editor implements Component, Focusable {
	focused = false;
	text = ">";
	invalidate(): void {}
	setUseTerminalCursor(): void {}
	handleInput(data: string): void {
		this.text = `> ${data}`;
	}
	render(_width: number): readonly string[] {
		return [this.text + CURSOR_MARKER];
	}
}

class Status implements Component {
	invalidate(): void {}
	render(_width: number): readonly string[] {
		return ["status-footline"];
	}
}

const WHEEL_UP = "\x1b[<64;5;5M";
const WHEEL_DOWN = "\x1b[<65;5;5M";

function rows(prefix: string, n: number): string[] {
	return Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(3, "0")}`);
}

function viewport(term: VirtualTerminal, width = 40): string[] {
	return term.getViewport().map(row =>
		Bun.stripANSI(row)
			.padEnd(width, " ")
			.slice(0, width - 1)
			.trimEnd(),
	);
}

describe("footer double-print probe", () => {
	it("shows the frozen footer above the live footer once the frame grows under a frozen view", async () => {
		const term = new VirtualTerminal(40, 10, 1_000);
		const scheduler = new StressRenderScheduler();
		const tui = new TUI(term, true, { renderScheduler: scheduler });
		const transcript = new Transcript();
		const loader = new Loader();
		const editor = new Editor();
		const status = new Status();
		tui.addChild(transcript);
		tui.addChild(loader);
		tui.addChild(editor);
		tui.addChild(status);
		tui.setFocus(editor);
		tui.setScrollIsolation(true);
		tui.setPinnedFooterChildCount(3); // loader + composer + status
		transcript.lines = rows("hist-", 30);
		tui.start();
		await scheduler.drain(term);

		try {
			// Freeze the view one wheel step above the live tail.
			expect(tui.scrollByRows(-3)).toBe(true);
			await scheduler.drain(term);
			expect(tui.virtualScrollActive).toBe(true);
			const frozenAt = viewport(term);

			// A live turn streams six more transcript rows while the view is
			// frozen, and the spinner advances with it.
			const redrawsBefore = tui.fullRedraws;
			for (let i = 0; i < 6; i++) {
				transcript.lines = [...transcript.lines, `hist-new-${i}`];
				loader.frame += 1;
				tui.requestRender();
				await scheduler.drain(term);
			}
			console.log("newRows behind the tail:", tui.virtualScrollNewRows);
			console.log("full redraws over 6 frozen frames:", tui.fullRedraws - redrawsBefore);

			// Walk back down toward the tail without reaching it.
			expect(tui.scrollByRows(3)).toBe(true);
			await scheduler.drain(term);
			expect(tui.scrollByRows(3)).toBe(true);
			await scheduler.drain(term);
			expect(tui.virtualScrollActive).toBe(true);

			const view = viewport(term);
			console.log(`frozen at:\n${frozenAt.map((r, i) => `${i}: ${r}`).join("\n")}`);
			console.log(`after growth + wheel down:\n${view.map((r, i) => `${i}: ${r}`).join("\n")}`);

			const loaderRows = view.filter(r => /working$/.test(r));
			const statusRows = view.filter(r => r === "status-footline");
			console.log("loader rows on screen:", loaderRows, "status rows:", statusRows.length);
			expect(loaderRows.length).toBe(2);
			expect(statusRows.length).toBe(2);
		} finally {
			tui.stop();
			await term.flush();
		}
	});
});

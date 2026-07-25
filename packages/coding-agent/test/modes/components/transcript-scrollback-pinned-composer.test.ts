import { beforeAll, describe, expect, it } from "bun:test";
import { ComposerShortcutsBar } from "@veyyon/coding-agent/modes/components/composer-shortcuts";
import { TranscriptContainer } from "@veyyon/coding-agent/modes/components/transcript-container";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { type Component, CURSOR_MARKER, type Focusable, TUI } from "@veyyon/tui";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal";

/**
 * Reading history with the REAL `TranscriptContainer` mounted: the composer must
 * stay on screen and must not change.
 *
 * The engine's own suites drive a stand-in transcript, so this file is what
 * proves the production component's virtualization (it hands committed rows to
 * native scrollback and then drops them from its frame) actually cooperates with
 * scroll isolation. Under the old engine the wheel was released as soon as that
 * dropping trimmed the frame back to the viewport, and scrolling handed the
 * whole window to the terminal, taking the prompt with it — reported by the
 * operator on 2026-07-24 as "the composer doesn't come with you".
 */

const WIDTH = 60;
const HEIGHT = 12;
const WHEEL_UP = "\x1b[<64;5;5M";

beforeAll(async () => {
	await initTheme(false, "unicode", false, "titanium", "dark");
});

/** A finalized transcript block: plain components are final by default, so its
 * rows become commit-eligible history exactly like a settled message. */
class Block implements Component {
	constructor(private readonly lines: string[]) {}
	invalidate(): void {}
	render(_width: number): string[] {
		return this.lines;
	}
}

/** The composer zone: the shortcut band plus an editor row with the cursor. */
class Composer implements Component, Focusable {
	focused = false;
	text = "› ask anything";
	invalidate(): void {}
	setUseTerminalCursor(): void {}
	handleInput(): void {}
	render(_width: number): string[] {
		return [this.text + CURSOR_MARKER];
	}
}

interface Rig {
	term: VirtualTerminal;
	tui: TUI;
	transcript: TranscriptContainer;
	composer: Composer;
	band: ComposerShortcutsBar;
	settle: () => Promise<void>;
}

async function conversation(turns: number): Promise<Rig> {
	const term = new VirtualTerminal(WIDTH, HEIGHT, 5_000);
	const tui = new TUI(term, true);
	tui.setScrollbackRebuild(false); // the shipped default, stated: it is env-derived
	const transcript = new TranscriptContainer();
	const band = new ComposerShortcutsBar();
	const composer = new Composer();
	band.setShortcuts([{ label: "esc interrupt" }]);
	tui.addChild(transcript);
	tui.addChild(composer);
	tui.addChild(band);
	tui.setFocus(composer);
	tui.setScrollIsolation(true);
	tui.setPinnedFooterChildCount(2); // composer + band, as mountComposerZone reports
	tui.start();

	// These cases drive the PRODUCTION scheduler (the real interactive path), so
	// a fixed sleep can return mid-flight and read a half-applied frame. Settle
	// converges instead: pump until the engine's own state stops moving.
	const settle = async () => {
		let previous = "";
		for (let attempt = 0; attempt < 40; attempt++) {
			await new Promise(resolve => setTimeout(resolve, 12));
			await term.flush();
			const current = `${tui.virtualScrollNewRows}/${tui.composedFrameRows}/${tui.scrollTapeRows}/${tui.committedRows}`;
			if (current === previous) return;
			previous = current;
		}
		throw new Error("frame never settled");
	};
	await settle();
	for (let turn = 0; turn < turns; turn++) {
		transcript.addChild(new Block([`› turn ${turn}`, "", `  reply body for turn ${turn}`, ""]));
		tui.requestRender();
		await settle();
	}
	return { term, tui, transcript, composer, band, settle };
}

/** Viewport rows with styling stripped. */
function view(term: VirtualTerminal): string[] {
	return term.getViewport().map(r => Bun.stripANSI(r).trimEnd());
}

/** Viewport rows with the scroll-track column dropped. */
function content(term: VirtualTerminal): string[] {
	return term.getViewport().map(r =>
		Bun.stripANSI(r)
			.padEnd(WIDTH, " ")
			.slice(0, WIDTH - 1)
			.trimEnd(),
	);
}

describe("reading history with the real transcript mounted", () => {
	it("keeps the composer on screen and scrolls back to the first turn", async () => {
		const { term, tui, settle } = await conversation(14);
		try {
			// Precondition: this is the virtualized state — history is in the
			// terminal's scrollback and on the engine's tape, not in the frame.
			expect(tui.scrollTapeRows).toBeGreaterThan(HEIGHT);
			const bottom = view(term)[HEIGHT - 1];

			for (let i = 0; i < 40; i++) {
				term.sendInput(WHEEL_UP);
				await settle();
			}

			expect(tui.virtualScrollActive).toBe(true);
			expect(content(term)[0]).toBe("› turn 0"); // the first turn of the session
			// The composer is still the bottom row, unchanged.
			expect(view(term)[HEIGHT - 1]).toBe(bottom);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("stops at the oldest row instead of drifting, and stays frozen there", async () => {
		// The clamp boundary with the real container: once the view is at the top of
		// the tape, more ticks are a no-op — they must not resume following, shift
		// the region, or move the composer.
		const { term, tui, settle } = await conversation(14);
		try {
			for (let i = 0; i < 40; i++) {
				term.sendInput(WHEEL_UP);
				await settle();
			}
			const atTop = content(term);
			const bottom = view(term)[HEIGHT - 1];
			expect(atTop[0]).toBe("› turn 0");

			for (let i = 0; i < 5; i++) {
				term.sendInput(WHEEL_UP);
				await settle();
			}
			expect(content(term)).toEqual(atTop);
			expect(view(term)[HEIGHT - 1]).toBe(bottom);
			expect(tui.virtualScrollActive).toBe(true);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("renders the composer zone byte-identically frozen and following", async () => {
		// The second half of the report: the prompt must not CHANGE either. The
		// band keeps its own chips, so both footer rows match byte for byte.
		const { term, tui, settle } = await conversation(14);
		try {
			const following = term.getViewport().slice(HEIGHT - 2);
			expect(Bun.stripANSI(following[0]!)).toContain("ask anything");

			term.sendInput(WHEEL_UP);
			await settle();

			expect(tui.virtualScrollActive).toBe(true);
			expect(term.getViewport().slice(HEIGHT - 2)).toEqual(following);
			expect(Bun.stripANSI(following.join("\n"))).toContain("interrupt");
			expect(Bun.stripANSI(following.join("\n"))).not.toContain("rows up");
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("holds the frozen history still while the transcript keeps compacting", async () => {
		// The container drops committed rows on quiet frames too, so a view read
		// from the live frame would slide under the reader on every repaint.
		const { term, tui, settle } = await conversation(14);
		try {
			for (let i = 0; i < 6; i++) {
				term.sendInput(WHEEL_UP);
				await settle();
			}
			// Freeze only once the scroll has actually engaged. This suite has flaked
			// under a loaded full-package run (once in ~20000 tests, green 3/3 alone),
			// and the two candidate causes are very different: either the wheel input
			// had not taken effect when the snapshot was captured, or a later repaint
			// genuinely moved the view. Asserting the state here separates them, so
			// the next occurrence reports which one it was instead of an opaque
			// row-array mismatch.
			expect(tui.virtualScrollActive).toBe(true);
			const frozen = content(term).slice(0, HEIGHT - 2);

			for (let i = 0; i < 3; i++) {
				tui.requestRender();
				await settle();
			}
			expect(content(term).slice(0, HEIGHT - 2)).toEqual(frozen);
			expect(tui.virtualScrollActive).toBe(true);
		} finally {
			tui.stop();
			await term.flush();
		}
	});

	it("keeps new turns out of the frozen view and follows again on submit", async () => {
		// Streaming while you read: the region holds, the composer stays live, and
		// the host's submit hook returns to the tail with the new turn on screen.
		const { term, tui, transcript, settle } = await conversation(14);
		try {
			for (let i = 0; i < 6; i++) {
				term.sendInput(WHEEL_UP);
				await settle();
			}
			const frozen = content(term)[0];

			transcript.addChild(new Block(["› turn 99", "", "  reply body for turn 99", ""]));
			tui.requestRender();
			await settle();
			expect(content(term)[0]).toBe(frozen); // the stream did not move the view
			expect(tui.virtualScrollNewRows).toBeGreaterThan(0);

			tui.scrollToLiveTail();
			await settle();
			expect(tui.virtualScrollActive).toBe(false);
			expect(view(term).join("\n")).toContain("turn 99");
		} finally {
			tui.stop();
			await term.flush();
		}
	});
});

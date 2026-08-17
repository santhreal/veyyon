// A turn that ends short, in a REAL terminal, live.
//
// The defect this belongs to: a session that has scrolled, whose last turn ends
// SHORT (a tall streaming answer settling to its final two-row tail), painted a
// screen-sized band of blank rows where the conversation was — a stray fence and
// rule floating over the HUD with nothing above them.
//
// Both components that decide that screen are here, unmocked: the real
// `TranscriptContainer` (which hands committed rows to native scrollback and used
// to drop every one of them) and the real `HomeAnchorLayout` (which measures
// viewport slack off the composed frame). The engine is the real `TUI` writing
// real escapes to a real tty through `ProcessTerminal`.
//
//   bun scripts/demos/blank-band-repro.ts [--turns 24] [--stream 30] [--hud 5]
//   DIAG_PATH=/tmp/diag.txt bun scripts/demos/blank-band-repro.ts   # + accounting
//
// WHAT THIS IS NOT. It is not a two-arm comparison, and it was measured before
// that was written here. Driven from this script the transcript never reaches the
// compaction path at all — `committedRows=104` against a frame of 128 rows, the
// same numbers with the retention floor fed and with it forced to zero — so
// turning the fix off changes nothing you can see. The byte-level before/after
// lives where the frame can be driven a frame at a time: the paint-sim arm in
// `a-turn-that-ends-short-never-paints-a-blank-band-over-the-conversation`, which
// measures a 23-row band collapsing to 1 and is mutation-gated. What this script
// is good for is watching the shipped path run against a real terminal and
// reading its frame accounting through `DIAG_PATH`.

import { type Component, CURSOR_MARKER, type Focusable, ProcessTerminal, TUI } from "@veyyon/tui";
import { TranscriptContainer } from "../../packages/coding-agent/src/modes/components/transcript-container";
import { HomeAnchorLayout } from "../../packages/coding-agent/src/modes/controllers/home-anchor-layout";
import { initTheme } from "../../packages/coding-agent/src/modes/theme/theme";

const args = process.argv.slice(2);

function flag(name: string, fallback: number): number {
	const at = args.indexOf(`--${name}`);
	if (at === -1) return fallback;
	const value = Number(args[at + 1]);
	return Number.isFinite(value) ? value : fallback;
}

const TURNS = flag("turns", 24);
const DELAY_MS = flag("delay", 160);
/** Rows the streaming answer grows to before it settles to its short tail. */
const STREAM = flag("stream", 30);
/** Rows of pinned HUD under the transcript — the todo list and subagent tree. */
const HUD = flag("hud", 5);

/** A finalized transcript block: plain components are final, so rows commit. */
class Block implements Component {
	constructor(private readonly lines: string[]) {}
	invalidate(): void {}
	render(): string[] {
		return this.lines;
	}
}

/**
 * The answer that ends short. It grows a row at a time while it streams, then
 * `settle()` replaces the whole thing with the two rows a finished block really
 * leaves behind — a closing fence and a rule. Until then it declares itself
 * unfinalized, which is what keeps its streamed rows out of the commit.
 */
class SettlingBlock implements Component {
	#rows: string[] = ["  ```"];
	#settled = false;
	invalidate(): void {}
	grow(): void {
		this.#rows = [...this.#rows, `  and row ${this.#rows.length} of the answer arrives while the tail moves.`];
	}
	settle(): void {
		this.#rows = ["  ```", "  —"];
		this.#settled = true;
	}
	isTranscriptBlockFinalized(): boolean {
		return this.#settled;
	}
	getRenderStablePrefixRows(): number {
		return 0;
	}
	render(): string[] {
		return this.#rows;
	}
}

class Hud implements Component {
	constructor(private readonly rows: number) {}
	invalidate(): void {}
	render(): string[] {
		if (this.rows <= 0) return [];
		return [
			"  ▪ Todo list done · 51 tasks",
			"  Subagents",
			"    ├ GitBenchAndHardening",
			"    └ GuardUXAndBufferOpt",
			"",
		].slice(0, this.rows);
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

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function main(): Promise<void> {
	await initTheme(false, "unicode", false, "titanium", "dark");
	const terminal = new ProcessTerminal();
	const tui = new TUI(terminal, true);
	// The shipped default: it is what makes a misread frame destructive.
	tui.setScrollbackRebuild(true);

	const transcript = new TranscriptContainer();
	const anchor = new HomeAnchorLayout({
		ui: tui,
		transcriptChildCount: () => transcript.children.length,
		hasHero: () => false,
	});
	// The shipped root order (interactive-mode): fills around the transcript,
	// HUD under it, composer pinned last.
	tui.addChild(anchor.topFill);
	tui.addChild(transcript);
	tui.addChild(new Hud(HUD));
	tui.addChild(anchor.bottomFill);
	tui.addChild(new Composer());
	tui.setPinnedFooterChildCount(1);
	tui.onFrameComposed = () => anchor.onFrameComposed();
	tui.start();

	for (let turn = 1; turn <= TURNS; turn++) {
		transcript.addChild(
			new Block([
				`> turn ${turn}: what changed in the renderer?`,
				"",
				`  reply ${turn}: the engine committed these rows to scrollback,`,
				"  and the transcript spliced them out of its own frame.",
				"",
			]),
		);
		tui.requestRender();
		await sleep(DELAY_MS);
	}

	// The turn that ends short: a tall answer streams in, then settles to two
	// rows. This is the frame the band was painted on.
	const answer = new SettlingBlock();
	transcript.addChild(answer);
	for (let row = 0; row < STREAM; row++) {
		answer.grow();
		tui.requestRender();
		await sleep(70);
	}
	await sleep(600);
	answer.settle();
	tui.requestRender();
	await sleep(700);

	// The frame accounting behind whatever is on screen, so the arm can be read
	// as numbers and not only looked at. DIAG_PATH is set by the recorder.
	const diag = process.env.DIAG_PATH;
	if (diag !== undefined) {
		await Bun.write(
			diag,
			`committedRows=${tui.committedRows} scrollTapeRows=${tui.scrollTapeRows} composedFrameRows=${tui.composedFrameRows} topFill=${anchor.topFill.render(terminal.columns).length} bottomFill=${anchor.bottomFill.render(terminal.columns).length} rows=${terminal.rows}\n`,
		);
	}

	// Hold the settled screen. This is the frame to look at and to scroll back
	// from: with the fix the conversation runs to the composer on the bottom
	// row, without it the rows above the tail are blank.
	await sleep(60_000);
	tui.stop();
}

await main();

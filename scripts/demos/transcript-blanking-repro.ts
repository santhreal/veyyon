// Drive the transcript-blanking defect in a REAL terminal, live.
//
// The fix (`fix(tui): keep the transcript when a virtualized root compacts`)
// came out of a failing regression suite against a virtual terminal. A suite
// proves the mechanism; it does not show anyone the symptom. This script is the
// same conversation against the same production components — the real
// `TranscriptContainer`, the real `TUI` engine, the real `ProcessTerminal` —
// writing real escape sequences to a real tty, so the defect can be recorded as
// video and the two arms compared side by side.
//
// Run it against the code WITH the fix and against the code without it. The
// arm without the fix erases native scrollback (ED3) every few turns, so
// scrolling back finds a handful of rows where the whole conversation should
// be. The arm with the fix keeps every turn.
//
//   bun scripts/demos/transcript-blanking-repro.ts [--turns 14] [--delay 450]
//
// Nothing here is a mock: the only thing standing in for a model is the text of
// each turn, because the defect is driven by output volume against a short
// viewport and not by where the bytes came from.

import { type Component, CURSOR_MARKER, type Focusable, ProcessTerminal, TUI } from "@veyyon/tui";
import { TranscriptContainer } from "../../packages/coding-agent/src/modes/components/transcript-container";
import { initTheme } from "../../packages/coding-agent/src/modes/theme/theme";

const args = process.argv.slice(2);
function flag(name: string, fallback: number): number {
	const index = args.indexOf(`--${name}`);
	if (index === -1) return fallback;
	const value = Number(args[index + 1]);
	return Number.isFinite(value) ? value : fallback;
}

const TURNS = flag("turns", 14);
const DELAY_MS = flag("delay", 450);
// Rows of a root child mounted ABOVE the transcript. The shipped layout always
// has one (`home-anchor-layout` fills the slack with `topFill`, and the todo and
// subagent HUDs sit in the same band), and the commit slide used to assume the
// transcript started at frame row 0, so the header is what the defect needs.
const HEADER = flag("header", 2);
// Rows of a still-arriving answer streamed after the finalized turns.
const STREAM = flag("stream", 45);

/** A finalized transcript block: plain components are final, so rows commit. */
class Block implements Component {
	constructor(private readonly lines: string[]) {}
	invalidate(): void {}
	render(): string[] {
		return this.lines;
	}
}

/** An answer still arriving: it grows a row at a time and never finalizes. */
class LiveBlock implements Component {
	#rows: string[] = ["  reply: the engine slides its commit coordinates while this grows,"];
	invalidate(): void {}
	grow(): void {
		this.#rows = [...this.#rows, `  and row ${this.#rows.length} arrives under a two-row header.`];
	}
	getRenderStablePrefixRows(): number {
		return 0;
	}
	render(): string[] {
		return this.#rows;
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
	// The shipped default. It is the knob that makes a misread divergence
	// destructive rather than merely wasteful.
	tui.setScrollbackRebuild(true);
	if (HEADER > 0) {
		tui.addChild(new Block(Array.from({ length: HEADER }, (_, row) => (row === 0 ? "  veyyon · demo session" : ""))));
	}
	const transcript = new TranscriptContainer();
	tui.addChild(transcript);
	tui.addChild(new Composer());
	tui.setPinnedFooterChildCount(1);
	tui.start();

	for (let turn = 1; turn <= TURNS; turn++) {
		transcript.addChild(
			new Block([
				`> turn ${turn}: what changed in the renderer?`,
				"",
				`  reply ${turn}: the engine committed these rows to scrollback,`,
				`  and the transcript spliced them out of its own frame.`,
				"",
			]),
		);
		tui.requestRender();
		await sleep(DELAY_MS);
	}

	// Then an answer that is still arriving. A finalized turn commits in one
	// step; a live block re-renders every frame while the rows under it keep
	// moving, which is when the engine slides its commit coordinates and when a
	// slide that assumes the transcript starts at row 0 tears the screen.
	const live = new LiveBlock();
	transcript.addChild(live);
	for (let row = 0; row < STREAM; row++) {
		live.grow();
		tui.requestRender();
		await sleep(90);
	}

	// Hold the finished session on screen. The recording scene scrolls the
	// terminal's own scrollback (shift+PageUp) from here: that is where the two
	// arms differ, and it is the only place the defect is visible at all.
	await sleep(60_000);
	tui.stop();
}

await main();

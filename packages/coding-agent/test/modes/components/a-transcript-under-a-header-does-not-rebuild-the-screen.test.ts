/**
 * A transcript that does not start at row 0 still repaints differentially.
 *
 * WHAT THIS CLOSES. `TranscriptContainer` drops rows the engine reported
 * committed, and the engine slides its commit coordinates onto the shortened
 * frame afterwards. That slide spliced the dropped rows off the FRONT of the
 * recorded prefix, which is only correct when the virtualized child is the
 * first root child. It is not: `home-anchor-layout` mounts a `topFill` above
 * the transcript whenever a conversation exists, and every HUD (todos,
 * subagents) sits in that band too. With a header of two rows the prefix ended
 * up misaligned by exactly the header height, the next audit read that as a
 * committed-prefix divergence, and the repair erased native scrollback and
 * replayed the transcript — measured here at 20 full redraws and 20 ED3 erases
 * over 40 streaming frames, which on a real terminal is the screen tearing
 * itself apart while the answer streams.
 *
 * THE CLASS, not the incident. The invariant is that WHERE the dropping child
 * sits among its siblings cannot change whether a frame is destructive, so the
 * sweep drives identical traffic at header 0, 2 and 5 and pins redraws and
 * erases to zero in all of them.
 *
 * WHAT IT DOES NOT CATCH. One width and one height, a single dropping child,
 * and no second virtualized sibling below the first; nor a multiplexer pane,
 * where the divergence rebuild is gated off entirely.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { TranscriptContainer } from "@veyyon/coding-agent/modes/components/transcript-container";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { type Component, CURSOR_MARKER, type Focusable, TUI } from "@veyyon/tui";
import { settleFrames } from "../../../../tui/test/helpers/settle-frames";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal";

const WIDTH = 100;

beforeAll(async () => {
	await initTheme(false, "unicode", false, "titanium", "dark");
});

class Block implements Component {
	constructor(private readonly lines: string[]) {}
	invalidate(): void {}
	render(): string[] {
		return this.lines;
	}
}

/** A block still streaming: it grows a row per frame and never finalizes. */
class LiveBlock implements Component {
	#rows: string[] = ["  streaming 0"];
	invalidate(): void {}
	grow(): void {
		this.#rows = [...this.#rows, `  streaming ${this.#rows.length}`];
	}
	getRenderStablePrefixRows(): number {
		return 0;
	}
	render(): string[] {
		return this.#rows;
	}
}

class Composer implements Component, Focusable {
	focused = false;
	invalidate(): void {}
	setUseTerminalCursor(): void {}
	handleInput(): void {}
	render(): string[] {
		return [`> ask anything${CURSOR_MARKER}`];
	}
}

async function run(header: number, height: number, turns: number, frames: number) {
	const term = new VirtualTerminal(WIDTH, height, 20_000);
	let erases = 0;
	const write = term.write.bind(term);
	term.write = (data: string) => {
		if (data.includes("\x1b[3J")) erases++;
		write(data);
	};
	const tui = new TUI(term, true);
	tui.setScrollbackRebuild(true);
	if (header > 0) tui.addChild(new Block(Array.from({ length: header }, (_, r) => `header ${r}`)));
	const transcript = new TranscriptContainer();
	tui.addChild(transcript);
	tui.addChild(new Composer());
	tui.setPinnedFooterChildCount(1);
	tui.start();
	await settleFrames(term, tui);
	for (let turn = 0; turn < turns; turn++) {
		transcript.addChild(new Block([`> turn ${turn}`, "", `  reply body for turn ${turn}`, ""]));
		tui.requestRender();
		await settleFrames(term, tui);
	}
	const before = tui.fullRedraws;
	const erasesBefore = erases;
	const live = new LiveBlock();
	transcript.addChild(live);
	for (let frame = 0; frame < frames; frame++) {
		live.grow();
		tui.requestRender();
		await settleFrames(term, tui);
	}
	const history = term
		.getScrollBuffer()
		.map(row => Bun.stripANSI(row).trimEnd())
		.filter(row => row.length > 0);
	const lost: number[] = [];
	for (let turn = 0; turn < turns; turn++) {
		if (!history.some(row => row.includes(`turn ${turn}`))) lost.push(turn);
	}
	return { redraws: tui.fullRedraws - before, erases: erases - erasesBefore, lost };
}

describe("a transcript under a header does not rebuild the screen", () => {
	for (const header of [0, 2, 5]) {
		it(`a header of ${header} rows costs no rebuild`, async () => {
			const result = await run(header, 40, 30, 40);
			// eslint-disable-next-line no-console
			console.log(`header=${header}`, JSON.stringify(result));
			expect(result.redraws).toBe(0);
			expect(result.erases).toBe(0);
			expect(result.lost).toEqual([]);
		}, 60_000);
	}
});

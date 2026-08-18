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
 * The second member is the shape a real busy turn has, which the synthetic
 * sweep above does not reach: several REAL blocks live at once — three `bash`
 * executions each restreaming a growing output, an assistant reply rewriting
 * itself every frame, a `todo` board landing mid-run and playing its entrance,
 * and a second reply streaming under the board so its rows scroll off the top
 * while it is still animating — in a viewport short enough that every frame
 * scrolls. Concurrency is what a reader sees as a flash, so that arm pins zero
 * viewport clears (ED2) and zero scrollback erases (ED3) across the whole turn:
 * those are the two sequences that make a frame destructive, and either one on
 * a terminal without synchronized output is a visible flash.
 *
 * `fullRedraws` is NOT zero there and must not be: it also counts the seam
 * rewrite, one write carrying the rows that commit to history plus the window
 * below them, which is how any appending transcript advances. It is bounded
 * instead, because a frame count's worth of whole-window rewrites is the same
 * defect wearing a non-destructive coat. Measured: 11 seam rewrites over 60
 * frames at 24 rows, 13 at 40 rows. A control then forces one destructive paint
 * through `requestRender(true, { clearScrollback: true })`, because a counter
 * that can only ever read zero proves nothing.
 *
 * WHAT IT DOES NOT CATCH. One width and two heights, a single dropping child,
 * and no second virtualized sibling below the first; nor a multiplexer pane,
 * where the divergence rebuild is gated off entirely. Nothing here observes
 * the terminal's own tearing: a frame emitted as several writes is atomic only
 * where DEC 2026 synchronized output is implemented, which is the emulator's
 * side of the seam and is not measurable from these bytes. It also does not
 * catch an animating block that declares its rows history: removing that
 * exemption leaves this arm green, and the contract is pinned per component in
 * `test/tui/a-tool-blocks-rail-moves-while-it-runs-and-cools-once-it-lands`.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@veyyon/ai";
import { interactionFixtures } from "@veyyon/coding-agent/cli/gallery-fixtures/interaction";
import { AssistantMessageComponent } from "@veyyon/coding-agent/modes/components/assistant-message";
import { TranscriptContainer } from "@veyyon/coding-agent/modes/components/transcript-container";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { type Component, CURSOR_MARKER, type Focusable, isInsideTerminalMultiplexer, TUI } from "@veyyon/tui";
import { settleFrames } from "../../../../tui/test/helpers/settle-frames";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal";
import { createToolExecution } from "../../helpers/tool-execution";

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

/** A finished assistant text, the shape a streaming reply carries frame to frame. */
function assistantText(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			reasoningTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/** Command output that wraps: long, path-like rows are what a real bash block streams. */
function commandOutput(tag: string, rows: number): string {
	return Array.from({ length: rows }, (_, r) => `${tag}-${r} ${"=".repeat(40)} /some/path/segment/${r}`).join("\n");
}

interface PaintCounts {
	redraws: number;
	clears: number;
	erases: number;
}

async function runBusyTurn(height: number, steps: number): Promise<{ busy: PaintCounts; control: PaintCounts }> {
	const term = new VirtualTerminal(WIDTH, height, 20_000);
	let clears = 0;
	let erases = 0;
	const write = term.write.bind(term);
	term.write = (data: string) => {
		clears += data.split("\x1b[2J").length - 1;
		erases += data.split("\x1b[3J").length - 1;
		write(data);
	};
	const tui = new TUI(term, true);
	tui.setScrollbackRebuild(true);
	const transcript = new TranscriptContainer();
	tui.addChild(transcript);
	tui.addChild(new Composer());
	tui.setPinnedFooterChildCount(1);
	const assistant = new AssistantMessageComponent(undefined, false);
	const tools = ["build.sh", "test.sh", "lint.sh"].map(command =>
		createToolExecution("bash", { command }, {}, undefined, tui, process.cwd()),
	);
	const todo = createToolExecution("todo", interactionFixtures.todo!.args, {}, undefined, tui, process.cwd());
	// The reply that arrives AFTER the board is what pushes the board's rows off
	// the top of the window while its settle animation is still running, which is
	// the only arrangement in which an animating block can rewrite rows the engine
	// has already committed.
	const tail = new AssistantMessageComponent(undefined, false);
	transcript.addChild(assistant);
	for (const tool of tools) transcript.addChild(tool);
	transcript.addChild(todo);
	transcript.addChild(tail);
	const boardLandsAt = Math.floor(steps / 2);
	try {
		tui.start();
		await settleFrames(term, tui);
		const redrawsBefore = tui.fullRedraws;
		const clearsBefore = clears;
		const erasesBefore = erases;
		for (let step = 1; step <= steps; step++) {
			assistant.updateContent(assistantText(`reasoning step ${step} ${"word ".repeat(step % 12)}`), {
				transient: true,
			});
			for (const [index, tool] of tools.entries()) {
				tool.updateResult({ content: [{ type: "text", text: commandOutput(`tool${index}`, step) }] }, true);
			}
			// The board arrives mid-turn and animates while the rest keeps streaming.
			// Its result carries real phase details, which is what makes it draw an
			// entrance rather than a static block.
			if (step === boardLandsAt) {
				todo.updateResult(interactionFixtures.todo!.result!);
			}
			if (step > boardLandsAt) {
				// Three rows a frame: taller than the viewport within the board's
				// animation envelope, so the board scrolls above the window top
				// while it is still repainting itself.
				tail.updateContent(assistantText(commandOutput("answer", (step - boardLandsAt) * 3)), { transient: true });
			}
			tui.requestRender();
			await settleFrames(term, tui);
		}
		const busy: PaintCounts = {
			redraws: tui.fullRedraws - redrawsBefore,
			clears: clears - clearsBefore,
			erases: erases - erasesBefore,
		};
		const controlFrom = { redraws: tui.fullRedraws, clears, erases };
		tui.requestRender(true, { clearScrollback: true });
		await settleFrames(term, tui);
		return {
			busy,
			control: {
				redraws: tui.fullRedraws - controlFrom.redraws,
				clears: clears - controlFrom.clears,
				erases: erases - controlFrom.erases,
			},
		};
	} finally {
		tui.stop();
		await term.flush();
	}
}

describe("a busy turn does not rebuild the screen", () => {
	const STEPS = 60;
	for (const height of [24, 40]) {
		it(`several live blocks streaming at once cost no destructive paint at ${height} rows`, async () => {
			// A multiplexer pane gates the divergence rebuild off, so the arm would
			// pass without exercising anything it claims to cover.
			expect(isInsideTerminalMultiplexer()).toBe(false);
			const { busy, control } = await runBusyTurn(height, STEPS);
			// eslint-disable-next-line no-console
			console.log(`busy height=${height}`, JSON.stringify({ busy, control }));
			expect(busy.clears).toBe(0);
			expect(busy.erases).toBe(0);
			// A seam rewrite is one write per history commit, not per frame: a whole
			// frame count's worth is the same defect in a non-destructive coat.
			expect(busy.redraws).toBeLessThan(STEPS / 2);
			// The counters can see a destructive paint; the zeros above are a
			// measurement rather than a counter that never moves.
			expect(control.clears + control.erases).toBeGreaterThan(0);
			expect(control.redraws).toBeGreaterThan(0);
		}, 120_000);
	}
});

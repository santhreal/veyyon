/**
 * A scrolled-off transcript survives every destructive repaint the engine takes.
 *
 * WHAT THIS CLOSES. `TranscriptContainer` is virtualized: once the engine
 * reports rows committed to native scrollback it splices them out of its own
 * frame, so the composed frame stays near the viewport height however long the
 * session runs. The engine's commit index kept pointing at the pre-splice
 * coordinates, so the next classification saw a frame shorter than the commit
 * index whose row 0 no longer matched the recorded prefix, called that a
 * committed-prefix divergence, and — with `tui.scrollbackRebuild` on, which is
 * the shipped default — erased native scrollback (ED3) and replayed the frame.
 * The frame at that moment was the tail only, because the component had
 * already dropped the history the replay was supposed to restore. Measured on
 * fourteen turns at a twelve-row viewport: ten ED3 erases, eleven full
 * redraws, and a terminal buffer holding nine rows instead of twenty-nine,
 * with the first seven turns gone. On screen that is a transcript that
 * randomly empties itself mid-stream, worse the faster output arrives, because
 * output rate is what drives compaction.
 *
 * THE CLASS, not the incident. The rule these cases encode is that a
 * component dropping rows it was told are committed must never cost the reader
 * those rows, whatever the engine does next. So the sweep drives the same
 * conversation through every combination of the two knobs that decide whether
 * a rebuild is destructive (`tui.scrollbackRebuild`) and whether the transcript
 * is virtualized at all, and asserts history survives in all of them, plus the
 * genuine-divergence path where the rebuild MUST erase and replay.
 *
 * WHAT IT DOES NOT CATCH. It runs one width and one height, and it drives
 * finalized blocks rather than a live streaming markdown block, so the
 * interaction between the exactness seam and compaction is covered only where
 * those two meet at the commit boundary. It also says nothing about a
 * multiplexer pane: `divergenceRebuild` is gated off there, which is a
 * different path with its own repair-below contract.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { TranscriptContainer } from "@veyyon/coding-agent/modes/components/transcript-container";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { type Component, Container, CURSOR_MARKER, type Focusable, TUI } from "@veyyon/tui";
import { settleFrames } from "../../../../tui/test/helpers/settle-frames";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal";

const WIDTH = 60;
const HEIGHT = 12;
const TURNS = 14;
const CASE_TIMEOUT_MS = 30_000;

beforeAll(async () => {
	await initTheme(false, "unicode", false, "titanium", "dark");
});

/** A finalized block: plain components are final, so their rows commit. */
class Block implements Component {
	constructor(private readonly lines: string[]) {}
	invalidate(): void {}
	render(_width: number): string[] {
		return this.lines;
	}
}

/**
 * A block whose bytes change AFTER its rows have committed: the genuine
 * divergence `scrollbackRebuild` exists to repair (a finalized reply replacing
 * the live preview that already scrolled off). It carries a VERSION, which is
 * what keeps it out of the compacted prefix — a block the container has
 * dropped is no longer in the frame the audit reads, so a rewrite of one is
 * invisible by construction and could not be the case under test.
 */
class RewritingBlock implements Component {
	#lines: string[];
	#version = 1;
	constructor(lines: string[]) {
		this.#lines = [...lines];
	}
	invalidate(): void {}
	getTranscriptBlockVersion(): number {
		return this.#version;
	}
	rewrite(lines: string[]): void {
		this.#lines = [...lines];
		this.#version += 1;
	}
	render(_width: number): string[] {
		return this.#lines;
	}
}

class Composer implements Component, Focusable {
	focused = false;
	invalidate(): void {}
	setUseTerminalCursor(): void {}
	handleInput(): void {}
	render(_width: number): string[] {
		return [`> ask anything${CURSOR_MARKER}`];
	}
}

interface Rig {
	term: VirtualTerminal;
	tui: TUI;
	transcript: Container;
	settle: () => Promise<void>;
	/** Destructive scrollback erases (ED3) the engine has written. */
	erases: () => number;
	/** Non-empty rows the terminal holds, scrollback plus viewport. */
	history: () => string[];
}

async function conversation(options: { rebuild: boolean; virtualized: boolean; turns?: number }): Promise<Rig> {
	const term = new VirtualTerminal(WIDTH, HEIGHT, 5_000);
	let erases = 0;
	const write = term.write.bind(term);
	term.write = (data: string) => {
		if (data.includes("\x1b[3J")) erases++;
		write(data);
	};
	const tui = new TUI(term, true);
	tui.setScrollbackRebuild(options.rebuild);
	const transcript = options.virtualized ? new TranscriptContainer() : new Container();
	tui.addChild(transcript);
	tui.addChild(new Composer());
	tui.setPinnedFooterChildCount(1);
	tui.start();
	const settle = () => settleFrames(term, tui);
	await settle();
	for (let turn = 0; turn < (options.turns ?? TURNS); turn++) {
		transcript.addChild(new Block([`> turn ${turn}`, "", `  reply body for turn ${turn}`, ""]));
		tui.requestRender();
		await settle();
	}
	return {
		term,
		tui,
		transcript,
		settle,
		erases: () => erases,
		history: () =>
			term
				.getScrollBuffer()
				.map(row => Bun.stripANSI(row).trimEnd())
				.filter(row => row.length > 0),
	};
}

describe("a virtualized transcript never loses history to a rebuild", () => {
	// The sweep is over the two knobs that decide whether an ordinary frame can
	// turn destructive. Adding a third state to either means adding a row here.
	const arms = [
		{ rebuild: true, virtualized: true },
		{ rebuild: false, virtualized: true },
		{ rebuild: true, virtualized: false },
		{ rebuild: false, virtualized: false },
	] as const;

	for (const arm of arms) {
		const label = `scrollbackRebuild=${arm.rebuild} virtualized=${arm.virtualized}`;
		it(
			`keeps every turn in the terminal (${label})`,
			async () => {
				const rig = await conversation(arm);

				const history = rig.history();
				for (let turn = 0; turn < TURNS; turn++) {
					expect(
						history.some(row => row.includes(`turn ${turn}`)),
						`${label}: turn ${turn}`,
					).toBe(true);
				}
				// Nothing about growing a transcript is destructive: an ordinary
				// append must never erase the terminal's own history.
				expect(rig.erases(), `${label}: ED3 erases`).toBe(0);
				// One paint, at startup. A per-append full redraw is the visible
				// flicker the false divergence caused, so the count is pinned, not
				// merely bounded by "not too many".
				expect(rig.tui.fullRedraws, `${label}: full redraws`).toBe(1);
			},
			CASE_TIMEOUT_MS,
		);
	}

	it(
		"is unaffected by the rebuild knob while the transcript only grows",
		async () => {
			// Exact parity between the arms: the setting decides how a GENUINE
			// divergence is repaired, and must not change what an ordinary
			// append-only session leaves in the terminal.
			const on = await conversation({ rebuild: true, virtualized: true });
			const off = await conversation({ rebuild: false, virtualized: true });

			expect(on.history()).toEqual(off.history());
			expect(on.tui.scrollTapeRows).toBe(off.tui.scrollTapeRows);
		},
		CASE_TIMEOUT_MS,
	);

	it(
		"still erases and replays when committed rows genuinely change, and replays the whole transcript",
		async () => {
			const rig = await conversation({ rebuild: true, virtualized: true });
			const rewritten = new RewritingBlock([`> turn ${TURNS}`, "", "  live preview", ""]);
			rig.transcript.addChild(rewritten);
			rig.tui.requestRender();
			await rig.settle();
			// Its rows have to scroll above the window before they are committed:
			// a block still inside the viewport is repainted in place and no
			// amount of rewriting it can diverge from what was committed.
			for (let i = 0; i < 4; i++) {
				rig.transcript.addChild(new Block([`> follow-up ${i}`, "", `  reply body for follow-up ${i}`, ""]));
				rig.tui.requestRender();
				await rig.settle();
			}

			// The block's committed bytes change, and change the ROWS BELOW with
			// them: the verified zone tolerates one edited row (an in-place
			// restyle leaves history alone), so the divergence the rebuild exists
			// for is the reflow that shifts everything under it.
			rewritten.rewrite([`> turn ${TURNS}`, "", "  final answer, reflowed", "  onto a second line", ""]);
			rig.tui.requestRender();
			await rig.settle();

			const history = rig.history();
			expect(rig.erases()).toBeGreaterThan(0);
			// The erase replayed the REHYDRATED frame, so the history the
			// transcript had dropped is back in the terminal rather than deleted
			// along with the stale copy.
			for (let turn = 0; turn < TURNS; turn++) {
				expect(
					history.some(row => row.includes(`turn ${turn}`)),
					`turn ${turn}`,
				).toBe(true);
			}
			expect(history.some(row => row.includes("final answer, reflowed"))).toBe(true);
			// Repaired means exactly once: the stale preview is gone, not stacked
			// above its replacement.
			expect(history.filter(row => row.includes("live preview"))).toEqual([]);
		},
		CASE_TIMEOUT_MS,
	);
});

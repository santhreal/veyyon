/**
 * A row that reached the terminal's native scrollback is never appended to it a
 * second time, and the frame tail stays pinned to the viewport bottom, through
 * every shrink-and-regrow cycle the product produces under a tall running block.
 *
 * WHY THIS CLOSES THE DEFECT.
 * A tall running tool card (an eval cell with its agent rows) overflows the
 * viewport, so its upper rows scroll off and commit as frozen snapshots. Below
 * it the product inserts and retracts short-lived rows all turn long: an IRC
 * card arriving and expiring, a displaced todo snapshot, an agent sub-row, a HUD
 * row, the ask dialog's inline editor. Each retraction shrank the frame below
 * the committed boundary with the focused composer in the tail, and the engine's
 * tail re-anchor re-showed the committed rows AND lowered the commit index to
 * the new window top. The next insert then scrolled those rows off again, and
 * the scroll-append emitter pushed them into native scrollback a second time.
 * Over a long turn one status row accumulated thousands of copies and the
 * scrollback read as the screen morphing. The fix keeps the re-show (the prompt
 * never floats) but leaves the commit index alone: a regrowth slides the window
 * in place until it passes the boundary, and only rows past it ever scroll off.
 *
 * THE CLASS, not the incident.
 * The invariant is that native history holds each committed row once, whatever
 * shrinks the frame and however often, on a direct terminal and inside a
 * multiplexer pane, at every viewport height where the running block overflows.
 * Every shrink source the product has is swept from one table, so a new source
 * is added to the table or the sweep pin fails. The sweep runs the real `TUI`
 * against a real `VirtualTerminal` with the host shape (transcript with a live
 * seam, anchored HUD, focused composer, pinned footer), and every member is
 * asserted to have scrolled, so a member that never reached the condition is a
 * failure rather than a silent pass.
 *
 * WHAT IT DOES NOT CATCH.
 * The multiplexer fallback at finalization ("recommit below the stale copy")
 * still duplicates by design when a frozen snapshot's source changed before it
 * became final; the sweep measures the cycles, not that repair. A product
 * controller that retracts a block whose rows are already committed is a host
 * defect the transcript container's `isBlockUncommitted` guard defends; the
 * driver here honours the same rule, so the engine is never asked to un-commit.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	type Component,
	CURSOR_MARKER,
	type Focusable,
	type NativeScrollbackCommittedRows,
	type NativeScrollbackLiveRegion,
	type NativeScrollbackReplay,
	TUI,
} from "../src/index";
import { countDestructivePaints } from "./helpers/destructive-paints";
import { settleFrames } from "./helpers/settle-frames";
import { VirtualTerminal } from "./virtual-terminal";

/**
 * Everything the product shrinks and regrows below a tall running block. A
 * source added here is swept; `expect(swept)` below pins the set.
 */
const SHRINK_SOURCES = ["ephemeral-card", "live-sub-row", "hud-rows", "prompt-collapse"] as const;
type ShrinkSource = (typeof SHRINK_SOURCES)[number];

const TERMINAL_KINDS = ["direct", "multiplexer"] as const;
type TerminalKind = (typeof TERMINAL_KINDS)[number];

const FOOTER_ROW = "  …/repo · main · footer-row";
const CYCLES = 12;

/** Transcript root: settled turns, then one running block, then ephemeral cards. */
class Transcript
	implements Component, NativeScrollbackLiveRegion, NativeScrollbackReplay, NativeScrollbackCommittedRows
{
	settled: string[] = [];
	liveRows: string[] = [];
	live = true;
	ephemeral: string[] = [];
	committedRows = 0;
	invalidate(): void {}
	prepareNativeScrollbackReplay(): void {}
	setNativeScrollbackCommittedRows(rows: number): void {
		this.committedRows = rows;
	}
	getNativeScrollbackLiveRegionStart(): number | undefined {
		return this.live ? this.settled.length : undefined;
	}
	/** First frame row of the ephemeral card; the transcript is the first root child. */
	ephemeralStartRow(): number {
		return this.settled.length + this.liveRows.length;
	}
	render(): string[] {
		return [...this.settled, ...this.liveRows, ...this.ephemeral];
	}
}

class Hud implements Component, NativeScrollbackLiveRegion {
	rows: string[] = [];
	invalidate(): void {}
	getNativeScrollbackLiveRegionStart(): number | undefined {
		return this.rows.length > 0 ? 0 : undefined;
	}
	render(): string[] {
		return [...this.rows];
	}
}

class Composer implements Component, Focusable {
	focused = true;
	extraRows = 0;
	invalidate(): void {}
	setUseTerminalCursor(): void {}
	handleInput(): void {}
	render(): string[] {
		const rows = Array.from({ length: this.extraRows }, (_, i) => `  editor row ${i}`);
		return [...rows, `> composer-prompt${CURSOR_MARKER}`];
	}
}

class Footer implements Component {
	invalidate(): void {}
	render(): string[] {
		return [FOOTER_ROW];
	}
}

interface Variant {
	height: number;
	source: ShrinkSource;
	terminal: TerminalKind;
}

interface Outcome {
	/** Non-blank history rows that appear more than once, with their counts. */
	duplicated: string[];
	/** Cycles after which the viewport's last row was not the pinned footer. */
	floatingAfterCycle: number[];
	erasesDuringCycles: number;
	historyRowCount: number;
	/** After the block finalized with its committed bytes unchanged: history rows repeated. */
	duplicatedAfterFinalize: string[];
}

function duplicates(rows: readonly string[]): string[] {
	const counts = new Map<string, number>();
	for (const row of rows) {
		if (row === "") continue;
		counts.set(row, (counts.get(row) ?? 0) + 1);
	}
	const out: string[] = [];
	for (const [row, count] of counts) if (count > 1) out.push(`${count}× ${row}`);
	return out;
}

function history(term: VirtualTerminal): string[] {
	const baseY = term.getBufferPosition().baseY;
	return term
		.getScrollBuffer()
		.slice(0, baseY)
		.map(row => Bun.stripANSI(row).trimEnd());
}

function viewportBottom(term: VirtualTerminal): string {
	const viewport = term.getViewport().map(row => Bun.stripANSI(row).trimEnd());
	return viewport[viewport.length - 1] ?? "";
}

async function executeVariant(variant: Variant): Promise<Outcome> {
	const term = new VirtualTerminal(100, variant.height, 50_000);
	const paints = countDestructivePaints(term);
	const tui = new TUI(term, true);
	tui.setScrollbackRebuild(true);

	const transcript = new Transcript();
	const hud = new Hud();
	const composer = new Composer();
	tui.addChild(transcript);
	tui.addChild(hud);
	tui.addChild(new Footer());
	tui.addChild(composer);
	tui.addChild(new Footer());
	tui.setPinnedFooterChildCount(3);
	tui.start();
	await settleFrames(term, tui);

	for (let turn = 0; turn < 6; turn++) {
		transcript.settled.push(`> turn ${turn}: what changed?`, "", `  reply ${turn}: these rows are settled.`, "");
		tui.requestRender();
		await settleFrames(term, tui);
	}

	// The running block: taller than the viewport, so its head scrolls off while
	// it is still live. Its own rows never change; only what comes after it does.
	transcript.liveRows = [
		"  ▏ running eval cell",
		...Array.from({ length: variant.height + 6 }, (_, i) => `  ▏  code line ${i} of the cell`),
		"  └─ agent RoomStreamingProof",
	];
	hud.rows = ["  ▏ Todos", "  ▏ └─ Rooms · 2/5", " ░ working on the room · [esc]"];
	tui.requestRender();
	await settleFrames(term, tui);

	const erasesBefore = paints.erases();
	const floatingAfterCycle: number[] = [];
	let subRowOn = false;
	for (let cycle = 0; cycle < CYCLES; cycle++) {
		// Grow.
		switch (variant.source) {
			case "ephemeral-card":
				transcript.ephemeral = [`  ▏ irc from RoomStreamingProof · ${cycle}`, `  ▏ ping ${cycle}`, `  ▏ [expires]`];
				break;
			case "live-sub-row":
				subRowOn = true;
				transcript.liveRows.push("     └ bash: sleep 40");
				break;
			case "hud-rows":
				hud.rows.push(`  ▏    ├─ □ item ${cycle}`, `  ▏    ├─ □ item ${cycle} detail`);
				break;
			case "prompt-collapse":
				composer.extraRows = 4;
				break;
		}
		tui.requestRender();
		await settleFrames(term, tui);

		// Shrink. The ephemeral card retracts only while none of its rows is in
		// native history, which is the product's `isBlockUncommitted` rule.
		switch (variant.source) {
			case "ephemeral-card":
				if (transcript.ephemeralStartRow() >= transcript.committedRows) transcript.ephemeral = [];
				break;
			case "live-sub-row":
				if (subRowOn) {
					transcript.liveRows.pop();
					subRowOn = false;
				}
				break;
			case "hud-rows":
				hud.rows.length = 3;
				break;
			case "prompt-collapse":
				composer.extraRows = 0;
				break;
		}
		tui.requestRender();
		await settleFrames(term, tui);
		if (viewportBottom(term) !== FOOTER_ROW) floatingAfterCycle.push(cycle);
	}
	const erasesDuringCycles = paints.erases() - erasesBefore;
	const cycleHistory = history(term);

	// Finalize with the committed bytes unchanged, so the audit finds no
	// divergence and the multiplexer fallback has nothing to recommit.
	transcript.ephemeral = [];
	transcript.live = false;
	tui.requestRender();
	await settleFrames(term, tui);
	const finalHistory = history(term);
	tui.stop();

	return {
		duplicated: duplicates(cycleHistory),
		floatingAfterCycle,
		erasesDuringCycles,
		historyRowCount: cycleHistory.length,
		duplicatedAfterFinalize: duplicates(finalHistory),
	};
}

function sweepVariants(): Variant[] {
	const list: Variant[] = [];
	for (const terminal of TERMINAL_KINDS) {
		for (const height of [8, 16, 40]) {
			for (const source of SHRINK_SOURCES) list.push({ height, source, terminal });
		}
	}
	return list;
}

describe("a row in native history is never committed again", () => {
	let savedTmux: string | undefined;
	let savedTermProgram: string | undefined;
	beforeEach(() => {
		savedTmux = Bun.env.TMUX;
		savedTermProgram = Bun.env.TERM_PROGRAM;
		delete Bun.env.TERM_PROGRAM;
	});
	afterEach(() => {
		if (savedTmux === undefined) delete Bun.env.TMUX;
		else Bun.env.TMUX = savedTmux;
		if (savedTermProgram === undefined) delete Bun.env.TERM_PROGRAM;
		else Bun.env.TERM_PROGRAM = savedTermProgram;
	});

	test("every shrink source, on a direct terminal and in a pane, at every overflowing height", async () => {
		if (process.platform === "win32") return;
		const swept = new Set<string>();
		const failures: string[] = [];
		for (const variant of sweepVariants()) {
			if (variant.terminal === "multiplexer") Bun.env.TMUX = "/tmp/tmux-1000/default,12345,0";
			else delete Bun.env.TMUX;
			swept.add(variant.source);
			const label = `${variant.terminal} h=${variant.height} ${variant.source}`;
			const outcome = await executeVariant(variant);
			if (outcome.historyRowCount === 0) failures.push(`${label}: never scrolled`);
			if (outcome.duplicated.length > 0) failures.push(`${label}: history repeats ${outcome.duplicated.join("; ")}`);
			if (outcome.floatingAfterCycle.length > 0) {
				failures.push(`${label}: prompt floated after cycles ${outcome.floatingAfterCycle.join(",")}`);
			}
			if (outcome.erasesDuringCycles > 0)
				failures.push(`${label}: ${outcome.erasesDuringCycles} erases during cycles`);
			if (outcome.duplicatedAfterFinalize.length > 0) {
				failures.push(`${label}: history repeats after finalize ${outcome.duplicatedAfterFinalize.join("; ")}`);
			}
		}
		expect(failures).toEqual([]);
		expect([...swept]).toEqual([...SHRINK_SOURCES]);
	}, 180_000);
});

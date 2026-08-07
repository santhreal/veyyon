import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type Component, type NativeScrollbackCommittedRows, type NativeScrollbackLiveRegion, TUI } from "@veyyon/tui";
import { settleFrames } from "./helpers/settle-frames";
import { VirtualTerminal } from "./virtual-terminal";

// Ends this file's effect with this file: the flag is process-global and is read at
// TUI construction, so leaving it set hands the rebuild path to every suite after
// this one. Two other suites (`scroll-isolation`, `scroll-isolation-history`) had
// to state the shipped default explicitly to defend against exactly that.
// Law-encoding suite for native-scrollback commits.
//
// The tape is the terminal's visual record: whatever scrolls above the window
// enters history, in order. The component seam
// (`getNativeScrollbackLiveRegionStart`) classifies HOW a row commits:
//   ► below the boundary — exact-final bytes, hard-verified, audited;
//   ► above the boundary — a frozen snapshot of what was on screen, exempt
//     from re-anchoring while its source stays live (a collapsing preview can
//     never spray duplicates mid-run);
//   ► when the boundary rises past frozen snapshots (the block finalized, a
//     barrier cleared), they are strict-scanned exactly once: a divergence
//     erases native history and replays the frame (one ED3), so the tape
//     holds the final content exactly once — never a stale fragment above a
//     recommit. Multiplexer panes, where ED3 is unsafe, keep the repair-below
//     fallback: the final content recommits below the frozen snapshot —
//     duplication, never loss.

class LineList implements Component {
	#lines: string[];

	constructor(lines: string[]) {
		this.#lines = [...lines];
	}

	invalidate(): void {}

	render(width: number): string[] {
		return this.#lines.map(line => line.slice(0, width));
	}

	setLines(lines: string[]): void {
		this.#lines = [...lines];
	}
}

/**
 * Live block with a settable exactness boundary:
 *   0         — nothing declared final (a volatile tool preview);
 *   Infinity  — everything rendered so far is final (an append-only streaming
 *               reply; the engine clamps to the rendered length);
 *   undefined — no seam (finalized block / plain shell content).
 */
class SeamLineList extends LineList implements NativeScrollbackLiveRegion {
	seam: number | undefined = 0;

	getNativeScrollbackLiveRegionStart(): number | undefined {
		return this.seam;
	}
}

/**
 * Records the engine's committed-row claim visible at each render() call.
 * Pins the propagation contract: the claim must be fed *before* render so the
 * child (e.g. the transcript container) can skip re-deriving blocks that
 * already live in immutable native scrollback.
 */
class CommittedRowsProbe extends SeamLineList implements NativeScrollbackCommittedRows {
	#committedRows = 0;
	committedRowsAtRender: number[] = [];

	constructor(lines: string[]) {
		super(lines);
		this.seam = Number.POSITIVE_INFINITY;
	}

	setNativeScrollbackCommittedRows(rows: number): void {
		this.#committedRows = rows;
	}

	override render(width: number): string[] {
		this.committedRowsAtRender.push(this.#committedRows);
		return super.render(width);
	}
}

/**
 * Extends the compose-time probe with the raw wire: every value the engine
 * pushes through `setNativeScrollbackCommittedRows`, in arrival order —
 * including the post-emit publish that lands *between* frames. Guards that
 * run between frames (a controller deciding whether a displaceable block may
 * still be retracted) read exactly this last value; if it lags the emit by
 * one frame they retract rows that already entered immutable history.
 */
class CommittedRowsWireProbe extends CommittedRowsProbe {
	received: number[] = [];

	override setNativeScrollbackCommittedRows(rows: number): void {
		this.received.push(rows);
		super.setNativeScrollbackCommittedRows(rows);
	}
}

async function settle(term: VirtualTerminal, tui: TUI): Promise<void> {
	// The engine's own "a frame is owed" signal instead of a fixed sleep; see
	// `packages/tui/test/helpers/settle-frames.ts` for the flakes the sleep caused.
	await settleFrames(term, tui);
}

// The non-multiplexer resize fast path paints the viewport at once and defers
// the authoritative full replay (the ED3 scrollback rebuild) until the drag has
// been quiet for the resize settle window (120 ms). This is an integration test
// against the real render scheduler, so the window is driven with a real delay.
async function settleResize(term: VirtualTerminal, tui: TUI): Promise<void> {
	// The window is a real wall-clock wait before the deferred replay is even
	// scheduled, so it is slept through; only the frame after it settles.
	await Bun.sleep(160);
	await settle(term, tui);
}

function capture(term: VirtualTerminal): string[] {
	const writes: string[] = [];
	const realWrite = term.write.bind(term);
	term.write = (data: string) => {
		writes.push(data);
		realWrite(data);
	};
	return writes;
}

function overrideProbe(term: VirtualTerminal, answer: boolean | undefined): void {
	// The probe is not on VirtualTerminal's public type; shadow it so the
	// scrollback math stays deterministic in headless runs.
	const probeHost = term as unknown as { isNativeViewportAtBottom: () => boolean | undefined };
	probeHost.isNativeViewportAtBottom = () => answer;
}

const ERASE_SCROLLBACK = /\x1b\[3J/g;

function eraseScrollbackCount(writes: string[]): number {
	return writes.join("").match(ERASE_SCROLLBACK)?.length ?? 0;
}

function rows(prefix: string, count: number): string[] {
	return Array.from({ length: count }, (_, i) => `${prefix}${i}`);
}

/** Scrollback history + active grid, right-trimmed, trailing blank rows dropped. */
function tape(term: VirtualTerminal): string[] {
	const buffer = term.getScrollBuffer().map(line => line.trimEnd());
	while (buffer.length > 0 && buffer.at(-1) === "") buffer.pop();
	return buffer;
}

/** Indices in `buffer` where `needle` begins as a contiguous run. */
function contiguousAt(buffer: string[], needle: string[]): number[] {
	const hits: number[] = [];
	for (let i = 0; i + needle.length <= buffer.length; i++) {
		let match = true;
		for (let j = 0; j < needle.length; j++) {
			if (buffer[i + j] !== needle[j]) {
				match = false;
				break;
			}
		}
		if (match) hits.push(i);
	}
	return hits;
}

function saveTerminalEnv(): Record<string, string | undefined> {
	// A resize on Warp takes the in-place path (no ED3), so neutralize the
	// ambient terminal identity to keep the direct-terminal scrollback
	// assertions deterministic on any dev machine.
	const saved: Record<string, string | undefined> = {};
	for (const key of ["TERM_PROGRAM", "VEYYON_TUI_RESIZE_IN_PLACE"]) {
		saved[key] = Bun.env[key];
		delete Bun.env[key];
	}
	return saved;
}

function restoreTerminalEnv(saved: Record<string, string | undefined>): void {
	for (const key in saved) {
		const value = saved[key];
		if (value === undefined) delete Bun.env[key];
		else Bun.env[key] = value;
	}
}

describe("streaming scrollback — visual record", () => {
	let savedTerminalEnv: Record<string, string | undefined> = {};
	beforeEach(() => {
		savedTerminalEnv = saveTerminalEnv();
	});
	afterEach(() => {
		restoreTerminalEnv(savedTerminalEnv);
		savedTerminalEnv = {};
	});

	it("records a volatile live block's scrolled rows and never duplicates them on finalize", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(20, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const sealed = new LineList(rows("prior-", 12));
		const live = new SeamLineList([]);

		try {
			tui.addChild(sealed);
			tui.addChild(live);
			tui.start();
			await settle(term, tui);

			const writes = capture(term);

			live.setLines(rows("think-", 6));
			tui.requestRender();
			await settle(term, tui);

			// The live block's head scrolls above the 4-row viewport and is
			// recorded as a frozen snapshot — nothing that was painted vanishes.
			expect(eraseScrollbackCount(writes)).toBe(0);
			expect(tape(term)).toEqual([...rows("prior-", 12), ...rows("think-", 6)]);

			// Append-only growth: recorded rows are byte-identical, so nothing
			// re-anchors; the new tail just extends.
			live.setLines(rows("think-", 8));
			tui.requestRender();
			await settle(term, tui);
			expect(tape(term)).toEqual([...rows("prior-", 12), ...rows("think-", 8)]);

			// Finalize: the recorded snapshots match the final render, so the
			// one-time strict verification passes and NOTHING recommits.
			live.seam = undefined;
			tui.requestRender();
			await settle(term, tui);

			const buffer = tape(term);
			expect(eraseScrollbackCount(writes)).toBe(0);
			expect(buffer).toEqual([...rows("prior-", 12), ...rows("think-", 8)]);
		} finally {
			tui.stop();
		}
	});

	it("records a tall all-live block's scrolled head", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(20, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const live = new SeamLineList([]);

		try {
			tui.addChild(live);
			tui.start();
			await settle(term, tui);

			const writes = capture(term);

			live.setLines(rows("tool-", 10));
			tui.requestRender();
			await settle(term, tui);

			// tool-0..tool-5 scrolled above the 4-row viewport and are recorded;
			// tool-6..tool-9 stay in the viewport. Nothing is lost.
			expect(eraseScrollbackCount(writes)).toBe(0);
			expect(tape(term)).toEqual(rows("tool-", 10));

			live.seam = undefined;
			tui.requestRender();
			await settle(term, tui);
			expect(tape(term)).toEqual(rows("tool-", 10));
		} finally {
			tui.stop();
		}
	});

	it("commits an append-only declared-final block's scrolled head as exact rows", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(20, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		// An append-only streaming reply declares every rendered row final
		// (Infinity clamps to the rendered length): its scrolled-off head enters
		// the verified zone and never needs a finalize-time repair.
		const live = new SeamLineList([]);
		live.seam = Number.POSITIVE_INFINITY;

		try {
			tui.addChild(live);
			tui.start();
			await settle(term, tui);

			const writes = capture(term);

			live.setLines(rows("text-", 10));
			tui.requestRender();
			await settle(term, tui);

			expect(eraseScrollbackCount(writes)).toBe(0);
			expect(tape(term)).toEqual(rows("text-", 10));

			live.seam = undefined;
			tui.requestRender();
			await settle(term, tui);
			expect(tape(term)).toEqual(rows("text-", 10));
		} finally {
			tui.stop();
		}
	});

	it("rebuilds history once at finalize when a wholesale-replaced live block diverged", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(24, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const sealed = new LineList(rows("prior-", 12));
		const live = new SeamLineList([]);

		try {
			tui.addChild(sealed);
			tui.addChild(live);
			tui.start();
			await settle(term, tui);

			const writes = capture(term);

			live.setLines(rows("pending-stale-", 10));
			tui.requestRender();
			await settle(term, tui);

			// Head recorded as frozen snapshots.
			expect(tape(term)).toEqual([...rows("prior-", 12), ...rows("pending-stale-", 10)]);

			// Wholesale replace while still live: frozen snapshots are exempt —
			// no mid-run re-anchor, no spray. The tape keeps the recorded head;
			// the window shows the fresh tail.
			live.setLines(rows("running-fresh-", 10));
			tui.requestRender();
			await settle(term, tui);
			expect(tape(term)).toEqual([
				...rows("prior-", 12),
				...rows("pending-stale-", 6),
				...rows("running-fresh-", 10).slice(6),
			]);

			// Finalize: the one-time strict verification catches the divergence
			// and erases-and-replays, so the tape holds the final content exactly
			// once — the stale frozen fragment is gone, nothing recommits below it.
			live.seam = undefined;
			tui.requestRender();
			await settle(term, tui);

			const buffer = tape(term);
			expect(eraseScrollbackCount(writes)).toBe(1);
			expect(buffer).toEqual([...rows("prior-", 12), ...rows("running-fresh-", 10)]);
		} finally {
			tui.stop();
		}
	});

	it("keeps the topmost seam when a lower sibling also reports one", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(24, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const sealed = new LineList(rows("prior-", 12));
		const live = new SeamLineList([]);
		// Status loader below the transcript: also reports a seam. Exactness is
		// prefix-only, so the engine must keep the TOPMOST seam — letting the
		// lower sibling's seam win would verify the transcript's still-mutable
		// rows as final.
		const loader = new SeamLineList(["Working..."]);

		try {
			tui.addChild(sealed);
			tui.addChild(live);
			tui.addChild(loader);
			tui.start();
			await settle(term, tui);

			const writes = capture(term);

			live.setLines(rows("pending-stale-", 10));
			tui.requestRender();
			await settle(term, tui);

			live.setLines(rows("running-fresh-", 10));
			tui.requestRender();
			await settle(term, tui);

			// Mid-run: frozen snapshots are exempt — a wholesale replace while
			// live must not trigger a rebuild. A lower sibling's seam winning
			// would verify the live rows as final and re-anchor right here.
			expect(eraseScrollbackCount(writes)).toBe(0);

			live.seam = undefined;
			tui.requestRender();
			await settle(term, tui);

			const buffer = tape(term);
			// Finalize rebuild: full fresh content exactly once, the stale
			// preview fragment erased, loader still live at the bottom.
			expect(eraseScrollbackCount(writes)).toBe(1);
			expect(contiguousAt(buffer, rows("running-fresh-", 10))).toHaveLength(1);
			expect(buffer.filter(line => line.startsWith("pending-stale-"))).toEqual([]);
			expect(buffer.at(-1)).toBe("Working...");
		} finally {
			tui.stop();
		}
	});

	it("commits scrolled streaming rows to history exactly once without ED3 (shell semantics)", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(40, 10);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const component = new LineList([...rows("init-", 10), "prompt"]);

		try {
			tui.addChild(component);
			tui.start();
			await settle(term, tui);

			const writes = capture(term);

			const frame1 = [...rows("init-", 10), ...rows("stream-", 30), "prompt"];
			component.setLines(frame1);
			tui.requestRender();
			await settle(term, tui);

			expect(eraseScrollbackCount(writes)).toBe(0);
			let buffer = term.getScrollBuffer().map(line => line.trimEnd());
			expect(buffer).toEqual(frame1.slice(0, buffer.length));
			expect(
				term
					.getViewport()
					.map(line => line.trim())
					.at(-1),
			).toBe("prompt");

			const frame2 = [...rows("init-", 10), ...rows("stream-", 50), "prompt"];
			component.setLines(frame2);
			tui.requestRender();
			await settle(term, tui);

			expect(eraseScrollbackCount(writes)).toBe(0);
			buffer = term.getScrollBuffer().map(line => line.trimEnd());
			expect(buffer).toEqual(frame2.slice(0, buffer.length));
			expect(buffer.length).toBeGreaterThan(frame1.length - 10);
		} finally {
			tui.stop();
		}
	});

	it("does not emit ED3 during streaming", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(40, 10);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const component = new LineList([...rows("init-", 10), "prompt"]);

		try {
			tui.addChild(component);
			tui.start();
			await settle(term, tui);

			const writes = capture(term);

			component.setLines([...rows("grow-", 30), "prompt"]);
			tui.requestRender();
			await settle(term, tui);

			expect(eraseScrollbackCount(writes)).toBe(0);

			tui.requestRender();
			await settle(term, tui);

			expect(eraseScrollbackCount(writes)).toBe(0);
			expect(
				term
					.getViewport()
					.map(line => line.trim())
					.at(-1),
			).toBe("prompt");
		} finally {
			tui.stop();
		}
	});

	it("does not duplicate committed sealed rows when the live region collapses mid-stream", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(20, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const sealed = new LineList(rows("prior-", 12));
		const live = new SeamLineList([]);

		try {
			tui.addChild(sealed);
			tui.addChild(live);
			tui.start();
			await settle(term, tui);

			const writes = capture(term);

			live.setLines(rows("think-", 30));
			tui.requestRender();
			await settle(term, tui);
			expect(term.getScrollBuffer().filter(line => line.startsWith("prior-"))).toEqual(rows("prior-", 12));

			// Live block collapses to its compact result: the frame shrank into
			// recorded rows, so history is rebuilt — the sealed rows appear
			// exactly once, never appended a second time below their old copy.
			live.setLines(["done"]);
			tui.requestRender();
			await settle(term, tui);

			expect(eraseScrollbackCount(writes)).toBe(1);
			expect(term.getScrollBuffer().filter(line => line.startsWith("prior-"))).toEqual(rows("prior-", 12));
		} finally {
			tui.stop();
		}
	});

	it("keeps committed prefix accounting after a capped streaming frame", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(24, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const sealed = new LineList(rows("base-", 12));

		try {
			tui.addChild(sealed);
			tui.start();
			await settle(term, tui);

			const writes = capture(term);

			sealed.setLines([...rows("base-", 12), ...rows("transient-", 30)]);
			tui.requestRender();
			await settle(term, tui);

			expect(eraseScrollbackCount(writes)).toBe(0);

			// A later frame introduces a live region after the same sealed prefix
			// and drops the transient tail: the frame shrank into recorded rows,
			// so one rebuild replays history with the base rows exactly once —
			// never appended to native history a second time.
			const live = new SeamLineList(rows("live-", 20));
			sealed.setLines(rows("base-", 12));
			tui.addChild(live);
			tui.requestRender();
			await settle(term, tui);

			expect(eraseScrollbackCount(writes)).toBe(1);
			expect(term.getScrollBuffer().filter(line => line.startsWith("base-"))).toEqual(rows("base-", 12));
		} finally {
			tui.stop();
		}
	});

	it("erases mis-wrapped native scrollback on resize even mid-stream", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(40, 10);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const component = new LineList([...rows("init-", 5), "prompt"]);

		try {
			tui.addChild(component);
			tui.start();
			await settle(term, tui);

			const writes = capture(term);

			component.setLines([...rows("stream-", 30), "prompt"]);
			tui.requestRender();
			await settle(term, tui);
			expect(eraseScrollbackCount(writes)).toBe(0);
			const streamed = term.getScrollBuffer().map(line => line.trimEnd());
			expect(streamed).toEqual([...rows("stream-", 30), "prompt"].slice(0, streamed.length));

			// Resize mid-stream. The terminal re-wrapped its saved lines at the old
			// width, so the authoritative rebuild must erase them (ED 3) rather than
			// leaving the corrupt history on screen. That rebuild is deferred until
			// the drag settles; while in flight only the viewport is repainted.
			term.resize(30, 10);
			await settleResize(term, tui);

			expect(eraseScrollbackCount(writes)).toBeGreaterThan(0);
			expect(term.getScrollBuffer().map(line => line.trimEnd())).toEqual([...rows("stream-", 30), "prompt"]);
			expect(
				term
					.getViewport()
					.map(line => line.trim())
					.at(-1),
			).toBe("prompt");
		} finally {
			tui.stop();
		}
	});

	it("feeds committed native scrollback rows to interested children before render", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(20, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const probe = new CommittedRowsProbe([]);

		try {
			tui.addChild(probe);
			tui.start();
			await settle(term, tui);

			probe.setLines(rows("out-", 12));
			tui.requestRender();
			await settle(term, tui);

			// The next compose must surface the engine's committed claim to the
			// child before render(). A severed wire here silently disables the
			// transcript's committed-block bypass (rows stay 0 forever).
			tui.requestRender();
			await settle(term, tui);

			expect(probe.committedRowsAtRender.at(-1)!).toBeGreaterThan(0);
		} finally {
			tui.stop();
		}
	});

	it("publishes the post-emit committed count between frames — never one frame stale", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(40, 8);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const probe = new CommittedRowsWireProbe([]);

		try {
			tui.addChild(probe);
			tui.start();
			await settle(term, tui);

			// Nothing has scrolled: the between-frames claim is 0 — no phantom rows.
			expect(probe.received.at(-1)).toBe(0);

			// One frame grows past the viewport; its emit scrolls rows into
			// native scrollback. No further render is requested — whatever the
			// probe last received IS the claim a between-frames guard consults.
			probe.setLines(rows("hist-", 20));
			tui.requestRender();
			await settle(term, tui);

			// Compose ran before the emit advanced the boundary, so this frame's
			// render() saw the pre-emit count. The emit must then push the fresh
			// count: with compose-only propagation the last received value would
			// still equal the stale compose view, and a guard would retract rows
			// that just became immutable — stranding an orphaned copy in history.
			const composeView = probe.committedRowsAtRender.at(-1)!;
			const betweenFrames = probe.received.at(-1)!;
			expect(betweenFrames).toBeGreaterThan(composeView);
			// The fresh claim is the truth: exactly the rows above the window
			// (tape = committed history rows + the 8-row grid).
			expect(betweenFrames).toBe(tape(term).length - 8);

			// A frame that commits nothing must restate the boundary verbatim on
			// every push — compose feed and post-emit publish alike. No regress,
			// no phantom advance.
			const wireLength = probe.received.length;
			tui.requestRender();
			await settle(term, tui);
			expect(probe.received.length).toBeGreaterThan(wireLength);
			for (const value of probe.received.slice(wireLength)) {
				expect(value).toBe(betweenFrames);
			}
		} finally {
			tui.stop();
		}
	});

	it("publishes the post-emit committed count on the full-paint replay path too", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(40, 8);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		// Content taller than the viewport before the first paint: the initial
		// frame takes the full-paint path, whose replay commits (frame - height)
		// rows in one shot on a separate exit from the ordinary update emit.
		const probe = new CommittedRowsWireProbe(rows("hist-", 20));

		try {
			tui.addChild(probe);
			tui.start();
			await settle(term, tui);

			// Compose fed the pre-emit count (0); the replay committed 12 rows.
			// The full-paint return must publish the fresh count too — leaving
			// it stale until the next compose is the same one-frame lag.
			const composeView = probe.committedRowsAtRender.at(-1)!;
			const betweenFrames = probe.received.at(-1)!;
			expect(betweenFrames).toBeGreaterThan(composeView);
			expect(betweenFrames).toBe(tape(term).length - 8);
		} finally {
			tui.stop();
		}
	});

	it("clamps each child's committed-count feed to its own extent", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(40, 8);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		// A short header above a tall overflowing body: the engine's committed
		// boundary sails past the header's 2-row extent. Both feeds are in the
		// child's own coordinates and must saturate at what the child actually
		// contributed — an unclamped count would make rows the header appends
		// LATER read as already-committed, exempting them from ever painting.
		const header = new CommittedRowsWireProbe(rows("hdr-", 2));
		const body = new CommittedRowsWireProbe([]);

		try {
			tui.addChild(header);
			tui.addChild(body);
			tui.start();
			await settle(term, tui);

			body.setLines(rows("body-", 20));
			tui.requestRender();
			await settle(term, tui);

			// 22-row frame in an 8-row window: 14 rows committed, the boundary
			// 12 rows past the header. Post-emit publish: the header's claim
			// saturates at its own extent; the body receives the remainder in
			// its own coordinates (boundary minus its start offset).
			expect(tape(term).length).toBe(22);
			expect(header.received.at(-1)).toBe(2);
			expect(Math.max(...header.received)).toBe(2);
			expect(body.received.at(-1)).toBe(12);
			// Post-emit freshness holds per child in the multi-child layout:
			// the body's compose view was still pre-emit, the publish delivered
			// the advanced count.
			expect(body.received.at(-1)!).toBeGreaterThan(body.committedRowsAtRender.at(-1)!);

			// The compose-time feed clamps identically: an idle frame restates
			// each child's saturated claim on every push — never more.
			tui.requestRender();
			await settle(term, tui);
			expect(header.received.at(-1)).toBe(2);
			expect(Math.max(...header.received)).toBe(2);
			expect(body.received.at(-1)).toBe(12);
		} finally {
			tui.stop();
		}
	});

	it("never re-anchors a re-laying-out live block mid-run, rebuilds once at finalize", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(20, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		// A block that rewrites an interior row every frame (a streaming table
		// re-aligning, a collapsing preview). Its scrolled rows are frozen
		// snapshots: drift never sprays re-anchors; the single strict scan at
		// finalize erases-and-replays the final form once.
		const live = new SeamLineList([]);

		try {
			tui.addChild(live);
			tui.start();
			await settle(term, tui);

			const writes = capture(term);

			for (let n = 4; n <= 12; n++) {
				const lines = rows("tbl-", n);
				lines[1] = `tbl-1 [w${n}]`; // interior row re-lays-out every frame
				live.setLines(lines);
				tui.requestRender();
				await settle(term, tui);
			}

			// Mid-run: exactly the scrolled snapshots + the grid — one copy each,
			// no spray and no rebuild despite nine drift frames.
			const streaming = tape(term);
			expect(eraseScrollbackCount(writes)).toBe(0);
			expect(streaming).toHaveLength(12);
			expect(streaming.filter(line => line.startsWith("tbl-1 ")).length).toBe(1);

			live.seam = undefined;
			tui.requestRender();
			await settle(term, tui);

			// Finalize: one erase-and-replay puts the final layout on the tape
			// exactly once — the drifted row's final form is the only copy.
			const finalLines = rows("tbl-", 12);
			finalLines[1] = "tbl-1 [w12]";
			const buffer = tape(term);
			expect(eraseScrollbackCount(writes)).toBe(1);
			expect(buffer).toEqual(finalLines);

			// Stability: identical follow-up frames must not grow the tape or
			// erase again.
			tui.requestRender();
			await settle(term, tui);
			expect(tape(term)).toEqual(buffer);
			expect(eraseScrollbackCount(writes)).toBe(1);
		} finally {
			tui.stop();
		}
	});

	it("repairs a declared-final violation with one rebuild, never spraying", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(20, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		// The block declares its whole body final, commits, then violates the
		// contract by rewriting TWO committed rows (alignment breaks, so the
		// tail-sample tolerance cannot absorb it). The audit re-anchors, the
		// engine erases-and-replays once, and stays quiet afterwards.
		const live = new SeamLineList(rows("row-", 12));
		live.seam = Number.POSITIVE_INFINITY;

		try {
			tui.addChild(live);
			tui.start();
			await settle(term, tui);

			const writes = capture(term);
			const violated = rows("row-", 12);
			violated[5] = "row-5 [edited]";
			violated[6] = "row-6 [edited]";
			live.setLines(violated);
			tui.requestRender();
			await settle(term, tui);

			const afterViolation = tape(term);
			expect(eraseScrollbackCount(writes)).toBe(1);
			expect(afterViolation).toEqual(violated);

			for (let i = 0; i < 5; i++) {
				tui.requestRender();
				await settle(term, tui);
			}
			expect(tape(term)).toEqual(afterViolation);
			expect(eraseScrollbackCount(writes)).toBe(1);
		} finally {
			tui.stop();
		}
	});
});

describe("scrollback commit gap — live barriers", () => {
	let savedTerminalEnv: Record<string, string | undefined> = {};
	beforeEach(() => {
		savedTerminalEnv = saveTerminalEnv();
	});
	afterEach(() => {
		restoreTerminalEnv(savedTerminalEnv);
		savedTerminalEnv = {};
	});

	it("does not drop the tail when a pending barrier above it is removed (S5/S6)", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(20, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const root = new SeamLineList([]);

		try {
			tui.addChild(root);
			tui.start();
			await settle(term, tui);
			const writes = capture(term);

			// Small pending barrier above a long finalized tail, overflowing the
			// 4-row viewport. Scrolled rows are recorded as frozen snapshots.
			root.setLines(["[tool pending]", ...rows("ans-", 8)]);
			root.seam = 0;
			tui.requestRender();
			await settle(term, tui);
			expect(tape(term)).toEqual(["[tool pending]", ...rows("ans-", 8)]);

			// Barrier removed: the tail shifts up. The one-time strict scan
			// catches the shift and rebuilds — every ans row survives, in order,
			// and the stale barrier row is erased from history.
			root.setLines(rows("ans-", 8));
			root.seam = undefined;
			tui.requestRender();
			await settle(term, tui);

			const buffer = tape(term);
			expect(buffer).toEqual(rows("ans-", 8));
			expect(term.getViewport().map(line => line.trimEnd())).toEqual(rows("ans-", 8).slice(-4));
			expect(eraseScrollbackCount(writes)).toBe(1);
		} finally {
			tui.stop();
		}
	});

	it("does not drop result rows when a provisional preview is replaced by its result (S4)", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(20, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const root = new SeamLineList([]);

		try {
			tui.addChild(root);
			tui.start();
			await settle(term, tui);
			const writes = capture(term);

			const preview = rows("preview-", 10);
			root.setLines(preview);
			root.seam = 0;
			tui.requestRender();
			await settle(term, tui);
			expect(tape(term)).toEqual(preview);

			const result = rows("result-", 9);
			root.setLines(result);
			root.seam = undefined;
			tui.requestRender();
			await settle(term, tui);

			const buffer = tape(term);
			// History rebuilt: the full result exactly once; the provisional
			// preview is erased rather than left above as a stale record.
			expect(buffer).toEqual(result);
			expect(term.getViewport().map(line => line.trimEnd())).toEqual(result.slice(-4));
			expect(eraseScrollbackCount(writes)).toBe(1);
		} finally {
			tui.stop();
		}
	});

	it("does not drop rows when a barrier partially collapses above a long tail (S10)", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(20, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const root = new SeamLineList([]);

		try {
			tui.addChild(root);
			tui.start();
			await settle(term, tui);
			const writes = capture(term);

			const f1 = [...rows("bar-", 3), ...rows("tail-", 8)];
			root.setLines(f1);
			root.seam = 0;
			tui.requestRender();
			await settle(term, tui);
			expect(tape(term)).toEqual(f1);

			// Barrier collapses to 1 row but the frame stays longer than the
			// committed prefix (NOT the shrink-into-prefix branch); the strict
			// scan must catch the upward tail shift and rebuild.
			const f2 = ["bar-collapsed", ...rows("tail-", 8)];
			root.setLines(f2);
			root.seam = undefined;
			tui.requestRender();
			await settle(term, tui);

			const buffer = tape(term);
			expect(buffer).toEqual(f2);
			expect(term.getViewport().map(line => line.trimEnd())).toEqual(f2.slice(-4));
			expect(eraseScrollbackCount(writes)).toBe(1);
		} finally {
			tui.stop();
		}
	});

	it("keeps a finalized tail in order when its live barrier sibling is removed (multi-child S6)", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(20, 5);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const barrier = new SeamLineList(["[tool pending]"]);
		const tail = new LineList(rows("out-", 10));

		try {
			tui.addChild(barrier);
			tui.addChild(tail);
			tui.start();
			await settle(term, tui);
			const writes = capture(term);

			// Force overflow: 11 rows over a 5-row viewport. Scrolled rows are
			// recorded (frozen — the topmost seam is at the barrier).
			tui.requestRender();
			await settle(term, tui);
			expect(tape(term)).toEqual(["[tool pending]", ...rows("out-", 10)]);

			// Remove the barrier. The tail shifts up by one row; the strict scan
			// rebuilds so every out-* row remains, in order, and the stale
			// barrier row is erased.
			tui.removeChild(barrier);
			tui.requestRender();
			await settle(term, tui);

			const buffer = tape(term);
			expect(buffer).toEqual(rows("out-", 10));
			expect(term.getViewport().map(line => line.trimEnd())).toEqual(rows("out-", 10).slice(-5));
			expect(eraseScrollbackCount(writes)).toBe(1);
		} finally {
			tui.stop();
		}
	});

	it("survives a streaming-then-removed barrier across many frames without loss", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(20, 5);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const root = new SeamLineList([]);

		try {
			tui.addChild(root);
			tui.start();
			await settle(term, tui);

			for (let n = 1; n <= 20; n++) {
				const frame = ["[pending]", ...rows("row-", n)];
				root.setLines(frame);
				root.seam = 0;
				tui.requestRender();
				await settle(term, tui);
				// Visual record mid-run: everything that scrolled is on the tape.
				expect(tape(term)).toEqual(frame);
			}

			const final = rows("row-", 20);
			root.setLines(final);
			root.seam = undefined;
			tui.requestRender();
			await settle(term, tui);

			const buffer = tape(term);
			expect(buffer).toEqual(final);
			expect(term.getViewport().map(line => line.trimEnd())).toEqual(final.slice(-5));
		} finally {
			tui.stop();
		}
	});

	it("commits a declared-final prose head exactly, with zero finalize repair", async () => {
		if (process.platform === "win32") return;
		// A streaming block whose settled head is declared final (the
		// transcript's settled-prefix path) while its last row re-wraps in place
		// and a live card renders below. The head commits as verified exact rows
		// — so finalize needs NO repair and the tape never duplicates a byte.
		const term = new VirtualTerminal(20, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const root = new SeamLineList([]);

		try {
			tui.addChild(root);
			tui.start();
			await settle(term, tui);
			const writes = capture(term);

			for (let n = 0; n < 12; n++) {
				const prose = rows("prose-", 8);
				prose[7] = `prose-7 [w${n}]`; // volatile tail re-wraps in place
				root.setLines([...prose, "card-0", "card-1"]);
				root.seam = 7; // declared-final through prose-6
				tui.requestRender();
				await settle(term, tui);
			}

			const streaming = tape(term);
			expect(contiguousAt(streaming, ["prose-0", "prose-1", "prose-2"])).toHaveLength(1);

			root.seam = undefined;
			tui.requestRender();
			await settle(term, tui);

			// Zero repair: the tape is byte-identical to the streaming state.
			const buffer = tape(term);
			expect(buffer).toEqual(streaming);
			expect(contiguousAt(buffer, ["prose-0", "prose-1", "prose-2"])).toHaveLength(1);
			expect(eraseScrollbackCount(writes)).toBe(0);
		} finally {
			tui.stop();
		}
	});

	it("does not lose a single-row finalize edit above an unchanged tail (#4124)", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(20, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const root = new SeamLineList([]);

		try {
			tui.addChild(root);
			tui.start();
			await settle(term, tui);
			const writes = capture(term);

			const f1 = ["preview", ...rows("tail-", 8)];
			root.setLines(f1);
			root.seam = 0;
			tui.requestRender();
			await settle(term, tui);
			expect(tape(term)).toEqual(f1);

			// Finalize: ONLY row 0 changes (preview → result); the whole tail is
			// byte-identical. The tail-sample tolerance alone would eat the single
			// mismatch and "result" would never reach the tape; the strict scan of
			// the newly-final span forces the rebuild.
			const f2 = ["result", ...rows("tail-", 8)];
			root.setLines(f2);
			root.seam = undefined;
			tui.requestRender();
			await settle(term, tui);

			const buffer = tape(term);
			expect(buffer).toEqual(f2);
			expect(buffer.filter(line => line === "result")).toHaveLength(1);
			expect(term.getViewport().map(line => line.trimEnd())).toEqual(f2.slice(-4));
			expect(eraseScrollbackCount(writes)).toBe(1);
		} finally {
			tui.stop();
		}
	});

	it("does not lose a single-row finalize edit far above a long unchanged tail (deep tail)", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(20, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const root = new SeamLineList([]);

		try {
			tui.addChild(root);
			tui.start();
			await settle(term, tui);
			const writes = capture(term);

			// The changed row sits ~30 rows above the commit boundary with an
			// unchanged tail — far outside the 24-row tail-sample lookback, so
			// only the FULL scan of the newly-final span catches it.
			root.setLines(["preview", ...rows("tail-", 30)]);
			root.seam = 0;
			tui.requestRender();
			await settle(term, tui);

			root.setLines(["result", ...rows("tail-", 30)]);
			root.seam = undefined;
			tui.requestRender();
			await settle(term, tui);

			const buffer = tape(term);
			expect(buffer).toEqual(["result", ...rows("tail-", 30)]);
			expect(buffer.filter(line => line === "result")).toHaveLength(1);
			expect(eraseScrollbackCount(writes)).toBe(1);
		} finally {
			tui.stop();
		}
	});
});

describe("scrollback divergence — multiplexer fallback", () => {
	let savedTerminalEnv: Record<string, string | undefined> = {};
	let savedTmux: string | undefined;
	beforeEach(() => {
		savedTerminalEnv = saveTerminalEnv();
		savedTmux = Bun.env.TMUX;
		Bun.env.TMUX = "/tmp/tmux-1000/default,12345,0";
	});
	afterEach(() => {
		if (savedTmux === undefined) delete Bun.env.TMUX;
		else Bun.env.TMUX = savedTmux;
		restoreTerminalEnv(savedTerminalEnv);
		savedTerminalEnv = {};
	});

	it("repairs below the stale fragment without ED3 when the pane cannot be cleared", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(20, 4);
		overrideProbe(term, undefined);
		const tui = new TUI(term);
		const root = new SeamLineList([]);

		try {
			tui.addChild(root);
			tui.start();
			await settle(term, tui);
			const writes = capture(term);

			const preview = rows("preview-", 10);
			root.setLines(preview);
			root.seam = 0;
			tui.requestRender();
			await settle(term, tui);
			expect(tape(term)).toEqual(preview);

			// Finalize divergence inside a tmux pane: ED3 would corrupt the
			// pane's own history, so the engine keeps the repair-below contract —
			// the full result reaches the tape contiguously, the frozen preview
			// head stays above it exactly once, and nothing is erased.
			const result = rows("result-", 9);
			root.setLines(result);
			root.seam = undefined;
			tui.requestRender();
			await settle(term, tui);

			const buffer = tape(term);
			expect(buffer.slice(-9)).toEqual(result);
			expect(contiguousAt(buffer, result)).toHaveLength(1);
			expect(eraseScrollbackCount(writes)).toBe(0);
		} finally {
			tui.stop();
		}
	});
});

/**
 * The duplicated paragraph, which is the shape operators actually report.
 *
 * WHAT IT LOOKS LIKE. A streamed answer reflows a block after part of it has
 * already scrolled past the window top, and the reader ends up with:
 *
 *     Two real defects I can now name precisely:
 *     Two real defects I can now name precisely:
 *     1. A stale comment that misdescribes the gate ...
 *     1. A stale comment that misdescribes the gate ...
 *
 * The engine's repair for it (`divergenceRebuild`: erase history with one ED3
 * and replay so the block lands exactly once) was written, correct, and OFF.
 * It sat behind `tui.scrollbackRebuild`, which defaulted to false, so every
 * direct-terminal session took the append-below fallback that is only supposed
 * to be the multiplexer compromise. Turning it on is the whole fix; this case
 * is here so it cannot be turned back off by accident.
 *
 * The sibling case above pins the OTHER half of the contract: inside a
 * multiplexer, where ED3 would eat the pane's own history, the duplication is
 * still the correct trade and must stay.
 */
describe("scrollback divergence — the default repairs a duplicated block", () => {
	const savedEnv = saveTerminalEnv();
	afterEach(() => restoreTerminalEnv(savedEnv));

	it("leaves a reflowed block in history exactly once, with no flag set", async () => {
		if (process.platform === "win32") return;
		const term = new VirtualTerminal(80, 4);
		// A direct terminal, not a pane: this is where the erase is safe and where
		// the duplicate appears.
		overrideProbe(term, true);
		const tui = new TUI(term);
		const root = new SeamLineList([]);

		// No `setScrollbackRebuild` call anywhere in this case, deliberately. The
		// point is the SHIPPED default, so a future change that flips it back
		// fails here rather than only in a suite that opts in.
		expect(tui.getScrollbackRebuild()).toBe(true);

		try {
			tui.addChild(root);
			tui.start();
			await settle(term, tui);

			// The live block streams in and overflows the 4-row window, so its head
			// scrolls off and commits as a frozen snapshot.
			const preview = [
				"Two real defects I can now name precisely:",
				"1. A stale comment that misdescribes the gate",
				"2. A count that is off by one",
				"filler-a",
				"filler-b",
				"filler-c",
			];
			root.setLines(preview);
			root.seam = 0;
			tui.requestRender();
			await settle(term, tui);

			// Then it finalizes with the block reflowed: same opening lines, more
			// text under them. This is the divergence that used to recommit the
			// head below its own stale copy.
			const finalBlock = [
				"Two real defects I can now name precisely:",
				"1. A stale comment that misdescribes the gate, policy.ts:361",
				"2. A count that is off by one, policy.ts:404",
				"filler-a",
				"filler-b",
				"filler-c",
				"filler-d",
			];
			root.setLines(finalBlock);
			root.seam = undefined;
			tui.requestRender();
			await settle(term, tui);

			const buffer = tape(term);
			// The assertion that matches the screenshot: the opening line appears
			// ONCE in the terminal's whole history, not twice.
			expect(buffer.filter(line => line === "Two real defects I can now name precisely:")).toHaveLength(1);
			expect(contiguousAt(buffer, finalBlock)).toHaveLength(1);
			expect(buffer).toEqual(finalBlock);
		} finally {
			tui.stop();
		}
	});
});

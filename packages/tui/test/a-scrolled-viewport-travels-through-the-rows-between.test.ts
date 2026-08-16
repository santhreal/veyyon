// WHY: `MOTION.move` was a dead curve. Every viewport in the product cut
// straight to its new offset -- a PageDown replaced ten rows between two frames
// with nothing in between, so the reader had no way to tell a page down from a
// jump to somewhere else entirely. The defect class this closes is wider than
// the missing animation: it is a viewport whose PAINT and whose TARGET are two
// separate readings that can disagree. The thumb reading the target while the
// rows read the travel is the same bug wearing a scrollbar, and a travel that a
// re-layout forgets to end is the same bug with a stuck viewport.
//
// So the invariants here are: what paints is one value read two ways (the rows
// and the thumb); a scroll travels and everything that is not a scroll lands;
// and the travel always ends, in bounds, on the target the keyboard asked for.
//
// What it does NOT catch: whether a HOST wires this up. `setScrollMotion` is
// opt-in, and a host that never calls it, or that rebuilds its ScrollView every
// render, gets the old cut with this suite green. The two hosts that own a
// long-lived instance (the agent transcript viewer and the plan-review overlay)
// are wired by hand; a third would have to be too.

import { describe, expect, it } from "bun:test";
import { ScrollView } from "@veyyon/tui/components/scroll-view";
import { MOTION, MotionClock } from "@veyyon/tui/motion";

const FRAME = 1000 / 60;
/** A travel that has not ended in four seconds is a hang, not a slow spring. */
const FRAME_BUDGET = 240;

const ROWS = Array.from({ length: 40 }, (_, i) => `row-${String(i).padStart(3, "0")}`);

interface Viewport {
	view: ScrollView;
	clock: MotionClock;
	renders: () => number;
	/** Wall time handed to the clock so far; every tick moves it forward. */
	now: number;
}

function viewport(options: { enabled?: boolean; height?: number; scrollbar?: boolean } = {}): Viewport {
	const clock = new MotionClock();
	let renders = 0;
	const view = new ScrollView(ROWS, {
		height: options.height ?? 10,
		scrollbar: options.scrollbar ?? false,
		theme: { track: () => "T", thumb: () => "B" },
	});
	view.setScrollMotion({ requestRender: () => renders++, clock, enabled: options.enabled });
	return { view, clock, renders: () => renders, now: 0 };
}

/** The row the viewport is painting at its top, read off the frame it produced. */
function painted(view: ScrollView): number {
	const first = view.render(20)[0] ?? "";
	const match = /^row-(\d+)/.exec(first);
	if (!match) throw new Error(`no row in painted frame: ${JSON.stringify(first)}`);
	return Number(match[1]);
}

/** First row of the thumb, read off the rendered bar column. */
function thumbStart(view: ScrollView): number {
	const rows = view.render(20);
	const at = rows.findIndex(row => row.endsWith("B"));
	if (at < 0) throw new Error("no thumb in frame");
	return at;
}

/** One frame of the shared clock, always forward. */
function tick(v: Viewport): void {
	v.now += FRAME;
	v.clock.tick(v.now);
}

/** Drive the clock until nothing is live, returning every painted offset on the way. */
function travel(v: Viewport, read: (view: ScrollView) => number = painted): number[] {
	const seen = [read(v.view)];
	for (let frame = 1; frame <= FRAME_BUDGET && v.clock.liveCount > 0; frame++) {
		tick(v);
		seen.push(read(v.view));
	}
	return seen;
}

/**
 * True when the viewport is painting its target and owes no more frames.
 *
 * `MotionClock.liveCount` cannot answer this: a cancelled animation stays
 * counted until something next drives the clock, so a value that landed and a
 * value still travelling look identical until a tick tells them apart. Driving
 * one frame is the discriminator -- a live travel reports it, a landed one has
 * nothing to report.
 */
function landed(v: Viewport): boolean {
	const before = v.renders();
	tick(v);
	return painted(v.view) === v.view.getScrollOffset() && v.renders() === before;
}

describe("a scrolled viewport travels through the rows between", () => {
	it("walks a page instead of cutting to it, and lands exactly where the key aimed", () => {
		const v = viewport();

		v.view.page(1);

		// The key has already happened as far as anything that asks is concerned.
		expect(v.view.getScrollOffset()).toBe(9);
		// The frame it produces has not.
		expect(painted(v.view)).toBe(0);

		const seen = travel(v);

		expect(v.clock.liveCount).toBe(0);
		expect(seen.at(-1)).toBe(9);
		expect(seen.length).toBeGreaterThan(3);
		// Every row between, in order, and never past the target or behind the start.
		expect(seen).toEqual([...seen].sort((a, b) => a - b));
		expect(new Set(seen).size).toBeGreaterThan(2);
		expect(Math.max(...seen)).toBe(9);
		expect(Math.min(...seen)).toBe(0);
		// On the product's own travel curve, not a duration this component picked:
		// the same journey run straight off the clock takes the same frames.
		const reference = new MotionClock();
		const move = reference.animate(MOTION.move, { from: 0, to: 9 });
		let frames = 0;
		while (!move.done && frames < FRAME_BUDGET) {
			frames++;
			reference.tick(frames * FRAME);
		}
		expect(seen.length).toBe(frames + 1);
	});

	it("paints the rows and the thumb off the same value, so the bar cannot arrive first", () => {
		const v = viewport({ scrollbar: true });
		const settled = thumbStart(v.view);

		v.view.page(1);

		// A thumb reading the target is at its destination on the first frame while
		// the content is still at the top: the bar would report a scroll that has
		// not happened yet.
		expect(thumbStart(v.view)).toBe(settled);

		const rows: number[] = [];
		const thumbs: number[] = [];
		for (let frame = 1; frame <= FRAME_BUDGET && v.clock.liveCount > 0; frame++) {
			tick(v);
			rows.push(painted(v.view));
			thumbs.push(thumbStart(v.view));
		}

		expect(thumbs).toEqual([...thumbs].sort((a, b) => a - b));
		expect(rows.at(-1)).toBe(9);
		// The bar never leads the content. It has eight positions to the content's
		// thirty, so it moves later and lands on the same frame or earlier by
		// quantization alone -- but it must never move on a frame where the rows
		// have not, which is what a thumb reading the target does on frame one.
		const barLeft = thumbs.findIndex(start => start !== settled);
		const rowsLeft = rows.findIndex(row => row !== 0);
		expect(barLeft).toBeGreaterThanOrEqual(rowsLeft);
		expect(thumbs.at(-1)).toBe(thumbStart(v.view));
	});

	it("lands a single row, an end, and a jump too far to read on the way past", () => {
		const single = viewport();
		single.view.scroll(1);
		expect(painted(single.view)).toBe(1);
		expect(landed(single)).toBe(true);

		const bottom = viewport();
		bottom.view.scrollToBottom();
		expect(painted(bottom.view)).toBe(30);
		expect(landed(bottom)).toBe(true);

		const top = viewport();
		top.view.setScrollOffset(4);
		travel(top);
		top.view.scrollToTop();
		expect(painted(top.view)).toBe(0);
		expect(landed(top)).toBe(true);

		// Two screens is the boundary: 20 rows travels, 21 does not.
		const near = viewport();
		near.view.setScrollOffset(20);
		expect(painted(near.view)).toBe(0);
		expect(landed(near)).toBe(false);

		const far = viewport();
		far.view.setScrollOffset(21);
		expect(painted(far.view)).toBe(21);
		expect(landed(far)).toBe(true);
	});

	it("keeps travelling across the renders in between, and ends the travel when the content moves under it", () => {
		const surviving = viewport();
		surviving.view.page(1);
		tick(surviving);
		const midway = painted(surviving.view);
		// A render re-clamps the offset. Landing there unconditionally would cut
		// every travel short on the frame after it started.
		surviving.view.render(20);
		surviving.view.render(20);
		expect(painted(surviving.view)).toBe(midway);
		expect(travel(surviving).at(-1)).toBe(9);

		const relaid = viewport();
		relaid.view.page(1);
		tick(relaid);
		relaid.view.setLines(ROWS.slice(0, 12));
		expect(relaid.view.getScrollOffset()).toBe(2);
		expect(painted(relaid.view)).toBe(2);
		expect(landed(relaid)).toBe(true);
	});

	it("never paints past content that shrank under a travel it did not end", () => {
		const v = viewport();
		v.view.setScrollOffset(20);
		travel(v);
		v.view.setScrollOffset(2);
		tick(v);
		tick(v);
		tick(v);
		expect(painted(v.view)).toBeGreaterThan(2);

		// Twelve rows at height ten: the target is still reachable, so nothing
		// re-aims the travel — but where it currently IS no longer exists.
		v.view.setLines(ROWS.slice(0, 12));

		expect(v.view.getScrollOffset()).toBe(2);
		expect(painted(v.view)).toBeLessThanOrEqual(2);
		expect(travel(v).at(-1)).toBe(2);
	});

	it("stops travelling a value its caller took over windowing mid-flight", () => {
		const v = viewport({ scrollbar: true });
		v.view.setScrollOffset(20);
		tick(v);
		tick(v);
		const travelling = thumbStart(v.view);

		// The caller starts windowing the rows itself. The thumb is the only
		// reading left, and it must be the one the caller's window matches.
		v.view.setTotalRows(40);

		expect(thumbStart(v.view)).toBe(5);
		expect(travelling).not.toBe(5);
	});

	it("is byte-identical to the cut when motion is off, and registers nothing", () => {
		const off = viewport({ enabled: false, scrollbar: true });
		const plain = new ScrollView(ROWS, {
			height: 10,
			scrollbar: true,
			theme: { track: () => "T", thumb: () => "B" },
		});

		for (const step of [1, 5, 9, -3, 20]) {
			off.view.scroll(step);
			plain.scroll(step);
			expect(off.view.render(20)).toEqual(plain.render(20));
		}
		off.view.page(1);
		plain.page(1);
		expect(off.view.render(20)).toEqual(plain.render(20));
		expect(off.clock.liveCount).toBe(0);
		expect(off.renders()).toBe(0);
	});

	it("asks for a frame per tick, and stops asking the moment it is disposed", () => {
		const v = viewport();
		v.view.page(1);
		tick(v);
		tick(v);
		expect(v.renders()).toBe(2);

		v.view.disposeScrollMotion();
		const afterDispose = v.renders();
		for (let frame = 3; frame <= 10; frame++) tick(v);

		expect(v.renders()).toBe(afterDispose);
		expect(v.clock.liveCount).toBe(0);
		// The offset the key asked for is still where the viewport is.
		expect(painted(v.view)).toBe(9);
		expect(v.view.getScrollOffset()).toBe(9);
	});

	it("paints a whole row inside the content on every frame of every navigation", () => {
		const navigations: Array<[string, (view: ScrollView) => void]> = [
			["page down", view => view.page(1)],
			["page up from the bottom", view => view.page(-1)],
			["wheel", view => view.scroll(3)],
			["shift+down", view => view.handleScrollKey("\x1b[1;2B")],
			["jump", view => view.setScrollOffset(17)],
			["jump back", view => view.setScrollOffset(2)],
			// The travel spring overshoots slightly; a jump that ends on the last
			// row is where an unclamped value paints past the end of the content.
			["jump to the last row", view => view.setScrollOffset(30)],
		];

		for (const [name, navigate] of navigations) {
			const v = viewport();
			v.view.setScrollOffset(12);
			travel(v);
			navigate(v.view);
			const seen = travel(v);

			expect(`${name}: live ${v.clock.liveCount}`).toBe(`${name}: live 0`);
			for (const offset of seen) {
				expect(`${name}: ${Number.isInteger(offset) && offset >= 0 && offset <= 30}`).toBe(`${name}: true`);
			}
			expect(`${name}: ${seen.at(-1)}`).toBe(`${name}: ${v.view.getScrollOffset()}`);
		}
	});

	it("does not travel a thumb a pre-windowed caller cannot follow", () => {
		const clock = new MotionClock();
		const view = new ScrollView(ROWS.slice(0, 10), {
			height: 10,
			totalRows: 40,
			scrollbar: true,
			theme: { track: () => "T", thumb: () => "B" },
		});
		let renders = 0;
		view.setScrollMotion({ requestRender: () => renders++, clock });

		view.setScrollOffset(15);

		// The caller sliced these rows itself, against the offset it asked for. A
		// thumb travelling behind them would point at a row that is not on screen.
		expect(view.render(20)[0]).toBe(`${ROWS[0]}${" ".repeat(20 - 2 - ROWS[0].length)} T`);
		expect(thumbStart(view)).toBe(4);
		// And nothing is owed: a travel here would ask for frames that change no
		// pixel.
		clock.tick(FRAME);
		expect(renders).toBe(0);
	});

	// Fail-by-default: every method on the class is probed and classified here.
	// A new one that moves the offset turns this red until someone records
	// whether it is a scroll (travels) or is not (lands).
	it("classifies every method that can move the viewport", () => {
		const PROBES: Record<string, (view: ScrollView) => void> = {
			setLines: view => view.setLines(ROWS.slice(0, 4)),
			setTotalRows: view => view.setTotalRows(12),
			setHeight: view => view.setHeight(40),
			setScrollbar: view => view.setScrollbar("always"),
			setScrollMotion: view => view.setScrollMotion({ requestRender: () => {} }),
			disposeScrollMotion: view => view.disposeScrollMotion(),
			getScrollOffset: view => view.getScrollOffset(),
			getMaxScrollOffset: view => view.getMaxScrollOffset(),
			setScrollOffset: view => view.setScrollOffset(15),
			scroll: view => view.scroll(5),
			page: view => view.page(1),
			scrollToTop: view => view.scrollToTop(),
			scrollToBottom: view => view.scrollToBottom(),
			handleScrollKey: view => view.handleScrollKey("\x1b[1;2B"),
			invalidate: view => view.invalidate(),
			contentWidth: view => view.contentWidth(20),
			render: view => view.render(20),
		};
		const methods = Object.getOwnPropertyNames(ScrollView.prototype).filter(name => name !== "constructor");
		expect(Object.keys(PROBES).sort()).toEqual(methods.sort());

		const classified: Record<string, string> = {};
		for (const [name, probe] of Object.entries(PROBES)) {
			const v = viewport();
			v.view.setScrollOffset(10);
			tick(v);
			travel(v);
			const before = v.renders();
			probe(v.view);
			const moved = v.view.getScrollOffset() !== 10;
			// Whether a frame is owed, rather than what painted: a pre-windowed
			// viewport paints rows its caller sliced, so the frame says nothing
			// about the offset there.
			tick(v);
			classified[name] = moved ? (v.renders() > before ? "travel" : "land") : "still";
		}

		expect(classified).toEqual({
			setLines: "land",
			setTotalRows: "land",
			setHeight: "land",
			setScrollbar: "still",
			setScrollMotion: "still",
			disposeScrollMotion: "still",
			getScrollOffset: "still",
			getMaxScrollOffset: "still",
			setScrollOffset: "travel",
			scroll: "travel",
			page: "travel",
			scrollToTop: "land",
			scrollToBottom: "land",
			handleScrollKey: "travel",
			invalidate: "still",
			contentWidth: "still",
			render: "still",
		});
	});
});

import { afterEach, describe, expect, it, vi } from "bun:test";
import { type Component, type RenderScheduler, type RenderTimer, Text, TUI } from "@veyyon/tui";
import { VirtualTerminal } from "./virtual-terminal";

// WHY. A viewport slide moves the screen sideways from the window on show to
// the one the children compose now, one throwaway frame at a time on the
// borrowed alternate screen, and then hands over to the same authoritative
// full paint a resize drag settles with. The defect class this closes is a
// transition that leaves the engine in a state a plain repaint would not have:
// a frame committed mid-slide, an alternate screen never left, native
// scrollback erased once per slid frame, a slide that outlives its host, or a
// slide that runs where its alternate-screen frame is not available.
//
// It does not catch what the slid frames look like on a real terminal beyond
// what the VT engine reads back: colour bleed across the seam is asserted only
// through the reset the engine writes, not through a rendered pixel.

const NO_MULTIPLEXER_ENV: Record<string, string | undefined> = {
	TMUX: undefined,
	STY: undefined,
	ZELLIJ: undefined,
	TERM_PROGRAM: undefined,
	VEYYON_TUI_RESIZE_IN_PLACE: undefined,
};
const ALT_SCREEN_ENTER = "\x1b[?1049h";
const ALT_SCREEN_EXIT = "\x1b[?1049l";

async function withEnvPatch<T>(patch: Record<string, string | undefined>, run: () => T | Promise<T>): Promise<T> {
	const saved: Record<string, string | undefined> = {};
	for (const key in patch) {
		saved[key] = Bun.env[key];
		const value = patch[key];
		if (value === undefined) delete Bun.env[key];
		else Bun.env[key] = value;
	}
	try {
		return await run();
	} finally {
		for (const key in saved) {
			const value = saved[key];
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
	}
}

// Every timer is held until the test fires it, so each slid frame is observed
// on its own and the bound on the slide's length is a count, not a clock.
class StepScheduler implements RenderScheduler {
	#time = 0;
	#immediates: (() => void)[] = [];
	#timers = new Map<number, () => void>();
	#nextId = 0;

	now(): number {
		this.#time += 20;
		return this.#time;
	}

	scheduleImmediate(callback: () => void): void {
		this.#immediates.push(callback);
	}

	scheduleRender(callback: () => void, _delayMs: number): RenderTimer {
		const id = this.#nextId++;
		this.#timers.set(id, callback);
		return { cancel: () => void this.#timers.delete(id) };
	}

	get pendingTimers(): number {
		return this.#timers.size;
	}

	async flushImmediates(term: VirtualTerminal): Promise<void> {
		let rounds = 0;
		while (this.#immediates.length > 0) {
			if (++rounds > 100) throw new Error("immediates did not settle");
			const batch = this.#immediates;
			this.#immediates = [];
			for (const callback of batch) callback();
		}
		await term.flush();
	}

	/** Fire the oldest pending timer, then every immediate it queued. */
	async tick(term: VirtualTerminal): Promise<void> {
		const first = this.#timers.entries().next();
		if (first.done) return;
		this.#timers.delete(first.value[0]);
		first.value[1]();
		await this.flushImmediates(term);
	}
}

function captureWrites(term: VirtualTerminal): string[] {
	const writes: string[] = [];
	const realWrite = term.write.bind(term);
	vi.spyOn(term, "write").mockImplementation((data: string) => {
		writes.push(data);
		realWrite(data);
	});
	return writes;
}

function visible(term: VirtualTerminal): string[] {
	return term.getViewport().map(line => line.trimEnd());
}

function eraseScrollbackCount(writes: string[]): number {
	return writes.filter(chunk => chunk.includes("\x1b[3J")).length;
}

class Rows implements Component {
	renderCount = 0;
	constructor(readonly lines: string[]) {}
	invalidate(): void {}
	render(width: number): string[] {
		this.renderCount++;
		return this.lines.map(line => line.slice(0, width));
	}
}

const WIDTH = 20;
const HEIGHT = 4;
// Distinct glyph runs so a column window across `out|in` reads unambiguously.
const OUT = new Rows(["aaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbb", "cccccccccccccccccccc", "dddddddddddddddddddd"]);
const IN = new Rows(["11111111111111111111", "22222222222222222222", "33333333333333333333", "44444444444444444444"]);

function makeTui(term: VirtualTerminal): { tui: TUI; scheduler: StepScheduler } {
	const scheduler = new StepScheduler();
	const tui = new TUI(term, undefined, { renderScheduler: scheduler });
	tui.addChild(OUT);
	return { tui, scheduler };
}

async function paintedOnce(term: VirtualTerminal): Promise<{ tui: TUI; scheduler: StepScheduler }> {
	const made = makeTui(term);
	made.tui.start();
	await made.scheduler.flushImmediates(term);
	expect(visible(term)).toEqual(OUT.lines);
	return made;
}

function swapToIncoming(tui: TUI): void {
	tui.removeChild(OUT);
	tui.addChild(IN);
}

describe("a viewport slide", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("paints one column window per step on the alternate screen and never commits or erases scrollback mid-slide", async () => {
		await withEnvPatch(NO_MULTIPLEXER_ENV, async () => {
			const term = new VirtualTerminal(WIDTH, HEIGHT, 100);
			const { tui, scheduler } = await paintedOnce(term);
			try {
				const baselineFull = tui.fullRedraws;
				const from = tui.captureViewport();
				expect(from).toBeDefined();
				swapToIncoming(tui);
				const writes = captureWrites(term);
				expect(tui.slideViewport(from!, "left", { steps: 4 })).toBe(true);
				expect(tui.viewportSlideActive).toBe(true);

				// Step 1: offset 5 of 20. The window is out[5..20) + in[0..5).
				await scheduler.tick(term);
				expect(writes.join("")).toContain(ALT_SCREEN_ENTER);
				expect(visible(term)).toEqual([
					"aaaaaaaaaaaaaaa11111",
					"bbbbbbbbbbbbbbb22222",
					"ccccccccccccccc33333",
					"ddddddddddddddd44444",
				]);
				// Step 2: offset 10.
				await scheduler.tick(term);
				expect(visible(term)).toEqual([
					"aaaaaaaaaa1111111111",
					"bbbbbbbbbb2222222222",
					"cccccccccc3333333333",
					"dddddddddd4444444444",
				]);
				// Step 3: offset 15.
				await scheduler.tick(term);
				expect(visible(term)).toEqual([
					"aaaaa111111111111111",
					"bbbbb222222222222222",
					"ccccc333333333333333",
					"ddddd444444444444444",
				]);

				expect(tui.viewportSlideFrames).toBe(3);
				expect(tui.fullRedraws).toBe(baselineFull);
				expect(eraseScrollbackCount(writes)).toBe(0);
				expect(writes.join("")).not.toContain(ALT_SCREEN_EXIT);
				expect(tui.viewportSlideActive).toBe(true);
			} finally {
				tui.stop();
			}
		});
	});

	it("ends in exactly one authoritative full paint that leaves the alternate screen and shows the new children", async () => {
		await withEnvPatch(NO_MULTIPLEXER_ENV, async () => {
			const term = new VirtualTerminal(WIDTH, HEIGHT, 100);
			const { tui, scheduler } = await paintedOnce(term);
			try {
				const baselineFull = tui.fullRedraws;
				const from = tui.captureViewport()!;
				swapToIncoming(tui);
				const writes = captureWrites(term);
				tui.slideViewport(from, "left", { steps: 4 });
				// Three slid frames, then the fourth timer is the settle paint.
				let ticks = 0;
				while (tui.viewportSlideActive) {
					if (++ticks > 4) throw new Error("the slide did not end within its step count");
					await scheduler.tick(term);
				}
				expect(ticks).toBe(4);
				expect(scheduler.pendingTimers).toBe(0);

				expect(tui.fullRedraws).toBe(baselineFull + 1);
				expect(eraseScrollbackCount(writes)).toBe(1);
				const joined = writes.join("");
				expect(joined.lastIndexOf(ALT_SCREEN_EXIT)).toBeGreaterThan(joined.lastIndexOf(ALT_SCREEN_ENTER));
				expect(visible(term)).toEqual(IN.lines);
			} finally {
				tui.stop();
			}
		});
	});

	it("mirrors for a right slide: the new window enters from the left", async () => {
		await withEnvPatch(NO_MULTIPLEXER_ENV, async () => {
			const term = new VirtualTerminal(WIDTH, HEIGHT, 100);
			const { tui, scheduler } = await paintedOnce(term);
			try {
				const from = tui.captureViewport()!;
				swapToIncoming(tui);
				tui.slideViewport(from, "right", { steps: 4 });
				await scheduler.tick(term);
				expect(visible(term)).toEqual([
					"11111aaaaaaaaaaaaaaa",
					"22222bbbbbbbbbbbbbbb",
					"33333cccccccccccccccc".slice(0, WIDTH),
					"44444ddddddddddddddd",
				]);
			} finally {
				tui.stop();
			}
		});
	});

	it("resets the style at the seam so an outgoing colour never bleeds into the incoming row", async () => {
		await withEnvPatch(NO_MULTIPLEXER_ENV, async () => {
			const term = new VirtualTerminal(WIDTH, HEIGHT, 100);
			const scheduler = new StepScheduler();
			const tui = new TUI(term, undefined, { renderScheduler: scheduler });
			const red = new Rows(["\x1b[31mred red red red red\x1b[0m", "", "", ""]);
			tui.addChild(red);
			try {
				tui.start();
				await scheduler.flushImmediates(term);
				const from = tui.captureViewport()!;
				tui.removeChild(red);
				tui.addChild(new Text("plain", 0, 0));
				const writes = captureWrites(term);
				tui.slideViewport(from, "left", { steps: 2 });
				await scheduler.tick(term);
				// The slid row carries the reset between the two halves.
				const frame = writes.join("");
				expect(frame).toContain("\x1b[0m");
				expect(frame.indexOf("\x1b[31m")).toBeLessThan(frame.indexOf("plain"));
				expect(frame.lastIndexOf("\x1b[0m", frame.indexOf("plain"))).toBeGreaterThan(frame.indexOf("\x1b[31m"));
			} finally {
				tui.stop();
			}
		});
	});

	it("folds a render requested mid-slide into the settle paint instead of painting the normal screen", async () => {
		await withEnvPatch(NO_MULTIPLEXER_ENV, async () => {
			const term = new VirtualTerminal(WIDTH, HEIGHT, 100);
			const { tui, scheduler } = await paintedOnce(term);
			try {
				const baselineFull = tui.fullRedraws;
				const from = tui.captureViewport()!;
				swapToIncoming(tui);
				tui.slideViewport(from, "left", { steps: 3 });
				await scheduler.tick(term);
				const writes = captureWrites(term);
				// A streamed token on the incoming session asks for a frame.
				IN.renderCount = 0;
				tui.requestRender();
				tui.requestRender(true);
				await scheduler.flushImmediates(term);
				expect(writes.length).toBe(0);
				expect(IN.renderCount).toBe(0);
				expect(tui.fullRedraws).toBe(baselineFull);

				while (tui.viewportSlideActive) await scheduler.tick(term);
				expect(tui.fullRedraws).toBe(baselineFull + 1);
				expect(IN.renderCount).toBeGreaterThan(0);
				expect(visible(term)).toEqual(IN.lines);
			} finally {
				tui.stop();
			}
		});
	});

	it("is refused, painting nothing, wherever its alternate-screen frame is not available", async () => {
		await withEnvPatch(NO_MULTIPLEXER_ENV, async () => {
			// Before the first paint there is no window to slide from.
			const term = new VirtualTerminal(WIDTH, HEIGHT, 100);
			const { tui, scheduler } = makeTui(term);
			try {
				expect(tui.captureViewport()).toBeUndefined();
				tui.start();
				await scheduler.flushImmediates(term);
				const from = tui.captureViewport()!;

				// A resize since the snapshot: the caller's repaint stands.
				term.resize(WIDTH + 1, HEIGHT);
				expect(tui.slideViewport(from, "left")).toBe(false);
				expect(tui.viewportSlideActive).toBe(false);
				term.resize(WIDTH, HEIGHT);
				// The resize drag the resize started refuses a slide until it settles.
				expect(tui.captureViewport()).toBeUndefined();
				while (scheduler.pendingTimers > 0) await scheduler.tick(term);
				expect(tui.captureViewport()).toBeDefined();

				// A visible overlay composites over the window; no slide under it.
				const handle = tui.showOverlay(new Text("modal", 0, 0));
				await scheduler.flushImmediates(term);
				expect(tui.captureViewport()).toBeUndefined();
				expect(tui.slideViewport(from, "left")).toBe(false);
				handle.hide();
				await scheduler.flushImmediates(term);

				// A second slide while one runs.
				const again = tui.captureViewport()!;
				expect(tui.slideViewport(again, "left", { steps: 3 })).toBe(true);
				expect(tui.captureViewport()).toBeUndefined();
				expect(tui.slideViewport(again, "right")).toBe(false);
				while (tui.viewportSlideActive) await scheduler.tick(term);
			} finally {
				tui.stop();
			}
		});
		// A multiplexer repaints in place and has no borrowed alternate screen.
		await withEnvPatch({ ...NO_MULTIPLEXER_ENV, TMUX: "/tmp/tmux-1000/default,1,0" }, async () => {
			const term = new VirtualTerminal(WIDTH, HEIGHT, 100);
			const { tui, scheduler } = makeTui(term);
			try {
				tui.start();
				await scheduler.flushImmediates(term);
				expect(tui.captureViewport()).toBeUndefined();
			} finally {
				tui.stop();
			}
		});
	});

	it("dies with its host: stop() cancels the frames and leaves the alternate screen", async () => {
		await withEnvPatch(NO_MULTIPLEXER_ENV, async () => {
			const term = new VirtualTerminal(WIDTH, HEIGHT, 100);
			const { tui, scheduler } = await paintedOnce(term);
			const from = tui.captureViewport()!;
			swapToIncoming(tui);
			tui.slideViewport(from, "left", { steps: 4 });
			await scheduler.tick(term);
			const writes = captureWrites(term);
			tui.stop();
			expect(tui.viewportSlideActive).toBe(false);
			expect(scheduler.pendingTimers).toBe(0);
			expect(writes.join("")).toContain(ALT_SCREEN_EXIT);
		});
	});
});

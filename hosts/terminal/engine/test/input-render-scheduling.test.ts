import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { type Component, type RenderTimer, TUI } from "@veyyon/tui";
import * as terminalSession from "../src/core/terminal-session";
import { VirtualTerminal } from "./virtual-terminal";

class InputProbe implements Component {
	constructor(private readonly events: string[]) {}

	invalidate(): void {}

	render(_width: number): readonly string[] {
		this.events.push("render");
		return ["probe"];
	}

	handleInput(_data: string): void {
		this.events.push("input");
	}
}

class DeferredRenderScheduler {
	nowMs = 0;
	readonly immediates: Array<() => void> = [];
	readonly timers: Array<{ callback: () => void; canceled: boolean }> = [];

	now(): number {
		return this.nowMs;
	}

	scheduleImmediate(callback: () => void): void {
		this.immediates.push(callback);
	}

	scheduleRender(callback: () => void, _delayMs: number): RenderTimer {
		const timer = { callback, canceled: false };
		this.timers.push(timer);
		return {
			cancel: () => {
				timer.canceled = true;
			},
		};
	}
}

function flushTimers(scheduler: DeferredRenderScheduler): void {
	const pending = scheduler.timers.splice(0, scheduler.timers.length);
	for (const timer of pending) if (!timer.canceled) timer.callback();
}

describe("TUI input/render scheduling", () => {
	it("can process terminal input before a deferred ordinary repaint", () => {
		const term = new VirtualTerminal(20, 4);
		const scheduler = new DeferredRenderScheduler();
		const events: string[] = [];
		const probe = new InputProbe(events);
		const tui = new TUI(term, undefined, { renderScheduler: scheduler });
		tui.addChild(probe);
		tui.setFocus(probe);

		try {
			tui.start();
			scheduler.immediates.shift()?.();
			// Fire every queued timer, not just the first: the engine also arms a mouse-grab
			// idle backstop at startup, and this test is about input-vs-repaint ORDER, not
			// about how many timers the engine happens to keep.
			flushTimers(scheduler);
			events.length = 0;
			scheduler.nowMs = 100;

			tui.requestRender();
			term.sendInput("x");
			scheduler.immediates.shift()?.();
			flushTimers(scheduler);

			expect(events[0]).toBe("input");
			expect(events).toContain("render");
		} finally {
			tui.stop();
		}
	});
});

/**
 * Immediate input must update the terminal without advancing the render clock or
 * replaying unchanged rows. Pending full repaints and scrollback clears must survive
 * a later input request. OS input delivery is covered by the compiled startup probe.
 */
class RecordingTerminal extends VirtualTerminal {
	readonly writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

function flushImmediates(scheduler: DeferredRenderScheduler): void {
	const pending = scheduler.immediates.splice(0);
	for (const callback of pending) callback();
}

function inputFrameFixture(withHistory = false) {
	const term = new RecordingTerminal(40, 4);
	if (withHistory) term.write("external-history\r\n".repeat(8));
	const scheduler = new DeferredRenderScheduler();
	const tui = new TUI(term, undefined, { renderScheduler: scheduler });
	let rows = ["unchanged-header", "draft"];
	tui.addChild({ invalidate() {}, render: () => rows });
	tui.start();
	flushImmediates(scheduler);
	flushTimers(scheduler);
	term.writes.length = 0;
	return {
		term,
		scheduler,
		tui,
		changeDraft: () => {
			rows = ["unchanged-header", "draft-q"];
		},
		viewport: () =>
			term
				.getViewport()
				.slice(0, 2)
				.map(row => stripVTControlCharacters(row).trimEnd()),
	};
}

describe("immediate input preserves the viewport diff", () => {
	beforeEach(() => {
		vi.spyOn(terminalSession, "isMultiplexerSession").mockReturnValue(false);
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("paints changed text before deferred timers without replaying unchanged rows", () => {
		const frame = inputFrameFixture();
		try {
			expect(frame.viewport()).toEqual(["unchanged-header", "draft"]);
			frame.changeDraft();
			frame.tui.requestRender();
			flushImmediates(frame.scheduler);
			expect(frame.viewport()).toEqual(["unchanged-header", "draft"]);

			const before = frame.scheduler.nowMs;
			frame.tui.requestRender(true, { preserveViewport: true });
			flushImmediates(frame.scheduler);

			expect(frame.scheduler.nowMs).toBe(before);
			expect(frame.viewport()).toEqual(["unchanged-header", "draft-q"]);
			expect(frame.term.writes.join("")).not.toContain("unchanged-header");
			const painted = frame.term.writes.join("");
			flushTimers(frame.scheduler);
			expect(frame.term.writes.join("")).toBe(painted);
		} finally {
			frame.tui.stop();
		}
	});

	it("retains full viewport repainting by default", () => {
		const frame = inputFrameFixture();
		try {
			frame.changeDraft();
			frame.tui.requestRender(true);
			flushImmediates(frame.scheduler);
			expect(frame.viewport()).toEqual(["unchanged-header", "draft-q"]);
			expect(frame.term.writes.join("")).toContain("unchanged-header");
		} finally {
			frame.tui.stop();
		}
	});

	it("honors an explicit scrollback clear with viewport preservation requested", () => {
		const frame = inputFrameFixture(true);
		try {
			expect(frame.term.getScrollBuffer().join("\n")).toContain("external-history");
			frame.changeDraft();
			frame.tui.requestRender(true, { preserveViewport: true, clearScrollback: true });
			flushImmediates(frame.scheduler);
			expect(frame.term.getScrollBuffer().join("\n")).not.toContain("external-history");
			expect(frame.viewport()).toEqual(["unchanged-header", "draft-q"]);
		} finally {
			frame.tui.stop();
		}
	});

	it.each([false, true])("preserves an earlier forced request with clearScrollback=%s", clearScrollback => {
		const frame = inputFrameFixture(true);
		try {
			expect(frame.term.getScrollBuffer().join("\n")).toContain("external-history");
			frame.changeDraft();
			frame.tui.requestRender(true, { clearScrollback });
			frame.tui.requestRender(true, { preserveViewport: true });
			flushImmediates(frame.scheduler);
			expect(frame.viewport()).toEqual(["unchanged-header", "draft-q"]);
			expect(frame.term.writes.join("")).toContain("unchanged-header");
			if (clearScrollback) {
				expect(frame.term.getScrollBuffer().join("\n")).not.toContain("external-history");
			} else {
				expect(frame.term.getScrollBuffer().join("\n")).toContain("external-history");
			}
		} finally {
			frame.tui.stop();
		}
	});
});

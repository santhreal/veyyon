import { afterEach, describe, expect, it } from "bun:test";
import { type Component, type RenderTimer, TUI } from "@veyyon/tui";
import { ActivitySignal } from "@veyyon/utils/activity-signal";
import { VirtualTerminal } from "./virtual-terminal";

/**
 * Contract: between start() and stop() the engine is a host of its activity signal and reports
 * every keystroke before dispatching it and every frame before composing it, so a sampler parked
 * on the signal wakes for the work. Outside that span it is no host, so nothing parks on it.
 *
 * WHY THIS EXISTS. The loop watchdog and the idle trim stop their timers at rest only while a host
 * reports work, and wake on the next report. An engine that stopped reporting either kind of work
 * would leave the watchdog parked through it, so a stall the operator sees would go unlogged; an
 * engine that stayed a host after stop() would let samplers park with nothing left to wake them.
 *
 * What it does not catch: work that reaches the screen by neither path. A turn that runs with no
 * frame and no keystroke is not reported; the working clock repaints every second while a turn runs.
 */

class InputProbe implements Component {
	readonly events: string[];

	constructor(events: string[]) {
		this.events = events;
	}

	invalidate(): void {}

	render(_width: number): readonly string[] {
		this.events.push("render");
		return ["probe"];
	}

	handleInput(data: string): void {
		this.events.push(`input:${data}`);
	}
}

class ManualRenderScheduler {
	readonly immediates: Array<() => void> = [];
	readonly timers: Array<{ callback: () => void; canceled: boolean }> = [];

	now(): number {
		return 0;
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

	flush(): void {
		while (this.immediates.length > 0 || this.timers.length > 0) {
			while (this.immediates.length > 0) this.immediates.shift()?.();
			for (const timer of this.timers.splice(0)) if (!timer.canceled) timer.callback();
		}
	}
}

const engines: TUI[] = [];
afterEach(() => {
	for (const tui of engines.splice(0)) tui.stop();
});

function engine(): {
	tui: TUI;
	term: VirtualTerminal;
	scheduler: ManualRenderScheduler;
	activity: ActivitySignal;
	events: string[];
} {
	const term = new VirtualTerminal(20, 4);
	const scheduler = new ManualRenderScheduler();
	const activity = new ActivitySignal();
	const events: string[] = [];
	const probe = new InputProbe(events);
	const tui = new TUI(term, undefined, { renderScheduler: scheduler, activity });
	tui.addChild(probe);
	tui.setFocus(probe);
	engines.push(tui);
	return { tui, term, scheduler, activity, events };
}

describe("a started engine reports its keystrokes and frames", () => {
	it("is no host before start(), so nothing parks on its signal", () => {
		const { activity } = engine();
		expect(activity.park(() => {})).toBe(false);
	});

	it("wakes a parked sampler before it dispatches a keystroke", () => {
		const { tui, term, scheduler, activity, events } = engine();
		tui.start();
		scheduler.flush();
		events.length = 0;
		expect(activity.park(() => void events.push("wake"))).toBe(true);
		term.sendInput("x");
		expect(events).toEqual(["wake", "input:x"]);
	});

	it("wakes a parked sampler before it composes a frame", () => {
		const { tui, scheduler, activity, events } = engine();
		tui.start();
		scheduler.flush();
		events.length = 0;
		expect(activity.park(() => void events.push("wake"))).toBe(true);
		tui.requestRender();
		scheduler.flush();
		expect(events.slice(0, 2)).toEqual(["wake", "render"]);
		expect(events.filter(event => event === "wake")).toHaveLength(1);
	});

	it("leaves its signal at stop(), waking what was parked, and joins it again at the next start()", () => {
		const { tui, scheduler, activity, events } = engine();
		tui.start();
		// A second start() while running is one host, so one stop() leaves the signal.
		tui.start();
		scheduler.flush();
		expect(activity.park(() => void events.push("wake"))).toBe(true);
		tui.stop();
		expect(events.at(-1)).toBe("wake");
		expect(activity.park(() => {})).toBe(false);
		tui.start();
		expect(activity.park(() => {})).toBe(true);
	});
});

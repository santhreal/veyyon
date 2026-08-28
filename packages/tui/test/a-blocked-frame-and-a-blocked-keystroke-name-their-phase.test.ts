import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type Component, type RenderTimer, TUI } from "@veyyon/tui";
import { currentLoopPhase, popLoopPhase, takeLoopPhaseProfile } from "@veyyon/utils"
import { VirtualTerminal } from "./virtual-terminal";

/**
 * Contract: the two synchronous spans an interactive session spends its time in
 * — the render pass and terminal input dispatch — carry a loop-phase breadcrumb,
 * so a `ui.loop-blocked` warning names what blocked instead of "unknown".
 *
 * WHY THIS EXISTS, measured rather than assumed. Across 56 local session logs the
 * watchdog recorded 2249 blocks, up to 11 seconds each, and 2182 of them said
 * `phase: "unknown"`. Three production call sites pushed a phase at the time
 * (two subagent spans and the SelectList filter), so the field that decides
 * whether a stall is actionable was empty for 97% of them. A watchdog whose
 * cause is always unknown reports that something is wrong and nothing else.
 *
 * The assertion reads the phase from INSIDE the span, through the component the
 * engine calls, which is the only place a live phase can be observed: both spans
 * push and pop within one synchronous macrotask, so a caller checking afterwards
 * sees a balanced stack. Deleting either `pushLoopPhase` leaves every watchdog
 * and loop-phase unit test green and turns the matching case here red.
 *
 * What it does not catch: whether the phase NAMES the right work. A render that
 * blocks inside a child component is still reported as `ui.render`, which is the
 * span, not the culprit within it. Narrowing that is the next breadcrumb's job.
 */
/**
 * The phase accounting is a process-global, and any suite that renders a frame
 * banks cost into it. Drain it around each case, BEFORE as well as after, so a
 * leftover from another file in the same process cannot win a read here.
 */
function drainLoopPhases(): void {
	while (currentLoopPhase() !== undefined) popLoopPhase();
	takeLoopPhaseProfile();
}

beforeEach(drainLoopPhases);
afterEach(drainLoopPhases);

/** Records the phase the engine holds while it calls into a component. */
class PhaseProbe implements Component {
	renderPhases: Array<string | undefined> = [];
	inputPhases: Array<string | undefined> = [];

	invalidate(): void {}

	render(_width: number): readonly string[] {
		this.renderPhases.push(currentLoopPhase());
		return ["probe"];
	}

	handleInput(_data: string): void {
		this.inputPhases.push(currentLoopPhase());
	}
}

class ImmediateRenderScheduler {
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

	flush(): void {
		while (this.immediates.length > 0) this.immediates.shift()?.();
		const pending = this.timers.splice(0, this.timers.length);
		for (const timer of pending) if (!timer.canceled) timer.callback();
	}
}

function drive(): { tui: TUI; probe: PhaseProbe; scheduler: ImmediateRenderScheduler; term: VirtualTerminal } {
	const term = new VirtualTerminal(20, 4);
	const scheduler = new ImmediateRenderScheduler();
	const probe = new PhaseProbe();
	const tui = new TUI(term, undefined, { renderScheduler: scheduler });
	tui.addChild(probe);
	tui.setFocus(probe);
	return { tui, probe, scheduler, term };
}

describe("a blocked frame and a blocked keystroke name their phase", () => {
	it("holds ui.render for the whole compose", () => {
		const { tui, probe, scheduler } = drive();

		try {
			tui.start();
			scheduler.flush();

			expect(probe.renderPhases.length).toBeGreaterThan(0);
			// Every compose, not just the first: a phase pushed on the initial paint
			// and lost on the throttled ones would leave a streaming session unnamed.
			expect([...new Set(probe.renderPhases)]).toEqual(["ui.render"]);
		} finally {
			tui.stop();
		}
	});

	it("holds ui.input for the keystroke the component handles", () => {
		const { tui, probe, scheduler, term } = drive();

		try {
			tui.start();
			scheduler.flush();
			probe.renderPhases.length = 0;

			term.sendInput("x");

			expect(probe.inputPhases).toEqual(["ui.input"]);
			// The keystroke's own repaint is a separate span, scheduled rather than run
			// inside the handler, so the two never nest: a compose blamed on `ui.input`
			// would point at the wrong work.
			scheduler.flush();
			expect([...new Set(probe.renderPhases)]).toEqual(["ui.render"]);
		} finally {
			tui.stop();
		}
	});

	it("leaves the phase stack balanced, so a later block is not blamed on a finished frame", () => {
		const { tui, scheduler, term } = drive();

		try {
			tui.start();
			scheduler.flush();
			term.sendInput("y");
			scheduler.flush();

			expect(currentLoopPhase()).toBeUndefined();
			// Both spans ran and both were cheap, so which one is costliest is a race
			// between two microsecond measurements — the guarantee is that a span that
			// ran is nameable for exactly one read.
			// `?? "(none)"` keeps this a string, so an unnamed phase fails here rather than
			// failing to type-check.
			expect(["ui.render", "ui.input"]).toContain(takeLoopPhaseProfile().phase ?? "(none)");
			// And is never carried into a later, phase-less interval.
			expect(takeLoopPhaseProfile().phase).toBeUndefined();
		} finally {
			tui.stop();
		}
	});
});

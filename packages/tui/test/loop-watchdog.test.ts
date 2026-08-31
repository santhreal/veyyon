import { afterEach, describe, expect, test, vi } from "bun:test";
import { LoopWatchdog } from "@veyyon/tui/loop-watchdog";
import { currentLoopPhase, logger, popLoopPhase, pushLoopPhase, takeLoopPhaseProfile } from "@veyyon/utils";

/**
 * Contract: LoopWatchdog turns event-loop lag into exactly one
 * `logger.warn("ui.loop-blocked", { blockedMs, phase, phaseMs })` line per block.
 * A tick that fires more than `thresholdMs` past its `intervalMs` deadline is a
 * block; it is logged once on the rising edge (deduped while the loop stays
 * blocked), and a stopped watchdog emits nothing even for a tick already armed
 * before stop().
 *
 * A phase is named as the cause only when it was open for at least half the
 * block. Below that the line reports `phase: "unknown"` and carries the observed
 * label as `topPhase` — evidence that rules that phase OUT rather than blaming
 * it. Four spans in the product push a phase at all, so a label alone is a
 * breadcrumb and hundreds of real blocks were misread because of it.
 *
 * The deadline clock is injected so elapsed time is driven deterministically
 * instead of slept. Phase cost is measured on the real clock, so a case that
 * needs an attributed phase holds it across a real busy-wait and keeps the
 * threshold small enough for that to stay quick.
 */
function spin(ms: number): void {
	const until = performance.now() + ms;
	while (performance.now() < until) {
		// Busy-wait: holding the loop is exactly what the watchdog measures.
	}
}

function harness(options: Partial<{ intervalMs: number; thresholdMs: number }> = {}) {
	let nowValue = 0;
	let scheduled: (() => void) | undefined;
	const now = () => nowValue;
	const schedule = (cb: () => void) => {
		scheduled = cb;
		return {};
	};
	const wd = new LoopWatchdog({ now, schedule, ...options });
	return {
		wd,
		setNow(value: number): void {
			nowValue = value;
		},
		fireTick(): void {
			const cb = scheduled;
			if (!cb) throw new Error("no tick was scheduled");
			cb();
		},
	};
}

type BlockedContext = { blockedMs: number; phase: string; phaseMs: number; topPhase?: string };

/**
 * The lines the watchdog logged, in order. Every case below asserts what was reported, which is
 * the contract this component has with the log, rather than that a spy fired.
 */
function captureWarnings(): Array<{ event: string; ctx: BlockedContext }> {
	const lines: Array<{ event: string; ctx: BlockedContext }> = [];
	vi.spyOn(logger, "warn").mockImplementation(((event: string, ctx: BlockedContext) => {
		lines.push({ event, ctx });
	}) as never);
	return lines;
}

afterEach(() => {
	vi.restoreAllMocks();
	// The phase stack is a process-global; drain anything these cases pushed.
	while (currentLoopPhase() !== undefined) popLoopPhase();
	// Drain the consume-on-read recent slot too, so a phase one case set cannot
	// leak into another's attribution assertion.
	takeLoopPhaseProfile().phase;
});

describe("LoopWatchdog", () => {
	test("names the phase that was open for the block, with the cost that earns it", () => {
		const warnings = captureWarnings();
		// A small threshold keeps the real busy-wait short while still being a block.
		const { wd, setNow, fireTick } = harness({ intervalMs: 20, thresholdMs: 20 });

		pushLoopPhase("render");
		wd.start(); // deadline armed at now(0)+20 = 20
		spin(40); // the phase really does hold the loop
		setNow(70); // tick fires at 70 → blockedMs = 50, and the phase covers it
		fireTick();

		expect(warnings.map(line => line.event)).toEqual(["ui.loop-blocked"]);
		const ctx = warnings[0]!.ctx;
		expect(ctx.phase).toBe("render");
		expect(ctx.blockedMs).toBeGreaterThanOrEqual(20);
		expect(ctx.phaseMs).toBeGreaterThanOrEqual(25);
	});

	/**
	 * THE DEFECT: a phase that ran for a sliver of the interval was reported as
	 * the cause. Every instrumented span in an interactive session is cheap, so
	 * this is what a real block looked like in the logs — 250-650ms attributed to
	 * a render pass that benchmarks at 0.03ms.
	 */
	test("refuses to blame a phase that ran for a sliver of the block", () => {
		const warnings = captureWarnings();
		const { wd, setNow, fireTick } = harness(); // intervalMs=250, thresholdMs=250

		// Pushed and popped immediately: real cost is microseconds.
		pushLoopPhase("ui.render");
		popLoopPhase();
		wd.start(); // deadline armed at 250
		setNow(560); // blockedMs = 310, none of which the render pass spent
		fireTick();

		expect(warnings).toHaveLength(1);
		const ctx = warnings[0]!.ctx;
		// The cause is genuinely unknown, and the cheap phase is reported as ruled out.
		expect(ctx.phase).toBe("unknown");
		expect(ctx.topPhase).toBe("ui.render");
		expect(ctx.phaseMs).toBeLessThan(155);
	});

	test("stays silent when a tick fires on its deadline", () => {
		const warnings = captureWarnings();
		const { wd, setNow, fireTick } = harness();

		pushLoopPhase("render");
		wd.start(); // deadline at 250
		setNow(250); // blockedMs = 0, not a block
		fireTick();

		expect(warnings).toEqual([]);
	});

	test("dedupes a sustained block: two consecutive late ticks log only once", () => {
		const warnings = captureWarnings();
		const { wd, setNow, fireTick } = harness();

		pushLoopPhase("render");
		wd.start(); // deadline at 250
		setNow(600); // blockedMs = 350 → rising edge, logs once; re-armed deadline = 850
		fireTick();
		setNow(1200); // blockedMs = 350 again, but still blocked → no second log
		fireTick();

		expect(warnings).toHaveLength(1);
	});

	test("emits nothing for a tick that fires after stop()", () => {
		const warnings = captureWarnings();
		const { wd, setNow, fireTick } = harness();

		pushLoopPhase("render");
		wd.start(); // deadline at 250
		setNow(600); // first block logs once and re-arms a follow-up tick
		fireTick();
		expect(warnings).toHaveLength(1);

		wd.stop();
		setNow(5000); // the already-armed follow-up tick would otherwise be a huge block
		fireTick();

		expect(warnings).toHaveLength(1); // stop() short-circuits the stale tick
	});

	test("a phase popped before the tick still reaches the line, and is attributed when it earns it", () => {
		const warnings = captureWarnings();
		const { wd, setNow, fireTick } = harness({ intervalMs: 20, thresholdMs: 20 });

		wd.start(); // deadline 20
		// A hot sync path pushes and pops its phase within one macrotask, so the
		// stack is empty by the time the delayed tick runs. Its banked cost must
		// still surface the culprit instead of "unknown".
		pushLoopPhase("ui.select-filter");
		spin(40);
		popLoopPhase();
		setNow(70); // blockedMs = 50, which the filter spent
		fireTick();

		expect(warnings).toHaveLength(1);
		const ctx = warnings[0]!.ctx;
		expect(ctx.phase).toBe("ui.select-filter");
		expect(ctx.phaseMs).toBeGreaterThanOrEqual(25);
	});

	test("does not misattribute a finished phase to a later phase-less block", () => {
		const warnings = captureWarnings();
		const { wd, setNow, fireTick } = harness();

		wd.start(); // deadline 250
		pushLoopPhase("ui.select-filter");
		popLoopPhase();
		setNow(250); // on-time tick consumes the recent phase, logs nothing; re-arm 500
		fireTick();
		setNow(900); // block in the next interval with no phase active
		fireTick();

		expect(warnings).toHaveLength(1);
		expect(warnings[0]!.ctx.phase).toBe("unknown");
	});

	test("re-arms after recovery: late then on-time then late logs twice", () => {
		const warnings = captureWarnings();
		const { wd, setNow, fireTick } = harness();

		pushLoopPhase("render");
		wd.start(); // deadline 250
		setNow(600); // block #1 (350) → logs; re-arm 850
		fireTick();
		setNow(850); // on-time → falling edge resets #wasBlocked; re-arm 1100
		fireTick();
		setNow(1450); // block #2 (350) → logs again
		fireTick();

		expect(warnings).toHaveLength(2);
	});

	test("a pre-stop tick no-ops after start() -> stop() -> start() and arms no parallel chain", () => {
		const warnings = captureWarnings();
		let nowValue = 0;
		const callbacks: Array<() => void> = [];
		const schedule = (cb: () => void) => {
			callbacks.push(cb);
			return {};
		};
		const wd = new LoopWatchdog({ now: () => nowValue, schedule });

		wd.start(); // arms callbacks[0] under generation 0
		const stale = callbacks[callbacks.length - 1]!;
		wd.stop(); // generation bumped
		wd.start(); // arms callbacks[1] under generation 1
		expect(callbacks).toHaveLength(2);

		nowValue = 5000; // the stale callback would otherwise be a huge block
		stale();

		expect(warnings).toEqual([]); // generation mismatch short-circuits
		expect(callbacks).toHaveLength(2); // and it did NOT re-arm a parallel timer chain
	});

	test("unrefs every scheduled timer handle so the always-on probe never holds the process open", () => {
		captureWarnings();
		let unrefs = 0;
		const unref = () => {
			unrefs += 1;
		};
		let nowValue = 0;
		let cb: (() => void) | undefined;
		const schedule = (c: () => void) => {
			cb = c;
			return { unref };
		};
		const wd = new LoopWatchdog({ now: () => nowValue, schedule });

		wd.start();
		expect(unrefs).toBe(1); // armed on start
		nowValue = 600;
		cb?.(); // late tick logs and re-arms
		expect(unrefs).toBe(2); // the re-armed handle is unref'd too
	});

	test("stop() cancels the armed timer handle so no stale tick is left pending", () => {
		let cancels = 0;
		const cancel = () => {
			cancels += 1;
		};
		const schedule = (_cb: () => void) => ({ cancel });
		const wd = new LoopWatchdog({ now: () => 0, schedule });

		wd.start(); // arms a handle exposing cancel()
		wd.stop();

		expect(cancels).toBe(1);
	});
});

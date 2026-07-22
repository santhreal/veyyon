import { describe, expect, it } from "bun:test";
import {
	EVAL_TIMEOUT_PAUSE_OP,
	EVAL_TIMEOUT_RESUME_OP,
	isEvalTimeoutControlEvent,
	withBridgeTimeoutPause,
} from "@veyyon/coding-agent/eval/bridge-timeout";
import { executeWithKernelBase, type GenericKernel } from "@veyyon/coding-agent/eval/executor-base";
import type { JsStatusEvent } from "@veyyon/coding-agent/eval/js/shared/types";
import type { KernelDisplayOutput } from "@veyyon/coding-agent/eval/py/display";

/**
 * withBridgeTimeoutPause brackets a host-side eval bridge call (agent()/parallel()/
 * completion()) with synthetic pause/resume status events so the cell watchdog stops
 * counting delegated work against the cell timeout. The resume MUST be emitted even
 * when the bridged operation throws: a missing resume leaves the watchdog paused
 * forever, so a later-hung cell would never time out. isEvalTimeoutControlEvent tells
 * consumers to swallow these synthetic events instead of rendering/persisting them.
 * Neither had a test. These pin the emit order, the always-resume-on-throw contract,
 * the no-sink passthrough, and the deferExternalAbort flag propagation.
 *
 * The two executeWithKernelBase integration tests below pin the deferExternalAbort
 * semantics end-to-end: an agent bridge call that raised deferExternalAbort must hold
 * an external interrupt until it resumes (so a spawn tree is not torn down mid-call),
 * while a completion bridge call (no defer flag) must let the abort land immediately.
 */

function recorder() {
	const events: JsStatusEvent[] = [];
	return { events, emit: (e: JsStatusEvent) => events.push(e) };
}

describe("isEvalTimeoutControlEvent", () => {
	it("matches the pause and resume ops", () => {
		expect(isEvalTimeoutControlEvent({ op: EVAL_TIMEOUT_PAUSE_OP })).toBe(true);
		expect(isEvalTimeoutControlEvent({ op: EVAL_TIMEOUT_RESUME_OP })).toBe(true);
	});

	it("does not match an ordinary status op", () => {
		expect(isEvalTimeoutControlEvent({ op: "read" })).toBe(false);
		expect(isEvalTimeoutControlEvent({ op: "write" })).toBe(false);
		// A real delegated-agent progress event must render/persist normally, not be swallowed.
		expect(isEvalTimeoutControlEvent({ op: "agent", id: "subagent-1" })).toBe(false);
	});
});

describe("withBridgeTimeoutPause", () => {
	it("emits pause then resume around a successful operation and returns its value", async () => {
		const { events, emit } = recorder();
		const result = await withBridgeTimeoutPause(emit, async () => 42);
		expect(result).toBe(42);
		expect(events).toEqual([{ op: EVAL_TIMEOUT_PAUSE_OP }, { op: EVAL_TIMEOUT_RESUME_OP }]);
	});

	it("still emits resume when the operation throws (watchdog cannot stay paused)", async () => {
		const { events, emit } = recorder();
		await expect(
			withBridgeTimeoutPause(emit, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(events).toEqual([{ op: EVAL_TIMEOUT_PAUSE_OP }, { op: EVAL_TIMEOUT_RESUME_OP }]);
	});

	it("runs the operation without emitting anything when no status sink is wired", async () => {
		let ran = false;
		const result = await withBridgeTimeoutPause(undefined, async () => {
			ran = true;
			return "ok";
		});
		expect(ran).toBe(true);
		expect(result).toBe("ok");
	});

	it("propagates deferExternalAbort on both the pause and resume events", async () => {
		const { events, emit } = recorder();
		await withBridgeTimeoutPause(emit, async () => undefined, { deferExternalAbort: true });
		expect(events).toEqual([
			{ op: EVAL_TIMEOUT_PAUSE_OP, deferExternalAbort: true },
			{ op: EVAL_TIMEOUT_RESUME_OP, deferExternalAbort: true },
		]);
	});

	it("omits deferExternalAbort when the option is absent", async () => {
		const { events, emit } = recorder();
		await withBridgeTimeoutPause(emit, async () => undefined);
		expect(events[0]).not.toHaveProperty("deferExternalAbort");
		expect(events[1]).not.toHaveProperty("deferExternalAbort");
	});

	it("emits the pause before the operation starts and resume after it finishes", async () => {
		const order: string[] = [];
		const emit = (e: JsStatusEvent) => order.push(e.op);
		await withBridgeTimeoutPause(emit, async () => {
			order.push("operation");
		});
		expect(order).toEqual([EVAL_TIMEOUT_PAUSE_OP, "operation", EVAL_TIMEOUT_RESUME_OP]);
	});
});

class TestCancelledError extends Error {
	readonly timedOut: boolean;

	constructor(timedOut: boolean) {
		super(timedOut ? "timed out" : "cancelled");
		this.name = "TestCancelledError";
		this.timedOut = timedOut;
	}
}

describe("executeWithKernelBase external-abort deferral", () => {
	it("defers external aborts until an in-flight agent bridge call resumes", async () => {
		const abortController = new AbortController();
		const entered = Promise.withResolvers<void>();
		const triggerAbort = Promise.withResolvers<void>();
		const observed = Promise.withResolvers<boolean>();
		const release = Promise.withResolvers<void>();
		const kernel: GenericKernel<Record<string, string | null>> = {
			async execute(_code, options) {
				entered.resolve();
				await triggerAbort.promise;
				options.onDisplay({
					type: "status",
					event: { op: EVAL_TIMEOUT_PAUSE_OP, deferExternalAbort: true },
				} satisfies KernelDisplayOutput);
				abortController.abort(new Error("external interrupt"));
				// While a defer-flagged pause is active, the abort must NOT reach the kernel signal yet.
				observed.resolve(options.signal?.aborted ?? false);
				await release.promise;
				options.onDisplay({
					type: "status",
					event: { op: EVAL_TIMEOUT_RESUME_OP, deferExternalAbort: true },
				} satisfies KernelDisplayOutput);
				return { status: "ok", cancelled: false, timedOut: false };
			},
		};

		const resultPromise = executeWithKernelBase({
			kernel,
			code: "agent('slow')",
			options: { signal: abortController.signal },
			runIdPrefix: "test",
			errorLogLabel: "test",
			cancelledErrorClass: TestCancelledError,
			buildKernelEnvPatch: () => ({}),
			formatKernelTimeoutAnnotation: () => "kernel timed out",
			formatTimeoutAnnotation: () => "timed out",
		});

		await entered.promise;
		triggerAbort.resolve();
		expect(await observed.promise).toBe(false); // deferred: signal not yet aborted mid-call
		release.resolve();
		const result = await resultPromise;
		expect(result.cancelled).toBe(true);
		expect(result.exitCode).toBeUndefined();
	});

	it("does not defer external aborts for a completion bridge call", async () => {
		const abortController = new AbortController();
		const entered = Promise.withResolvers<void>();
		const triggerAbort = Promise.withResolvers<void>();
		const observed = Promise.withResolvers<boolean>();
		const release = Promise.withResolvers<void>();
		const kernel: GenericKernel<Record<string, string | null>> = {
			async execute(_code, options) {
				entered.resolve();
				await triggerAbort.promise;
				// No deferExternalAbort flag: a plain pause must let the abort land immediately.
				options.onDisplay({
					type: "status",
					event: { op: EVAL_TIMEOUT_PAUSE_OP },
				} satisfies KernelDisplayOutput);
				abortController.abort(new Error("external interrupt"));
				observed.resolve(options.signal?.aborted ?? false);
				await release.promise;
				options.onDisplay({
					type: "status",
					event: { op: EVAL_TIMEOUT_RESUME_OP },
				} satisfies KernelDisplayOutput);
				return { status: "ok", cancelled: false, timedOut: false };
			},
		};

		const resultPromise = executeWithKernelBase({
			kernel,
			code: "completion('slow')",
			options: { signal: abortController.signal },
			runIdPrefix: "test",
			errorLogLabel: "test",
			cancelledErrorClass: TestCancelledError,
			buildKernelEnvPatch: () => ({}),
			formatKernelTimeoutAnnotation: () => "kernel timed out",
			formatTimeoutAnnotation: () => "timed out",
		});

		await entered.promise;
		triggerAbort.resolve();
		expect(await observed.promise).toBe(true); // not deferred: signal aborted immediately
		release.resolve();
		const result = await resultPromise;
		expect(result.cancelled).toBe(true);
		expect(result.exitCode).toBeUndefined();
	});
});

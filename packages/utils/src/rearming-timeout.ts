/** The handle `rearmingTimeout` returns from every call. */
export interface RearmedTimeout {
	/** Lets the process exit while the timeout is armed. */
	unref(): void;
	/** Disarms the timeout. The next call arms a new one. */
	cancel(): void;
}

/** Arms `cb` to run once after `ms`. */
export type RearmSchedule = (cb: () => void, ms: number) => RearmedTimeout;

/**
 * Returns a schedule for a callback that arms its own next run, such as a sampling tick. Each call
 * re-arms one `setTimeout` with `refresh()` and runs the callback of the latest call, instead of
 * creating a timeout per tick.
 *
 * MEASURED on Bun 1.4.0, an idle process holding 600,000 objects and ticking every 250ms: a new
 * `setTimeout` per tick kept Bun's GC timer collecting, 2,762 wakeups of the collector's helper
 * threads and 32ms of CPU over 30s, and the same tick re-armed with `refresh()` measured 327
 * wakeups and 11ms. On the linux-x64 binary of an idle interactive session, re-arming the loop
 * watchdog and the idle trim this way moved the process from about 4,000 thread wakeups per 30s to
 * about 3,600, about 2,750 of them still the collector's helpers: the tick itself moves the heap,
 * which `ActivitySignal` addresses by parking the tick at rest.
 *
 * A call with a different delay, or after `cancel()`, arms a new timeout: a cleared timeout does
 * not fire again on `refresh()`.
 */
export function rearmingTimeout(): RearmSchedule {
	let timer: NodeJS.Timeout | undefined;
	let delayMs = 0;
	let callback: (() => void) | undefined;
	const fire = (): void => callback?.();
	const handle: RearmedTimeout = {
		unref: () => {
			timer?.unref();
		},
		cancel: () => {
			if (timer === undefined) return;
			clearTimeout(timer);
			timer = undefined;
		},
	};
	return (cb, ms) => {
		callback = cb;
		if (timer !== undefined && ms === delayMs) {
			timer.refresh();
		} else {
			clearTimeout(timer);
			timer = setTimeout(fire, ms);
			delayMs = ms;
		}
		return handle;
	};
}

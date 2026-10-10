/**
 * The clock and timers a `TUI` schedules its frames on. A host or a test supplies its own through
 * `TUIOptions.renderScheduler`; the default runs on the process clock, `setImmediate` and `setTimeout`.
 */
import { performance } from "node:perf_hooks";

export interface RenderTimer {
	cancel(): void;
}

export interface RenderScheduler {
	now(): number;
	scheduleImmediate(callback: () => void): void;
	scheduleRender(callback: () => void, delayMs: number): RenderTimer;
}

export const DEFAULT_RENDER_SCHEDULER: RenderScheduler = {
	now: () => performance.now(),
	scheduleImmediate: callback => {
		setImmediate(callback);
	},
	scheduleRender: (callback, delayMs) => {
		const timer = setTimeout(callback, delayMs);
		return {
			cancel: () => {
				clearTimeout(timer);
			},
		};
	},
};

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { iterateWithIdleTimeout } from "@veyyon/ai/utils/idle-iterator";

// While a local tool holds a provider stream silent, the idle watchdog slides its deadline instead of
// aborting (issue-4593-repro.test.ts). The slide has to move the deadline one full budget past the
// expiry it answers. A slide that leaves the deadline where it was keeps it expired, so the watchdog
// re-checks at once, in a loop, for as long as the tool runs, and once the tool finishes the provider
// gets no budget at all and the stream is aborted the moment the probe first reports no work. The
// existing suites pass against that defect, because their sources answer in the same tick the probe
// releases them.
//
// The contract, per watchdog phase (waiting for the first event, and idle between events): the probe
// is consulted exactly once per budget while work is pending, and after the work drains the provider
// keeps the rest of the budget the last slide granted. A fake clock drives both, so the times asserted
// are exact.
//
// Not covered: the real platform timer. The fake clock fires a timer at its due time exactly, so a
// watchdog that re-arms early against a late real timer is not exercised here.

const BUDGET_MS = 100;

async function drainMicrotasks(): Promise<void> {
	for (let drain = 0; drain < 20; drain++) await Promise.resolve();
}

/** Advance the fake clock in small steps, draining the microtasks each timer schedules. */
async function advance(totalMs: number, stepMs = 10): Promise<void> {
	for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
		vi.advanceTimersByTime(stepMs);
		await drainMicrotasks();
	}
}

const PHASES = [
	{ phase: "first event", itemsBeforeWork: [] as string[], error: "first event stall" },
	{ phase: "idle", itemsBeforeWork: ["first"], error: "idle stall" },
];

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("a deadline slid for local work moves one full budget per expiry", () => {
	for (const { phase, itemsBeforeWork, error } of PHASES) {
		it(`consults the probe once per budget and leaves the provider the last slide's budget (${phase})`, async () => {
			let busy = true;
			const probes: Array<{ atMs: number; pending: boolean }> = [];
			// The provider never answers; only the watchdog can end this stream.
			const silent = Promise.withResolvers<never>();
			async function* source(): AsyncGenerator<string> {
				yield* itemsBeforeWork;
				await silent.promise;
			}
			const start = Date.now();
			const outcome = (async () => {
				const items: string[] = [];
				try {
					for await (const item of iterateWithIdleTimeout(source(), {
						idleTimeoutMs: BUDGET_MS,
						firstItemTimeoutMs: BUDGET_MS,
						errorMessage: "idle stall",
						firstItemErrorMessage: "first event stall",
						hasPendingLocalWork: () => {
							probes.push({ atMs: Date.now() - start, pending: busy });
							return busy;
						},
					})) {
						items.push(item);
					}
					return { items, error: undefined };
				} catch (err) {
					return { items, error: (err as Error).message };
				}
			})();

			await drainMicrotasks();
			await advance(350);
			busy = false;
			await advance(100);

			expect(probes).toEqual([
				{ atMs: 100, pending: true },
				{ atMs: 200, pending: true },
				{ atMs: 300, pending: true },
				// The work drained at 350; the slide at 300 granted the provider until 400.
				{ atMs: 400, pending: false },
			]);
			expect(await outcome).toEqual({ items: itemsBeforeWork, error });
		});
	}
});

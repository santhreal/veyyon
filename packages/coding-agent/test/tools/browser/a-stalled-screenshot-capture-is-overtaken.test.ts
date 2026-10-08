/**
 * WHY: a `Page.captureScreenshot` sent while the page commits a navigation can wait on a compositor
 * frame that never arrives, and Chromium never answers it. `tab.screenshot()` then held until the
 * protocol timeout, and because puppeteer's screenshot lock covered the capture, every later
 * screenshot and the close of the tab held behind it.
 *
 * The class this closes: for every sequence of attempt outcomes (an answer, a failure, no answer at
 * all) `hedgeCapture` resolves with the first answer, sends a second attempt exactly `hedgeAfterMs`
 * after the newest one when nothing answered, replaces a failed attempt at once when nothing else is
 * in flight and never while something is, sends no more than `maxAttempts`, rejects with the last
 * failure once every attempt failed, ends on the caller's abort with the signal's reason, and
 * releases every attempt once it settles. The sweep enumerates every outcome sequence up to the
 * first answer for three attempts.
 *
 * Not caught: whether Chromium answers a capture sent on a fresh CDP session while an earlier one
 * stalls, which no test here can make Chromium stall on demand; and an attempt that answers after
 * the race settled, whose answer is dropped by design.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { type CaptureAttempt, hedgeCapture } from "@veyyon/coding-agent/tools/web/browser/screenshot-capture";

const HEDGE_MS = 1_000;
const MAX_ATTEMPTS = 3;

type Outcome = "answers" | "fails" | "hangs";

interface FakeAttempt {
	answer(data: string): void;
	fail(error: Error): void;
	released: boolean;
}

/** A `start` whose attempts the test settles by hand; releasing one rejects it, as a detached session does. */
function captures(): { attempts: FakeAttempt[]; start: () => CaptureAttempt } {
	const attempts: FakeAttempt[] = [];
	const start = (): CaptureAttempt => {
		const { promise, resolve, reject } = Promise.withResolvers<string>();
		const fake: FakeAttempt = { answer: resolve, fail: reject, released: false };
		attempts.push(fake);
		return {
			result: promise,
			release() {
				fake.released = true;
				reject(new Error("released"));
			},
		};
	};
	return { attempts, start };
}

/** Runs `hedgeCapture` and records how it settled, readable synchronously after a flush. */
function race(start: () => CaptureAttempt, signal?: AbortSignal): { readonly outcome: string | undefined } {
	const state: { outcome: string | undefined } = { outcome: undefined };
	hedgeCapture(start, { hedgeAfterMs: HEDGE_MS, maxAttempts: MAX_ATTEMPTS, signal }).then(
		data => {
			state.outcome = `answer ${data}`;
		},
		(error: unknown) => {
			state.outcome = `rejected ${error instanceof Error ? error.message : String(error)}`;
		},
	);
	return state;
}

/** Lets every settled attempt's reactions and the race's own run. */
async function flush(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** Every outcome sequence for MAX_ATTEMPTS attempts, cut at the first answer. */
function sequences(prefix: Outcome[] = []): Outcome[][] {
	if (prefix.length === MAX_ATTEMPTS) return [prefix];
	return (["answers", "fails", "hangs"] as const).flatMap(outcome =>
		outcome === "answers" ? [[...prefix, outcome]] : sequences([...prefix, outcome]),
	);
}

afterEach(() => {
	vi.useRealTimers();
});

describe("a stalled screenshot capture is overtaken", () => {
	for (const sequence of sequences()) {
		it(`attempts that ${sequence.join(", then ")} settle as the first answer, the last failure, or the abort`, async () => {
			vi.useFakeTimers();
			const { attempts, start } = captures();
			const controller = new AbortController();
			const state = race(start, controller.signal);
			for (const [index, outcome] of sequence.entries()) {
				expect(attempts.length).toBe(index + 1);
				if (outcome === "answers") attempts[index].answer(`image ${index + 1}`);
				if (outcome === "fails") attempts[index].fail(new Error(`failure ${index + 1}`));
				await flush();
				if (index + 1 === sequence.length) break;
				// A failure with nothing else in flight is replaced at once; otherwise the next attempt
				// waits for the hedge, measured from the newest attempt.
				const replacedAtOnce = outcome === "fails" && !sequence.slice(0, index).includes("hangs");
				if (!replacedAtOnce) {
					vi.advanceTimersByTime(HEDGE_MS - 1);
					await flush();
					expect(attempts.length).toBe(index + 1);
					vi.advanceTimersByTime(1);
					await flush();
				}
			}
			vi.advanceTimersByTime(HEDGE_MS * 10);
			await flush();
			const answered = sequence.indexOf("answers");
			const expected =
				answered >= 0
					? `answer image ${answered + 1}`
					: sequence.every(outcome => outcome === "fails")
						? `rejected failure ${MAX_ATTEMPTS}`
						: undefined;
			expect(state.outcome).toBe(expected);
			expect(attempts.length).toBe(sequence.length);
			controller.abort(new Error("cancelled"));
			await flush();
			expect(state.outcome).toBe(expected ?? "rejected cancelled");
			expect(attempts.map(attempt => attempt.released)).toEqual(attempts.map(() => true));
		});
	}

	it("an earlier attempt answering after a hedge was sent wins and stops the hedging", async () => {
		vi.useFakeTimers();
		const { attempts, start } = captures();
		const state = race(start);
		vi.advanceTimersByTime(HEDGE_MS);
		await flush();
		expect(attempts.length).toBe(2);
		attempts[0].answer("image 1");
		await flush();
		vi.advanceTimersByTime(HEDGE_MS * 10);
		await flush();
		expect(state.outcome).toBe("answer image 1");
		expect(attempts.length).toBe(2);
		expect(attempts.map(attempt => attempt.released)).toEqual([true, true]);
	});

	it("the last attempt failing while an earlier one is in flight waits for the earlier one", async () => {
		vi.useFakeTimers();
		const { attempts, start } = captures();
		const state = race(start);
		vi.advanceTimersByTime(HEDGE_MS * 2);
		await flush();
		expect(attempts.length).toBe(MAX_ATTEMPTS);
		attempts[2].fail(new Error("failure 3"));
		await flush();
		expect(state.outcome).toBeUndefined();
		attempts[0].answer("image 1");
		await flush();
		expect(state.outcome).toBe("answer image 1");
	});

	it("an abort before every attempt was sent sends no more and rejects with the signal's reason", async () => {
		vi.useFakeTimers();
		const { attempts, start } = captures();
		const controller = new AbortController();
		const state = race(start, controller.signal);
		controller.abort(new Error("cancelled"));
		await flush();
		vi.advanceTimersByTime(HEDGE_MS * 10);
		await flush();
		expect(state.outcome).toBe("rejected cancelled");
		expect(attempts.map(attempt => attempt.released)).toEqual([true]);
	});

	it("a signal aborted before the race sends nothing", async () => {
		const { attempts, start } = captures();
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		const state = race(start, controller.signal);
		await flush();
		expect(state.outcome).toBe("rejected cancelled");
		expect(attempts).toEqual([]);
	});
});

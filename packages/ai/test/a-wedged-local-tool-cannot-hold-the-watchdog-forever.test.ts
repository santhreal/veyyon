import { describe, expect, it } from "bun:test";
import { iterateWithIdleTimeout } from "@veyyon/ai/utils/idle-iterator";

// The counterpart to issue-4593-repro.test.ts.
//
// #4593 stopped the idle watchdog aborting a healthy stream while a local tool
// bridge (the Cursor exec channel) legitimately held it silent. It did that by
// sliding the deadline forward for as long as `hasPendingLocalWork()` returned
// true, with no upper bound at all. So the fix for "a working stream is killed"
// created "a wedged stream is never killed": a local tool that never hands a
// result back disables the watchdog for the life of the turn, the stream goes
// silent, and the only exit is the user cancelling.
//
// That is the worse of the two failures, because a spurious abort recovers
// itself and a wedge does not. The same shape is already recorded elsewhere in
// this suite as "a subagent stalled for hours with no error surfaced"
// (openai-completions-progress-chunk.test.ts).
//
// These tests use no sleeps: the iterator's own deadlines drive them.
describe("a wedged local tool cannot hold the watchdog off forever", () => {
	it("aborts a stream a never-finishing local tool has held past the bound", async () => {
		// Never resolved: the local bridge never hands a result back.
		const wedged = Promise.withResolvers<never>();
		async function* source(): AsyncGenerator<string> {
			yield "first";
			await wedged.promise;
		}

		const items: string[] = [];
		let error: Error | undefined;
		try {
			for await (const item of iterateWithIdleTimeout(source(), {
				idleTimeoutMs: 5,
				maxLocalWorkHoldMs: 25,
				errorMessage: "stalled",
				hasPendingLocalWork: () => true,
			})) {
				items.push(item);
			}
		} catch (err) {
			error = err as Error;
		}

		expect(items).toEqual(["first"]);
		// Names local work as the cause, so a wedged bridge is diagnosable
		// instead of indistinguishable from a provider that went quiet.
		expect(error?.message).toBe("stalled (a local tool held the stream open without completing)");
	});

	it("bounds one continuous stretch, not the sum of many healthy tool calls", async () => {
		// Progress keeps arriving between local-work stretches, which is what a
		// long, healthy agentic turn looks like. The bound must never fire here,
		// or #4593 is back: real work would be truncated for taking a while.
		async function* source(): AsyncGenerator<string> {
			for (let index = 0; index < 12; index++) {
				yield `event-${index}`;
			}
		}

		const items: string[] = [];
		for await (const item of iterateWithIdleTimeout(source(), {
			idleTimeoutMs: 5,
			maxLocalWorkHoldMs: 25,
			errorMessage: "stalled",
			hasPendingLocalWork: () => true,
		})) {
			items.push(item);
		}

		expect(items).toHaveLength(12);
	});

	it("still reports a plain provider stall as a provider stall", async () => {
		// Negative control on the message: with no local work pending the
		// wording must not pick up the local-tool clause, or the new text would
		// mislabel every ordinary timeout.
		const quiet = Promise.withResolvers<never>();
		async function* source(): AsyncGenerator<string> {
			yield "first";
			await quiet.promise;
		}

		let error: Error | undefined;
		try {
			for await (const _item of iterateWithIdleTimeout(source(), {
				idleTimeoutMs: 5,
				maxLocalWorkHoldMs: 25,
				errorMessage: "stalled",
				hasPendingLocalWork: () => false,
			})) {
				// Only the first item arrives.
			}
		} catch (err) {
			error = err as Error;
		}

		expect(error?.message).toBe("stalled");
	});
});

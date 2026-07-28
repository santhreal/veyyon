import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	getOpenAIStreamFirstEventTimeoutMs,
	getOpenAIStreamIdleTimeoutMs,
	getStreamFirstEventTimeoutMs,
	getStreamIdleTimeoutMs,
	iterateWithIdleTimeout,
	iterateWithTerminalGrace,
} from "@veyyon/ai/utils/idle-iterator";

/**
 * Per-provider fallback overrides on the stream-watchdog helpers.
 *
 * These are the gear that lets `google-gemini-cli` widen its first-event floor
 * beyond the 100s global default without forcing every other provider to wait
 * just as long. Tests pin the precedence contract callers depend on:
 * caller option > env var > per-provider fallback > base default.
 */

const ENV_KEYS = [
	"VEYYON_STREAM_IDLE_TIMEOUT_MS",
	"VEYYON_OPENAI_STREAM_IDLE_TIMEOUT_MS",
	"VEYYON_STREAM_FIRST_EVENT_TIMEOUT_MS",
	"VEYYON_OPENAI_STREAM_FIRST_EVENT_TIMEOUT_MS",
] as const;

const originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
	for (const key of ENV_KEYS) {
		originalEnv[key] = Bun.env[key];
		delete Bun.env[key];
	}
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		const prior = originalEnv[key];
		if (prior === undefined) {
			delete Bun.env[key];
		} else {
			Bun.env[key] = prior;
		}
	}
	vi.useRealTimers();
});

describe("getStreamIdleTimeoutMs(fallbackMs)", () => {
	it("returns the per-provider fallback when env vars are unset", () => {
		expect(getStreamIdleTimeoutMs(300_000)).toBe(300_000);
	});

	it("lets VEYYON_STREAM_IDLE_TIMEOUT_MS override the per-provider fallback", () => {
		Bun.env.VEYYON_STREAM_IDLE_TIMEOUT_MS = "42";
		expect(getStreamIdleTimeoutMs(300_000)).toBe(42);
	});

	it("treats VEYYON_STREAM_IDLE_TIMEOUT_MS=0 as a watchdog disable", () => {
		Bun.env.VEYYON_STREAM_IDLE_TIMEOUT_MS = "0";
		expect(getStreamIdleTimeoutMs(300_000)).toBeUndefined();
	});
});

describe("getOpenAIStreamIdleTimeoutMs(fallbackMs)", () => {
	it("returns the per-provider fallback when OpenAI env vars are unset", () => {
		expect(getOpenAIStreamIdleTimeoutMs(600_000)).toBe(600_000);
	});

	it("lets VEYYON_OPENAI_STREAM_IDLE_TIMEOUT_MS override the fallback before the generic env var", () => {
		Bun.env.VEYYON_STREAM_IDLE_TIMEOUT_MS = "42";
		Bun.env.VEYYON_OPENAI_STREAM_IDLE_TIMEOUT_MS = "84";
		expect(getOpenAIStreamIdleTimeoutMs(600_000)).toBe(84);
	});

	it("treats VEYYON_OPENAI_STREAM_IDLE_TIMEOUT_MS=0 as a watchdog disable", () => {
		Bun.env.VEYYON_OPENAI_STREAM_IDLE_TIMEOUT_MS = "0";
		expect(getOpenAIStreamIdleTimeoutMs(600_000)).toBeUndefined();
	});
});

describe("getStreamFirstEventTimeoutMs(idleTimeoutMs, fallbackMs)", () => {
	it("returns the per-provider fallback when env unset and idle timeout is undefined", () => {
		expect(getStreamFirstEventTimeoutMs(undefined, 300_000)).toBe(300_000);
	});

	it("floors the first-event timeout at the per-provider fallback even when idle is shorter", () => {
		expect(getStreamFirstEventTimeoutMs(50_000, 300_000)).toBe(300_000);
	});

	it("never undershoots the steady-state idle timeout", () => {
		expect(getStreamFirstEventTimeoutMs(500_000, 300_000)).toBe(500_000);
	});

	it("lets VEYYON_STREAM_FIRST_EVENT_TIMEOUT_MS override the per-provider fallback", () => {
		Bun.env.VEYYON_STREAM_FIRST_EVENT_TIMEOUT_MS = "42";
		expect(getStreamFirstEventTimeoutMs(undefined, 300_000)).toBe(42);
	});

	it("treats VEYYON_STREAM_FIRST_EVENT_TIMEOUT_MS=0 as a watchdog disable", () => {
		Bun.env.VEYYON_STREAM_FIRST_EVENT_TIMEOUT_MS = "0";
		expect(getStreamFirstEventTimeoutMs(undefined, 300_000)).toBeUndefined();
	});

	it("falls back to the 100s global default when no fallback or env is provided", () => {
		expect(getStreamFirstEventTimeoutMs()).toBe(100_000);
	});
});

describe("getOpenAIStreamFirstEventTimeoutMs(idleTimeoutMs, fallbackMs)", () => {
	it("floors the first-event budget at the caller-resolved idle when the generic env is lower", () => {
		Bun.env.VEYYON_STREAM_FIRST_EVENT_TIMEOUT_MS = "20";
		expect(getOpenAIStreamFirstEventTimeoutMs(1500, 100_000)).toBe(1500);
	});

	it("honors VEYYON_OPENAI_STREAM_FIRST_EVENT_TIMEOUT_MS even when caller pins per-call idle", () => {
		Bun.env.VEYYON_OPENAI_STREAM_FIRST_EVENT_TIMEOUT_MS = "42";
		Bun.env.VEYYON_STREAM_FIRST_EVENT_TIMEOUT_MS = "20";
		expect(getOpenAIStreamFirstEventTimeoutMs(5_000, 100_000)).toBe(42);
	});

	it("treats VEYYON_OPENAI_STREAM_FIRST_EVENT_TIMEOUT_MS=0 as an explicit watchdog disable", () => {
		Bun.env.VEYYON_OPENAI_STREAM_FIRST_EVENT_TIMEOUT_MS = "0";
		expect(getOpenAIStreamFirstEventTimeoutMs(1500, 100_000)).toBeUndefined();
	});

	it("falls back to the generic first-event env when OpenAI env vars are unset", () => {
		Bun.env.VEYYON_STREAM_FIRST_EVENT_TIMEOUT_MS = "42";
		expect(getOpenAIStreamFirstEventTimeoutMs(undefined, 300_000)).toBe(42);
	});

	it("respects VEYYON_STREAM_FIRST_EVENT_TIMEOUT_MS=0 disable when no OpenAI override is set", () => {
		Bun.env.VEYYON_STREAM_FIRST_EVENT_TIMEOUT_MS = "0";
		expect(getOpenAIStreamFirstEventTimeoutMs(1500, 100_000)).toBeUndefined();
	});
});

async function expectRejectsWithMessage(run: () => Promise<void>, message: string): Promise<void> {
	let caught: unknown;
	try {
		await run();
	} catch (err) {
		caught = err;
	}
	expect(caught).toBeInstanceOf(Error);
	expect((caught as Error).message).toBe(message);
}

async function drainMicrotasksUntil(predicate: () => boolean, errorMessage: string): Promise<void> {
	for (let i = 0; i < 1000; i++) {
		if (predicate()) return;
		await Promise.resolve();
	}
	throw new Error(errorMessage);
}

describe("iterateWithIdleTimeout", () => {
	it("does not reset the first-progress deadline for no-progress items", async () => {
		const abortController = new AbortController();
		const abortTimer = setTimeout(() => abortController.abort(new Error("fallback abort")), 150);
		abortTimer.unref();

		async function* noProgressItems(): AsyncGenerator<{ type: "keepalive" }> {
			while (true) {
				await Bun.sleep(2);
				yield { type: "keepalive" };
			}
		}

		try {
			const run = async (): Promise<void> => {
				for await (const _item of iterateWithIdleTimeout(noProgressItems(), {
					firstItemTimeoutMs: 20,
					idleTimeoutMs: 1_000,
					errorMessage: "idle timeout",
					firstItemErrorMessage: "first progress timeout",
					abortSignal: abortController.signal,
					isProgressItem: () => false,
				})) {
					// Consume until the watchdog fires.
				}
			};

			await expectRejectsWithMessage(run, "first progress timeout");
		} finally {
			clearTimeout(abortTimer);
		}
	});

	it("clears the first-item watchdog timer when the source rejects before progress", async () => {
		vi.useFakeTimers();
		const baselineTimers = vi.getTimerCount();

		// The first pull stays pending until we reject it, so the watchdog can be
		// observed armed before the source errors. Rejecting a deferred promise is a
		// microtask resolution, so the source error wins the watchdog race
		// deterministically — with fake timers the watchdog never fires unless time is
		// advanced, which this test never does.
		const firstPull = Promise.withResolvers<IteratorResult<string>>();
		const failingStream: AsyncIterable<string> = {
			[Symbol.asyncIterator]: () => ({ next: () => firstPull.promise }),
		};

		const settled = expectRejectsWithMessage(async () => {
			for await (const _item of iterateWithIdleTimeout(failingStream, {
				firstItemTimeoutMs: 10,
				errorMessage: "idle timeout",
				firstItemErrorMessage: "first progress timeout",
			})) {
				// Unreachable.
			}
		}, "stream failed");

		// The wrapper arms a first-item watchdog timer while it waits for the first pull.
		await drainMicrotasksUntil(() => vi.getTimerCount() > baselineTimers, "first-item watchdog timer was not armed");

		firstPull.reject(new Error("stream failed"));
		await settled;

		// Surfacing the source error must clear the watchdog timer rather than leave it
		// pending to fire after the stream has already failed.
		expect(vi.getTimerCount()).toBe(baselineTimers);
	});

	it("cleans first-item timers when the consumer returns before progress", async () => {
		let firstItemTimedOut = false;

		async function* noProgressItems(): AsyncGenerator<{ type: "keepalive" }> {
			while (true) {
				await Bun.sleep(2);
				yield { type: "keepalive" };
			}
		}

		for await (const _item of iterateWithIdleTimeout(noProgressItems(), {
			firstItemTimeoutMs: 10,
			idleTimeoutMs: 1_000,
			errorMessage: "idle timeout",
			firstItemErrorMessage: "first progress timeout",
			onFirstItemTimeout: () => {
				firstItemTimedOut = true;
			},
			isProgressItem: () => false,
		})) {
			break;
		}

		await Bun.sleep(20);
		expect(firstItemTimedOut).toBe(false);
	});

	it("closes the upstream iterator when the consumer breaks early", async () => {
		let upstreamClosed = false;
		async function* source(): AsyncGenerator<string> {
			try {
				let n = 0;
				while (true) {
					await Bun.sleep(1);
					yield `item-${n++}`;
				}
			} finally {
				// Runs only if the wrapper forwards `.return()` to us.
				upstreamClosed = true;
			}
		}

		for await (const _item of iterateWithIdleTimeout(source(), {
			idleTimeoutMs: 1_000,
			errorMessage: "idle timeout",
		})) {
			break; // abandon the wrapper after the first item
		}

		// The wrapper must propagate the consumer's early termination to the source
		// so the underlying SSE body / SDK stream (and its socket) is released
		// instead of being left suspended.
		await Bun.sleep(5);
		expect(upstreamClosed).toBe(true);
	});

	/**
	 * Once cancellation is latched between yields, the wrapper must not issue one
	 * more upstream pull before observing it; that pull can dispatch real work.
	 */
	it("does not pull upstream again after cancellation between items", async () => {
		const controller = new AbortController();
		const reason = new Error("caller cancelled");
		let nextCalls = 0;
		let returnCalls = 0;
		const source: AsyncIterable<string> = {
			[Symbol.asyncIterator]() {
				return {
					next() {
						nextCalls += 1;
						return Promise.resolve({ done: false as const, value: `item-${nextCalls}` });
					},
					return() {
						returnCalls += 1;
						return Promise.resolve({ done: true as const, value: undefined });
					},
				};
			},
		};
		const wrapped = iterateWithIdleTimeout(source, {
			idleTimeoutMs: 1_000,
			errorMessage: "idle timeout",
			abortSignal: controller.signal,
		});

		expect(await wrapped.next()).toEqual({ done: false, value: "item-1" });
		controller.abort(reason);
		await expect(wrapped.next()).rejects.toBe(reason);
		expect({ nextCalls, returnCalls }).toEqual({ nextCalls: 1, returnCalls: 1 });
	});

	/**
	 * A timeout notification hook is cleanup only: if it throws, the stable
	 * StreamTimeoutError must still win and upstream close must still run once.
	 */
	it("preserves timeout error precedence when the timeout hook throws", async () => {
		let timeoutHooks = 0;
		let returnCalls = 0;
		const source: AsyncIterable<string> = {
			[Symbol.asyncIterator]() {
				return {
					next: () => new Promise<IteratorResult<string>>(() => {}),
					return() {
						returnCalls += 1;
						return Promise.resolve({ done: true as const, value: undefined });
					},
				};
			},
		};

		await expectRejectsWithMessage(async () => {
			for await (const _item of iterateWithIdleTimeout(source, {
				firstItemTimeoutMs: 5,
				errorMessage: "idle timeout",
				firstItemErrorMessage: "first progress timeout",
				onFirstItemTimeout: () => {
					timeoutHooks += 1;
					throw new Error("timeout hook failed");
				},
			})) {
				// Unreachable.
			}
		}, "first progress timeout");
		expect({ timeoutHooks, returnCalls }).toEqual({ timeoutHooks: 1, returnCalls: 1 });
	});

	/**
	 * Natural exhaustion is already a closed iterator; forwarding return() after
	 * done duplicates upstream completion callbacks and cleanup side effects.
	 */
	it("does not close an already exhausted upstream iterator", async () => {
		let returnCalls = 0;
		const source: AsyncIterable<string> = {
			[Symbol.asyncIterator]() {
				return {
					next: () => Promise.resolve({ done: true as const, value: undefined }),
					return() {
						returnCalls += 1;
						return Promise.resolve({ done: true as const, value: undefined });
					},
				};
			},
		};

		for await (const _item of iterateWithIdleTimeout(source, { errorMessage: "idle timeout" })) {
			// Unreachable.
		}
		expect(returnCalls).toBe(0);
	});

	/**
	 * A malformed upstream return() that throws synchronously must not replace
	 * the source read error the consumer is already receiving.
	 */
	it("does not let synchronous close failure mask the source error", async () => {
		const sourceError = new Error("source read failed");
		let returnCalls = 0;
		const source: AsyncIterable<string> = {
			[Symbol.asyncIterator]() {
				return {
					next: () => Promise.reject(sourceError),
					return() {
						returnCalls += 1;
						throw new Error("close failed");
					},
				};
			},
		};

		const consume = async (): Promise<void> => {
			for await (const _item of iterateWithIdleTimeout(source, { errorMessage: "idle timeout" })) {
				// Unreachable.
			}
		};
		await expect(consume()).rejects.toBe(sourceError);
		expect(returnCalls).toBe(1);
	});
});

describe("iterateWithTerminalGrace", () => {
	it("passes items through untouched while the stream is not finished", async () => {
		async function* source(): AsyncGenerator<string> {
			yield "a";
			yield "b";
		}

		const seen: string[] = [];
		for await (const item of iterateWithTerminalGrace(source(), {
			finishedAtMs: () => undefined,
			graceMs: 50,
		})) {
			seen.push(item);
		}
		expect(seen).toEqual(["a", "b"]);
	});

	it("yields trailing items that arrive within the grace window", async () => {
		let finishedAt: number | undefined;
		async function* source(): AsyncGenerator<string> {
			yield "finish";
			await Bun.sleep(5);
			yield "usage";
			await new Promise<never>(() => {}); // server holds the connection open
		}

		const seen: string[] = [];
		for await (const item of iterateWithTerminalGrace(source(), {
			finishedAtMs: () => finishedAt,
			graceMs: 100,
		})) {
			seen.push(item);
			if (item === "finish") finishedAt = Date.now();
			if (item === "usage") break;
		}
		expect(seen).toEqual(["finish", "usage"]);
	});

	it("ends cleanly and fires onGraceEnd when the source stays silent past the grace window", async () => {
		let finishedAt: number | undefined;
		let graceEnded = false;
		let upstreamClosed = false;
		async function* source(): AsyncGenerator<string> {
			try {
				yield "finish";
				await new Promise<never>(() => {}); // never sends [DONE], never closes
			} finally {
				upstreamClosed = true;
			}
		}

		const seen: string[] = [];
		for await (const item of iterateWithTerminalGrace(source(), {
			finishedAtMs: () => finishedAt,
			graceMs: 20,
			onGraceEnd: () => {
				graceEnded = true;
			},
		})) {
			seen.push(item);
			finishedAt = Date.now();
		}

		// Clean end of iteration — no throw — with the grace hook invoked so the
		// caller can abort the transport and release the parked source read.
		expect(seen).toEqual(["finish"]);
		expect(graceEnded).toBe(true);
		await Bun.sleep(5);
		expect(upstreamClosed).toBe(false); // parked mid-await; only the abort can release it
	});

	/**
	 * Terminal grace expiry is a successful logical completion, so a failing
	 * cleanup hook must not turn it into an error or run more than once.
	 */
	it("ends cleanly when the grace-end hook throws", async () => {
		let nextCalls = 0;
		let returnCalls = 0;
		let graceCalls = 0;
		let finishedAt: number | undefined;
		const source: AsyncIterable<string> = {
			[Symbol.asyncIterator]() {
				return {
					next() {
						nextCalls += 1;
						if (nextCalls === 1) return Promise.resolve({ done: false as const, value: "finish" });
						return new Promise<IteratorResult<string>>(() => {});
					},
					return() {
						returnCalls += 1;
						return Promise.resolve({ done: true as const, value: undefined });
					},
				};
			},
		};

		const seen: string[] = [];
		for await (const item of iterateWithTerminalGrace(source, {
			finishedAtMs: () => finishedAt,
			graceMs: 5,
			onGraceEnd: () => {
				graceCalls += 1;
				throw new Error("grace cleanup failed");
			},
		})) {
			seen.push(item);
			finishedAt = Date.now();
		}

		expect(seen).toEqual(["finish"]);
		expect({ nextCalls, returnCalls, graceCalls }).toEqual({ nextCalls: 2, returnCalls: 1, graceCalls: 1 });
	});

	/**
	 * A naturally exhausted terminal-grace source needs no return() call; doing
	 * both invokes user cleanup twice relative to normal async iteration.
	 */
	it("does not return an already exhausted terminal-grace iterator", async () => {
		let returnCalls = 0;
		const source: AsyncIterable<string> = {
			[Symbol.asyncIterator]() {
				return {
					next: () => Promise.resolve({ done: true as const, value: undefined }),
					return() {
						returnCalls += 1;
						return Promise.resolve({ done: true as const, value: undefined });
					},
				};
			},
		};

		for await (const _item of iterateWithTerminalGrace(source, {
			finishedAtMs: () => undefined,
			graceMs: 5,
		})) {
			// Unreachable.
		}
		expect(returnCalls).toBe(0);
	});
});

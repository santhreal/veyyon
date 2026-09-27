import { $env } from "@veyyon/utils/env";
import * as AIError from "../error";

const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_STREAM_FIRST_EVENT_TIMEOUT_MS = 100_000;

function normalizeIdleTimeoutMs(value: string | undefined, fallback: number): number | undefined {
	if (value === undefined) return fallback;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	if (parsed <= 0) return undefined;
	return Math.trunc(parsed);
}

/**
 * Returns the idle timeout used for provider streaming transports.
 *
 * `VEYYON_OPENAI_STREAM_IDLE_TIMEOUT_MS` is accepted as a backward-compatible alias.
 * Set `VEYYON_STREAM_IDLE_TIMEOUT_MS=0` to disable the watchdog.
 *
 * Providers that legitimately stream much slower than the global default can pass
 * `fallbackMs` to widen the floor used when neither env var nor caller option is set.
 * Caller options still take precedence; env overrides still trump the fallback.
 */
export function getStreamIdleTimeoutMs(fallbackMs: number = DEFAULT_STREAM_IDLE_TIMEOUT_MS): number | undefined {
	return normalizeIdleTimeoutMs(
		$env.VEYYON_STREAM_IDLE_TIMEOUT_MS ?? $env.VEYYON_OPENAI_STREAM_IDLE_TIMEOUT_MS,
		fallbackMs,
	);
}

/**
 * The idle budget the environment pins, or `undefined` when it pins none.
 *
 * For a provider that governs its own idleness (Cursor probes the transport instead of timing it):
 * an operator who sets `VEYYON_STREAM_IDLE_TIMEOUT_MS` still gets a generic watchdog at that number,
 * and everyone else gets none rather than the global default.
 */
export function getStreamIdleTimeoutOverrideMs(): number | undefined {
	const raw = $env.VEYYON_STREAM_IDLE_TIMEOUT_MS ?? $env.VEYYON_OPENAI_STREAM_IDLE_TIMEOUT_MS;
	if (raw === undefined) return undefined;
	return normalizeIdleTimeoutMs(raw, DEFAULT_STREAM_IDLE_TIMEOUT_MS);
}

/**
 * Returns the idle timeout used for OpenAI-family streaming transports.
 *
 * `VEYYON_OPENAI_STREAM_IDLE_TIMEOUT_MS` takes precedence over the generic
 * `VEYYON_STREAM_IDLE_TIMEOUT_MS` because some deployments tune OpenAI-compatible
 * backends separately from Anthropic/Gemini-style transports.
 *
 * Set `VEYYON_OPENAI_STREAM_IDLE_TIMEOUT_MS=0` to disable the watchdog.
 */
export function getOpenAIStreamIdleTimeoutMs(fallbackMs: number = DEFAULT_STREAM_IDLE_TIMEOUT_MS): number | undefined {
	return normalizeIdleTimeoutMs(
		$env.VEYYON_OPENAI_STREAM_IDLE_TIMEOUT_MS ?? $env.VEYYON_STREAM_IDLE_TIMEOUT_MS,
		fallbackMs,
	);
}

/**
 * Returns the timeout used while waiting for the first stream event.
 * The first token can legitimately take longer than later inter-event gaps,
 * so the default never undershoots the steady-state idle timeout.
 *
 * Set `VEYYON_STREAM_FIRST_EVENT_TIMEOUT_MS=0` to disable the watchdog.
 *
 * Providers whose first response can legitimately take longer (heavy reasoning,
 * slow cold-start proxies) can pass `fallbackMs` to widen the floor used when
 * neither env var nor caller option is set. Caller options still take precedence;
 * env overrides still trump the fallback.
 */
export function getStreamFirstEventTimeoutMs(
	idleTimeoutMs?: number,
	fallbackMs: number = DEFAULT_STREAM_FIRST_EVENT_TIMEOUT_MS,
): number | undefined {
	const fallback = idleTimeoutMs === undefined ? fallbackMs : Math.max(fallbackMs, idleTimeoutMs);
	return normalizeIdleTimeoutMs($env.VEYYON_STREAM_FIRST_EVENT_TIMEOUT_MS, fallback);
}

/**
 * Returns the first-event timeout used for OpenAI-family streaming transports.
 *
 * Precedence: explicit `VEYYON_OPENAI_STREAM_FIRST_EVENT_TIMEOUT_MS` (including a
 * `"0"` disable) wins outright. Otherwise the resolved idle (caller-supplied
 * `idleTimeoutMs` — which itself already encompasses per-call
 * `streamIdleTimeoutMs` or `VEYYON_OPENAI_STREAM_IDLE_TIMEOUT_MS` resolved
 * upstream) floors the first-event budget so slow local OpenAI-compatible
 * servers are not undercut by a shorter `VEYYON_STREAM_FIRST_EVENT_TIMEOUT_MS`
 * or the global default during prompt processing.
 *
 * Returns `undefined` when an explicit env knob disables the watchdog.
 */
export function getOpenAIStreamFirstEventTimeoutMs(
	idleTimeoutMs?: number,
	fallbackMs: number = DEFAULT_STREAM_FIRST_EVENT_TIMEOUT_MS,
): number | undefined {
	const openAIFirstEventRaw = $env.VEYYON_OPENAI_STREAM_FIRST_EVENT_TIMEOUT_MS;
	if (openAIFirstEventRaw !== undefined) {
		return normalizeIdleTimeoutMs(openAIFirstEventRaw, fallbackMs);
	}
	const base = normalizeIdleTimeoutMs($env.VEYYON_STREAM_FIRST_EVENT_TIMEOUT_MS, fallbackMs);
	if (base === undefined) return undefined;
	if (idleTimeoutMs === undefined || idleTimeoutMs <= 0) return base;
	return Math.max(base, idleTimeoutMs);
}

/**
 * Arms a clearable pre-response (time-to-first-byte) abort guard for a streaming
 * fetch, combined with the caller's signal.
 *
 * `AbortSignal.timeout(ms)` is an *absolute* wall-clock deadline: once handed to
 * `fetch` it keeps governing the request after the response headers arrive, so
 * it aborts an actively-streaming body the moment it fires — not just a stalled
 * pre-response request (issue #2422 regression: large `write` tool-call streams
 * died at the budget with `TimeoutError: The operation timed out.` despite
 * deltas actively flowing). This arms a `clearTimeout`-able timer instead;
 * callers MUST `clear()` as soon as the guarded transport attempt settles so
 * the body stream is left to the iterator-level idle watchdog.
 *
 * Retrying callers MUST arm a fresh guard for each transport attempt and keep
 * the retry loop's base signal reserved for caller cancellation. Reusing the
 * guard as the loop signal makes its timeout indistinguishable from cancellation.
 *
 * Returns the caller signal unchanged (and a no-op `clear`) when no positive
 * timeout is configured.
 */
export function armPreResponseTimeout(
	callerSignal: AbortSignal | undefined,
	timeoutMs: number | undefined,
): { signal: AbortSignal | undefined; clear: () => void } {
	if (callerSignal?.aborted || timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		return { signal: callerSignal, clear: () => {} };
	}
	const controller = new AbortController();
	const timer = setTimeout(() => {
		controller.abort(new DOMException("The operation timed out.", "TimeoutError"));
	}, timeoutMs);
	timer.unref?.();
	const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
	return { signal, clear: () => clearTimeout(timer) };
}

/**
 * Longest continuous stretch local work may hold the idle watchdog off.
 *
 * Sized above the largest run a local tool can legitimately take (the bash tool
 * caps its own timeout at 3600s) so this never truncates real work; it exists
 * only so a wedged bridge ends in a diagnosable error instead of silence.
 */
export const DEFAULT_MAX_LOCAL_WORK_HOLD_MS = 90 * 60_000;

export interface IdleTimeoutIteratorOptions {
	idleTimeoutMs?: number;
	firstItemTimeoutMs?: number;
	errorMessage: string;
	firstItemErrorMessage?: string;
	onIdle?: () => void;
	onFirstItemTimeout?: () => void;
	/**
	 * Optional semantic-progress predicate. Non-progress items are still yielded,
	 * but they do not reset the idle deadline. This prevents provider
	 * keepalive/no-op events from keeping a stalled tool call alive forever.
	 */
	isProgressItem?: (item: unknown) => boolean;
	/**
	 * Reports consumer-side local work in flight for the stream: the provider
	 * transport is waiting on a server-requested local tool bridge (e.g. the
	 * Cursor exec channel) before anything can flow upstream again. While it
	 * returns true, an expired idle / first-item deadline slides forward
	 * instead of aborting — the silence is ours, not a provider stall. The
	 * watchdog re-arms with a full budget once the local work completes, so a
	 * provider that stalls afterwards is still caught.
	 */
	hasPendingLocalWork?: () => boolean;
	/**
	 * Upper bound (ms) on how long {@link hasPendingLocalWork} may hold the
	 * watchdog off in one continuous stretch. Defaults to
	 * {@link DEFAULT_MAX_LOCAL_WORK_HOLD_MS}.
	 *
	 * WHY THIS EXISTS. The local-work stand-down slides the deadline forward
	 * every time it is consulted, so a local tool that never settles disables
	 * the watchdog for the life of the process: the stream goes silent and the
	 * only exit is the user cancelling the turn. That is the opposite failure
	 * from the one the stand-down was added for (#4593, healthy tool runs being
	 * aborted), and it is worse, because a spurious abort recovers itself and a
	 * wedge does not. The clock runs only while work is CONTINUOUSLY pending and
	 * resets the moment it drains, so a session of many ordinary tool calls
	 * never accumulates toward it.
	 */
	maxLocalWorkHoldMs?: number;
	/**
	 * Cancel iteration as soon as this signal aborts. Required for caller-driven
	 * cancellation (ESC) when the underlying transport does not surface signal
	 * aborts to the iterator (HTTP/2 proxies, native sockets, mocked fetch).
	 * Without this, the consumer sleeps on iterator.next() until the idle/first
	 * -event watchdog fires — observable as the issue #912 "Working… forever"
	 * symptom on the github-copilot provider.
	 */
	abortSignal?: AbortSignal;
}

type IdleWake = "next" | "timeout" | "abort";

/**
 * The state one {@link iterateWithIdleTimeout} run holds across pulls: the active deadline, the one
 * timer that enforces it, the in-flight `next()`, and the waiter that a settled `next()`, the timer
 * or the caller's abort resolves.
 *
 * Each stalled pull waits on its own promise, which a settled `next()`, the timer or the abort resolves.
 * A `Promise.race` over long-lived timeout and abort promises attaches a reaction to every racer on
 * every item, and a racer that never settles retains one per streamed item for the stream's life.
 */
class IdleWatchdog<T> {
	readonly #iterator: AsyncIterator<T>;
	readonly #options: IdleTimeoutIteratorOptions;
	/** The first-item budget when positive; the first-item deadline is set exactly when this is. */
	readonly #firstItemBudgetMs: number | undefined;
	/** The steady-state idle budget when positive. */
	readonly #idleBudgetMs: number | undefined;
	readonly #maxLocalWorkHoldMs: number;
	#firstItemDeadlineMs: number | undefined;
	#awaitingFirstItem = true;
	#lastProgressAt = Date.now();
	#localWorkHoldStartedAt: number | undefined;
	#localWorkHoldExpired = false;
	#timer: NodeJS.Timeout | undefined;
	#timerFireAtMs = Infinity;
	/** A `next()` was issued and not yet taken; a second one while it is out would drop an item. */
	#nextInFlight = false;
	#nextSettled = false;
	#nextFailed = false;
	#nextResult: IteratorResult<T> | undefined;
	#nextError: unknown;
	#wakeWaiter: (() => void) | undefined;
	#wokeBy: IdleWake = "next";
	#iteratorClosed = false;

	constructor(iterator: AsyncIterator<T>, options: IdleTimeoutIteratorOptions) {
		this.#iterator = iterator;
		this.#options = options;
		const firstItemTimeoutMs = options.firstItemTimeoutMs ?? options.idleTimeoutMs;
		if (firstItemTimeoutMs !== undefined && firstItemTimeoutMs > 0) {
			this.#firstItemBudgetMs = firstItemTimeoutMs;
			this.#firstItemDeadlineMs = this.#lastProgressAt + firstItemTimeoutMs;
		}
		const idleTimeoutMs = options.idleTimeoutMs;
		if (idleTimeoutMs !== undefined && idleTimeoutMs > 0) this.#idleBudgetMs = idleTimeoutMs;
		this.#maxLocalWorkHoldMs = options.maxLocalWorkHoldMs ?? DEFAULT_MAX_LOCAL_WORK_HOLD_MS;
		options.abortSignal?.addEventListener("abort", this.#onAbort, { once: true });
	}

	throwIfAborted(): void {
		const signal = this.#options.abortSignal;
		if (!signal?.aborted) return;
		this.close();
		throw abortReason(signal);
	}

	/**
	 * The deadline the next wait runs against. A deadline that already passed slides a full budget
	 * for pending local work, or throws the timeout.
	 */
	enforceDeadline(): number | undefined {
		const deadlineMs = this.#deadlineMs();
		if (deadlineMs === undefined || deadlineMs > Date.now()) return deadlineMs;
		this.#extendOrThrowTimeout();
		return this.#deadlineMs();
	}

	/**
	 * Issues `next()` unless one is still out, and returns the promise to await before
	 * {@link take}, or `undefined` when the outstanding `next()` already settled.
	 */
	pull(deadlineMs: number | undefined): Promise<void> | undefined {
		if (!this.#nextInFlight) {
			const next = this.#iterator.next();
			this.#nextInFlight = true;
			void next.then(this.#onNext, this.#onNextError);
		}
		if (this.#nextSettled) {
			this.#wokeBy = "next";
			return undefined;
		}
		if (deadlineMs !== undefined) this.#armTimer(deadlineMs);
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#wakeWaiter = resolve;
		return promise;
	}

	/**
	 * What the last {@link pull} settled on: the source's result, or `undefined` when its deadline
	 * passed and slid for pending local work, so the same `next()` is awaited again. Throws the abort,
	 * the timeout, or the source's error.
	 */
	take(): IteratorResult<T> | undefined {
		if (this.#wokeBy === "abort") {
			this.close();
			throw abortReason(this.#options.abortSignal!);
		}
		if (this.#wokeBy === "timeout") {
			this.#extendOrThrowTimeout();
			return undefined;
		}
		this.#nextInFlight = false;
		this.#nextSettled = false;
		if (this.#nextFailed) {
			this.#nextFailed = false;
			throw this.#nextError;
		}
		const result = this.#nextResult!;
		this.#nextResult = undefined;
		return result;
	}

	/**
	 * Records a yielded item. Non-progress items (provider keepalives, the synthetic `start` event that
	 * precedes the model's first token) leave the first-item watchdog armed and the idle deadline
	 * where it was; switching to the shorter idle budget on one would abort a slow first token.
	 */
	observe(item: T): void {
		if (!this.#isProgressItem(item)) return;
		this.#awaitingFirstItem = false;
		this.#lastProgressAt = Date.now();
		// Real progress ends the stretch the local-work bound is measured over.
		this.#localWorkHoldStartedAt = undefined;
	}

	/** The source reported `done`, so there is nothing left to close. */
	sourceDone(): void {
		this.#iteratorClosed = true;
	}

	/** Closes the source so its SSE body or SDK stream, and the socket under it, is released. */
	close(): void {
		if (this.#iteratorClosed) return;
		this.#iteratorClosed = true;
		returnQuietly(this.#iterator);
	}

	dispose(): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#wakeWaiter = undefined;
		this.#options.abortSignal?.removeEventListener("abort", this.#onAbort);
	}

	#deadlineMs(): number | undefined {
		if (this.#awaitingFirstItem) return this.#firstItemDeadlineMs;
		return this.#idleBudgetMs === undefined ? undefined : this.#lastProgressAt + this.#idleBudgetMs;
	}

	#wake(reason: IdleWake): void {
		const wakeWaiter = this.#wakeWaiter;
		if (wakeWaiter === undefined) return;
		this.#wakeWaiter = undefined;
		this.#wokeBy = reason;
		wakeWaiter();
	}

	readonly #onNext = (result: IteratorResult<T>): void => {
		this.#nextResult = result;
		this.#nextSettled = true;
		this.#wake("next");
	};

	readonly #onNextError = (error: unknown): void => {
		this.#nextError = error;
		this.#nextFailed = true;
		this.#nextSettled = true;
		this.#wake("next");
	};

	readonly #onAbort = (): void => {
		this.#wake("abort");
	};

	/**
	 * One timer per idle period: an armed timer that fires at or before the new deadline stays, and
	 * on firing re-arms for whatever remains of a deadline that progress moved since.
	 */
	#armTimer(deadlineMs: number): void {
		if (this.#timer !== undefined) {
			if (this.#timerFireAtMs <= deadlineMs) return;
			clearTimeout(this.#timer);
		}
		this.#timerFireAtMs = deadlineMs;
		this.#timer = setTimeout(this.#onTimerFire, Math.max(0, deadlineMs - Date.now()));
	}

	readonly #onTimerFire = (): void => {
		this.#timer = undefined;
		this.#timerFireAtMs = Infinity;
		const deadlineMs = this.#deadlineMs();
		if (deadlineMs === undefined) return;
		const remainingMs = deadlineMs - Date.now();
		if (remainingMs > 0) {
			this.#timerFireAtMs = deadlineMs;
			this.#timer = setTimeout(this.#onTimerFire, remainingMs);
			return;
		}
		// With no pull waiting, the consumer holds the last item; the next pull finds the deadline passed.
		this.#wake("timeout");
	};

	/**
	 * The active deadline passed. Pending local work means the silence is ours, not the provider's:
	 * the deadline slides a full budget and the watchdog resumes from it once the work completes, so a
	 * provider that stalls afterwards is still caught. Anything else throws the timeout.
	 */
	#extendOrThrowTimeout(): void {
		if (this.#hasPendingLocalWork() && this.#extendForLocalWork()) return;
		const options = this.#options;
		const firstItem = this.#awaitingFirstItem;
		invokeTimeoutHook(firstItem ? options.onFirstItemTimeout : options.onIdle);
		this.close();
		const base = firstItem ? (options.firstItemErrorMessage ?? options.errorMessage) : options.errorMessage;
		throw new AIError.StreamTimeoutError(
			this.#localWorkHoldExpired ? `${base} (a local tool held the stream open without completing)` : base,
		);
	}

	#hasPendingLocalWork(): boolean {
		const options = this.#options;
		if (!options.hasPendingLocalWork) return false;
		try {
			const pending = options.hasPendingLocalWork();
			// The bound is on one CONTINUOUS stretch of local work, so the clock
			// starts when work appears and clears the moment it drains.
			if (!pending) this.#localWorkHoldStartedAt = undefined;
			return pending;
		} catch {
			// False matches the documented default for a caller that supplies no predicate at all, so a
			// throwing predicate cannot hold the idle timer off forever. The timer is the safety net; a
			// predicate that fails must not disable it.
			return false;
		}
	}

	#extendForLocalWork(): boolean {
		const now = Date.now();
		this.#localWorkHoldStartedAt ??= now;
		if (this.#maxLocalWorkHoldMs > 0 && now - this.#localWorkHoldStartedAt >= this.#maxLocalWorkHoldMs) {
			// Refusing to slide any further is what turns an unbounded silence
			// into a reported failure the turn can recover from.
			this.#localWorkHoldExpired = true;
			return false;
		}
		if (!this.#awaitingFirstItem) {
			this.#lastProgressAt = now;
		} else if (this.#firstItemBudgetMs !== undefined) {
			this.#firstItemDeadlineMs = now + this.#firstItemBudgetMs;
		}
		return true;
	}

	#isProgressItem(item: T): boolean {
		const options = this.#options;
		if (!options.isProgressItem) return true;
		try {
			return options.isProgressItem(item);
		} catch {
			// True on purpose: treating an unclassifiable item as PROGRESS keeps the idle timer from firing on
			// a stream that is in fact moving. The conservative direction here is to not kill a live stream,
			// and the opposite default would abort a working request because a predicate threw.
			return true;
		}
	}
}

/**
 * Yields items from an async iterable while enforcing a maximum idle gap between items.
 *
 * The first item may use a shorter timeout so stuck requests can be aborted and retried
 * before any user-visible content has streamed.
 */
export async function* iterateWithIdleTimeout<T>(
	iterable: AsyncIterable<T>,
	options: IdleTimeoutIteratorOptions,
): AsyncGenerator<T> {
	const iterator = iterable[Symbol.asyncIterator]();
	if (options.abortSignal?.aborted) {
		returnQuietly(iterator);
		throw abortReason(options.abortSignal);
	}
	const watchdog = new IdleWatchdog(iterator, options);
	try {
		while (true) {
			watchdog.throwIfAborted();
			const deadlineMs = watchdog.enforceDeadline();
			watchdog.throwIfAborted();
			const wait = watchdog.pull(deadlineMs);
			// Tracks whether this iteration handed an item to the consumer and resumed
			// normally. Any other exit — internal throw, `done` return, or the consumer
			// abandoning us via `.return()`/`.throw()` at the `yield` below — must close
			// the upstream iterator so the underlying SSE body / SDK stream (and its
			// socket) is released instead of being left suspended.
			let continuing = false;
			try {
				if (wait !== undefined) await wait;
				const result = watchdog.take();
				if (result === undefined) {
					// A local tool is still running; the provider cannot make
					// progress until we hand its result back. Keep waiting.
					continuing = true;
					continue;
				}
				if (result.done) {
					watchdog.sourceDone();
					return;
				}
				watchdog.observe(result.value);
				yield result.value;
				continuing = true;
			} finally {
				if (!continuing) watchdog.close();
			}
		}
	} finally {
		watchdog.dispose();
	}
}

export interface TerminalGraceIteratorOptions {
	/**
	 * Epoch-ms timestamp at which the consumer observed a logically terminal
	 * item (e.g. a chat-completions chunk carrying `finish_reason`), or
	 * `undefined` while the stream is still mid-response. Read before every
	 * pull, so the consumer can flip it between yields.
	 */
	finishedAtMs: () => number | undefined;
	/**
	 * Post-terminal budget: how long after `finishedAtMs()` to keep draining
	 * trailing items (e.g. a usage-only chunk or the `[DONE]` sentinel) before
	 * ending the iteration cleanly. The deadline is fixed at
	 * `finishedAtMs() + graceMs`; trailing items do not extend it, so
	 * keepalive-only servers cannot hold the stream open.
	 */
	graceMs: number;
	/**
	 * Invoked when the grace window closes with the source still open. Use it
	 * to abort the underlying request: the source generator is typically parked
	 * mid-`next()` (not at a yield), so a queued `.return()` alone cannot reach
	 * the transport until that pending read settles.
	 */
	onGraceEnd?: () => void;
}

/**
 * Yields items from an async iterable until the consumer marks the stream
 * logically finished AND the source stays silent past a short grace window.
 *
 * Misbehaving OpenAI-compatible servers deliver the terminal chunk but never
 * send `[DONE]` nor close the connection; without this guard the consumer
 * hangs on `iterator.next()` until the idle watchdog converts an
 * already-successful turn into a timeout error. Grace expiry is a clean end
 * of iteration, never an error.
 */
export async function* iterateWithTerminalGrace<T>(
	iterable: AsyncIterable<T>,
	options: TerminalGraceIteratorOptions,
): AsyncGenerator<T> {
	const iterator = iterable[Symbol.asyncIterator]();
	let iteratorDone = false;
	let graceEndCalled = false;
	const invokeGraceEnd = (): void => {
		if (graceEndCalled) return;
		graceEndCalled = true;
		try {
			options.onGraceEnd?.();
		} catch {
			// Grace expiry is a successful logical completion. A transport-cleanup
			// hook cannot convert it into a failed response.
		}
	};
	try {
		while (true) {
			const finishedAtMs = options.finishedAtMs();
			if (finishedAtMs === undefined) {
				const result = await iterator.next();
				if (result.done) {
					iteratorDone = true;
					return;
				}
				yield result.value;
				continue;
			}
			const remainingMs = finishedAtMs + options.graceMs - Date.now();
			if (remainingMs <= 0) {
				invokeGraceEnd();
				return;
			}
			const nextPromise = iterator.next();
			const timeout = Promise.withResolvers<"timeout">();
			const timer = setTimeout(() => timeout.resolve("timeout"), remainingMs);
			try {
				const outcome = await Promise.race([nextPromise, timeout.promise]);
				if (outcome === "timeout") {
					// The abandoned read settles (likely rejects) once onGraceEnd
					// aborts the transport — mark it handled so it cannot surface
					// as an unhandled rejection.
					void Promise.resolve(nextPromise).catch(() => {});
					invokeGraceEnd();
					return;
				}
				if (outcome.done) {
					iteratorDone = true;
					return;
				}
				yield outcome.value;
			} finally {
				clearTimeout(timer);
			}
		}
	} finally {
		if (!iteratorDone) returnQuietly(iterator);
	}
}

/**
 * Closes an iterator whose iteration already ended for another reason. The reason has precedence over
 * a source that objects to being closed, so neither a synchronous throw from `return()` nor a rejected
 * return promise can replace the error or the clean completion already on its way to the consumer.
 */
function returnQuietly(iterator: AsyncIterator<unknown>): void {
	try {
		const returnPromise = iterator.return?.();
		if (returnPromise) void Promise.resolve(returnPromise).catch(() => {});
	} catch {
		// See the doc comment: a close failure never outranks the outcome being produced.
	}
}

/** Hooks abort or observe the transport; their failure cannot replace the stable StreamTimeoutError. */
function invokeTimeoutHook(callback: (() => void) | undefined): void {
	try {
		callback?.();
	} catch {
		// See the doc comment.
	}
}

function abortReason(signal: AbortSignal): Error {
	const reason = signal.reason;
	if (reason instanceof Error) return reason;
	if (typeof reason === "string") return new AIError.RequestAbortError(reason);
	return new AIError.RequestAbortError();
}

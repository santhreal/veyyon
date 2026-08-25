import { describe, expect, it } from "bun:test";
import { waitForProjectLoaded } from "@veyyon/coding-agent/lsp/client";
import type { LspClient } from "@veyyon/coding-agent/lsp/types";

/**
 * WHY: `waitForProjectLoaded` raced `client.projectLoaded` against an abort
 * listener registered with `{ once: true }`. `once` detaches a listener when it
 * FIRES, not when the race is decided, and in the overwhelmingly common case
 * the race is won by a `projectLoaded` that already settled — project loading
 * finishes once, while every later feature call still waits on it. The listener
 * was therefore never removed.
 *
 * The signal outlives the call: LSP features are handed the turn's or session's
 * signal, so one navigation session registers one listener per `gotoDefinition`,
 * `findReferences`, `hover` and friends. That retains every closure until the
 * turn ends, trips `MaxListenersExceededWarning`, and fires the whole pile at
 * once when the turn finally aborts.
 *
 * CLASS CLOSED: the function must leave the caller's signal exactly as it found
 * it, on the settled path and on the abort path alike, and must still resolve
 * in both cases.
 *
 * NOT CAUGHT: this counts registrations on the signal it is handed. It says
 * nothing about listeners a downstream rust-analyzer wait may attach, which is
 * a separate seam with its own signal handling.
 */

/** A client whose project load has already settled, which is the common case. */
function settledClient(): LspClient {
	return {
		config: { command: "typescript-language-server" },
		projectLoaded: Promise.resolve(),
	} as unknown as LspClient;
}

/** Wrap a real signal so abort registrations and removals can be counted. */
function countingSignal(): { signal: AbortSignal; live: () => number; abort: () => void } {
	const controller = new AbortController();
	const signal = controller.signal;
	const add = signal.addEventListener.bind(signal);
	const remove = signal.removeEventListener.bind(signal);
	let live = 0;
	signal.addEventListener = ((type: string, listener: EventListener, options?: unknown) => {
		if (type === "abort") live++;
		return add(type as "abort", listener, options as AddEventListenerOptions);
	}) as typeof signal.addEventListener;
	signal.removeEventListener = ((type: string, listener: EventListener, options?: unknown) => {
		if (type === "abort") live--;
		return remove(type as "abort", listener, options as EventListenerOptions);
	}) as typeof signal.removeEventListener;
	return { signal, live: () => live, abort: () => controller.abort() };
}

describe("waiting for project load does not accumulate abort listeners", () => {
	it("leaves no abort listener behind after a single settled wait", async () => {
		const { signal, live } = countingSignal();
		await waitForProjectLoaded(settledClient(), signal);
		expect(live()).toBe(0);
	});

	it("leaves no abort listener behind across many waits on one long-lived signal", async () => {
		const { signal, live } = countingSignal();
		for (let i = 0; i < 25; i++) {
			await waitForProjectLoaded(settledClient(), signal);
		}
		expect(live()).toBe(0);
	});

	it("still resolves when the signal aborts before the project finishes loading", async () => {
		const { signal, live, abort } = countingSignal();
		const never = { config: { command: "typescript-language-server" }, projectLoaded: new Promise<void>(() => {}) };
		const pending = waitForProjectLoaded(never as unknown as LspClient, signal);
		abort();
		await pending;
		expect(live()).toBe(0);
	});

	it("returns immediately for a signal that is already aborted", async () => {
		const { signal, live, abort } = countingSignal();
		abort();
		const never = { config: { command: "typescript-language-server" }, projectLoaded: new Promise<void>(() => {}) };
		await waitForProjectLoaded(never as unknown as LspClient, signal);
		expect(live()).toBe(0);
	});

	it("still resolves when no signal is supplied at all", async () => {
		await waitForProjectLoaded(settledClient());
	});
});

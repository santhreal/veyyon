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
 *
 * SECOND CLASS, SAME FUNCTION: every case above named one server, and the one
 * server it named was the one the bug could not reach. `waitForProjectLoaded`
 * runs a second wait for rust-analyzer, and that wait begins by THROWING on an
 * aborted signal. The race resolves on abort without re-reading the signal, so
 * cancelling mid-wait returned cleanly on every server and threw `AbortError`
 * on rust-analyzer alone: one function with two contracts, chosen by the
 * language of the file the caller happened to open. Every case that involves a
 * signal is now swept over the server kinds, so a branch reachable by one
 * server and not the others fails here.
 *
 * ALSO NOT CAUGHT: what the rust-analyzer wait does once it is legitimately
 * entered. This proves it is not entered after an abort, not that it behaves.
 */

/**
 * The server kinds the function branches on, by the spelling `isRustAnalyzerClient` reads. A
 * server added to that predicate belongs here, or the sweep silently stops covering it.
 */
const SERVER_COMMANDS = ["typescript-language-server", "rust-analyzer", "/usr/local/bin/rust-analyzer", "gopls"];

/**
 * Enough client for the rust-analyzer branch to run the way it does against a server that has
 * gone away: the status request is written, the write rejects, and the wait gives up. A thinner
 * fake makes `sendRequest` throw before its own cleanup and reports a leak this code does not
 * have.
 */
function clientShell(command: string, projectLoaded: Promise<void>): LspClient {
	return {
		config: { command, workspaceReadyTimings: { timeoutMs: 5, pollMs: 1, settleMs: 0, statusRequestTimeoutMs: 5 } },
		projectLoaded,
		requestId: 0,
		lastActivity: Date.now(),
		pendingRequests: new Map(),
		writeQueue: Promise.resolve(),
		proc: {
			stdin: {
				write() {
					throw new Error("server is gone");
				},
				flush: async () => {},
			},
		},
	} as unknown as LspClient;
}

/** A client whose project load has already settled, which is the common case. */
function settledClient(command = "typescript-language-server"): LspClient {
	return clientShell(command, Promise.resolve());
}

/** A client whose project load never settles, so only the signal can end the wait. */
function neverLoadingClient(command: string): LspClient {
	return clientShell(command, new Promise<void>(() => {}));
}

/** Reject rather than hang if a wait that must end does not. A hang is invisible to a value check. */
function within<T>(work: Promise<T>, label: string): Promise<T> {
	return Promise.race([
		work,
		new Promise<never>((_, reject) => {
			setTimeout(() => reject(new Error(`${label} did not settle within 2000ms`)), 2000).unref?.();
		}),
	]);
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
	const commands: string[] = [...SERVER_COMMANDS];

	it.each(commands)("leaves no abort listener behind after a settled wait on %s", async command => {
		const { signal, live } = countingSignal();
		await within(waitForProjectLoaded(settledClient(command), signal), command);
		expect(live()).toBe(0);
	});

	it("leaves no abort listener behind across many waits on one long-lived signal", async () => {
		const { signal, live } = countingSignal();
		for (let i = 0; i < 25; i++) {
			await waitForProjectLoaded(settledClient(), signal);
		}
		expect(live()).toBe(0);
	});

	it.each(commands)("returns rather than throws when %s is aborted mid-load", async command => {
		// The asymmetry, in the shape the caller sees it. Aborting a wait is the caller's own
		// act, and this function's answer to it is to return; a server that answers with a
		// throw makes every LSP feature call need a catch on one language and not the others.
		const { signal, live, abort } = countingSignal();
		const pending = waitForProjectLoaded(neverLoadingClient(command), signal);
		abort();
		await within(pending, command);
		expect(live()).toBe(0);
	});

	it.each(commands)("returns immediately for a signal already aborted before %s is asked", async command => {
		const { signal, live, abort } = countingSignal();
		abort();
		await within(waitForProjectLoaded(neverLoadingClient(command), signal), command);
		expect(live()).toBe(0);
	});

	it("still resolves when no signal is supplied at all", async () => {
		await within(waitForProjectLoaded(settledClient()), "no signal");
	});

	it("agrees across every server kind, so no branch answers an abort differently", async () => {
		// Non-vacuity for the sweep: each case above could pass for a different reason per
		// server. This settles them together and requires one outcome.
		const outcomes = await Promise.all(
			commands.map(async command => {
				const controller = new AbortController();
				const pending = waitForProjectLoaded(neverLoadingClient(command), controller.signal);
				controller.abort();
				return within(pending, command).then(
					() => `${command}: returned`,
					(error: unknown) => `${command}: threw ${(error as Error).name}`,
				);
			}),
		);

		expect(outcomes).toEqual(commands.map(command => `${command}: returned`));
	});
});

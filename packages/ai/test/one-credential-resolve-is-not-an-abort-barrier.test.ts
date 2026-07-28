/**
 * A single credential resolve forwards the caller's signal; it never raises the abort itself.
 *
 * WHY THIS SUITE EXISTS. `resolveApiKeyOnce` grew an abort preflight that ran before it looked at
 * the key at all, so an already-cancelled request threw `signal.reason` even when there was no key
 * to resolve and nothing to cancel. The agent loop calls it while preparing a request and then, a
 * few lines later, renders cancellation as an assistant message with `stopReason: "aborted"` and a
 * readable `errorMessage`. A throw from the preflight unwound past that path entirely, so the run
 * rejected with a bare `AbortError` `DOMException` and the user's own Ctrl-C arrived looking like a
 * crash. Eight agent-loop abort tests failed on it at once, which is what a shared preflight does:
 * it changes the meaning of cancellation for every caller downstream of it.
 *
 * THE RULE THIS PINS. Deciding what a cancellation means belongs to whoever owns the signal. A lone
 * resolve does no retrying and no waiting of its own, so there is nothing here for a check to
 * prevent; it hands `signal` to the resolver, which may cancel its own I/O, and otherwise stays out
 * of the way. That is different from the retry driver (`withAuth`), which owns a loop that would
 * otherwise keep minting keys after the user left, and where the check therefore belongs.
 *
 * The tests below assert the resolved VALUE for each key shape under an aborted signal, because
 * "did not throw" alone would still pass if the function silently returned `undefined` for a key it
 * was handed. A dropped key is not a smaller version of this bug, it is the next one: the request
 * goes out unauthenticated and comes back a 401 that names nothing.
 */

import { describe, expect, it } from "bun:test";
import type { ApiKeyResolveContext } from "@veyyon/ai";
import { resolveApiKeyOnce, withAuth } from "@veyyon/ai";

/** A controller already cancelled with `reason`, the state every test here starts from. */
function abortedWith(reason?: unknown): AbortSignal {
	const controller = new AbortController();
	controller.abort(reason);
	return controller.signal;
}

describe("resolveApiKeyOnce under an already-aborted signal", () => {
	/**
	 * THE EXACT REGRESSION. The agent loop passes `config.apiKey`, which is `undefined` whenever the
	 * host resolves credentials some other way, and it passes the run's signal. Cancel the run before
	 * the first provider call and this pair is what the preflight saw: no key, an aborted signal, and
	 * a throw where the loop expected a value.
	 */
	it("returns undefined for an absent key instead of raising the caller's abort", async () => {
		expect(await resolveApiKeyOnce(undefined, abortedWith())).toBeUndefined();
	});

	/**
	 * A static bearer is already resolved. There is no work between the call and the return, so a
	 * cancellation cannot land "during" it, and withholding the string only breaks the caller that
	 * asked for it.
	 */
	it("returns a static bearer unchanged", async () => {
		expect(await resolveApiKeyOnce("sk-static-bearer", abortedWith())).toBe("sk-static-bearer");
	});

	/**
	 * The resolver form is the only shape that does work, and it is still invoked: it owns whatever
	 * I/O it performs and gets the signal to cancel that I/O with. Skipping the call here would be
	 * this module deciding on its behalf, which is the same overreach in the other direction.
	 */
	it("still invokes a resolver and returns what it minted", async () => {
		let calls = 0;
		const resolved = await resolveApiKeyOnce(() => {
			calls += 1;
			return "minted-after-abort";
		}, abortedWith());

		expect(calls).toBe(1);
		expect(resolved).toBe("minted-after-abort");
	});

	/**
	 * The signal REACHES the resolver, which is the whole mechanism that replaces the removed
	 * preflight. Asserted on the context object rather than on a boolean, so a future change that
	 * forwards a fresh signal (or none) fails here rather than silently making resolver-side
	 * cancellation impossible.
	 */
	it("hands the caller's signal to the resolver, along with an initial-resolve context", async () => {
		const signal = abortedWith("user interrupt");
		let seen: ApiKeyResolveContext | undefined;

		await resolveApiKeyOnce(ctx => {
			seen = ctx;
			return "k";
		}, signal);

		expect(seen).toEqual({ lastChance: false, error: undefined, signal });
		expect(seen?.signal?.aborted).toBe(true);
		expect(seen?.signal?.reason).toBe("user interrupt");
	});

	/**
	 * A resolver that DOES honour the signal propagates its own error untouched. This is the
	 * behaviour the preflight was imitating, and the difference matters: here the throw comes from
	 * the code that was actually cancelled, carrying its own message, rather than from a wrapper that
	 * cancelled nothing.
	 */
	it("propagates a cancellation the resolver itself raises", async () => {
		const signal = abortedWith();
		const boom = new DOMException("mint cancelled", "AbortError");

		await expect(
			resolveApiKeyOnce(ctx => {
				ctx.signal?.throwIfAborted();
				return "unreachable";
			}, signal),
		).rejects.toThrow("The operation was aborted");

		await expect(
			resolveApiKeyOnce(() => {
				throw boom;
			}, signal),
		).rejects.toThrow("mint cancelled");
	});

	/**
	 * NON-VACUITY. Everything above would also pass if `signal` were ignored outright, so this pins
	 * the un-aborted path to the same values: the tests are about WHO decides, not about the signal
	 * being inert.
	 */
	it("behaves identically when the signal is live", async () => {
		const live = new AbortController().signal;

		expect(await resolveApiKeyOnce(undefined, live)).toBeUndefined();
		expect(await resolveApiKeyOnce("sk-static-bearer", live)).toBe("sk-static-bearer");
		expect(await resolveApiKeyOnce(() => "minted-after-abort", live)).toBe("minted-after-abort");
	});
});

describe("the retry driver keeps the cancellation check the single resolve gave up", () => {
	/**
	 * WHERE THE CHECK BELONGS. `withAuth` owns a loop: it re-resolves and re-attempts after an auth
	 * failure, so a run cancelled mid-retry would otherwise mint another credential and fire another
	 * request for a user who has already left. Removing the preflight from `resolveApiKeyOnce` must
	 * not remove it here, and this test fails if the two are ever collapsed back together.
	 */
	it("refuses to start a retry sequence for an already-cancelled request", async () => {
		let attempts = 0;

		await expect(
			withAuth(
				() => "k",
				() => {
					attempts += 1;
					return Promise.resolve("unreachable");
				},
				{ signal: abortedWith("user interrupt") },
			),
		).rejects.toBe("user interrupt");

		expect(attempts).toBe(0);
	});

	/**
	 * NON-VACUITY for the driver: the same call runs normally on a live signal, so the test above is
	 * proving the abort check and not some unrelated rejection.
	 */
	it("runs the attempt when the request is live", async () => {
		let attempts = 0;
		const result = await withAuth(
			() => "k",
			key => {
				attempts += 1;
				return Promise.resolve(`used:${key}`);
			},
			{ signal: new AbortController().signal },
		);

		expect(result).toBe("used:k");
		expect(attempts).toBe(1);
	});
});

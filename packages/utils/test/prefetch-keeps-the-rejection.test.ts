/**
 * `prefetch` must suppress the UNHANDLED rejection without suppressing the rejection.
 *
 * WHY THIS SUITE EXISTS. Startup code kicks off independent discoveries in parallel and awaits each one
 * where its value is needed, often many statements later. A rejection arriving before that await is an
 * unhandled rejection, which the host may report loudly or exit on, for a failure the consumer site is
 * about to handle correctly. Eight sites in `sdk.ts` solved that by writing `somePromise.catch(() => {})`
 * inline, one per discovery, which is the same line copied eight times with nothing saying why -- and it is
 * one character away from `somePromise = somePromise.catch(() => {})`, which really would swallow the
 * failure and hand every consumer `undefined` instead.
 *
 * `prefetch` exists so that reason is written once and the shape cannot drift. This suite pins the property
 * that makes it safe: the returned promise is the same promise, and awaiting it still throws. A future
 * "simplification" that returned a caught promise would turn every startup discovery failure into a silent
 * `undefined`, and these tests fail the moment it does.
 */

import { describe, expect, it } from "bun:test";
import { prefetch } from "@veyyon/utils/async";

describe("a prefetched promise that succeeds", () => {
	/** The ordinary case: the value is delivered untouched. */
	it("delivers its value to the later await", async () => {
		const value = await prefetch(Promise.resolve({ files: ["AGENTS.md"] }));

		expect(value).toEqual({ files: ["AGENTS.md"] });
	});

	/** The identity property. Returning a NEW promise is what would make the wrapper lossy. */
	it("returns the same promise object it was given", () => {
		const original = Promise.resolve(1);

		expect(prefetch(original)).toBe(original);
	});
});

describe("a prefetched promise that rejects", () => {
	/**
	 * The contract that matters. If this ever passes with `undefined` instead of throwing, every startup
	 * discovery has become a silent no-result and the operator sees a degraded session with no error.
	 */
	it("still throws the original error at the await", async () => {
		const failure = new Error("discoverContextFiles failed: EACCES");

		const promise = prefetch(Promise.reject(failure));

		await expect(promise).rejects.toBe(failure);
	});

	/**
	 * The reason the function exists: the rejection may land long before anyone awaits. Two macrotasks pass
	 * here, which is well past the point where an unguarded rejection would already have been reported, and
	 * the error still arrives intact at the eventual await.
	 */
	it("survives a long gap between the rejection and the await", async () => {
		const failure = new Error("discoverSkills failed");
		const promise = prefetch(Promise.reject(failure));

		await Bun.sleep(1);
		await Bun.sleep(1);

		let caught: unknown;
		try {
			await promise;
		} catch (error) {
			caught = error;
		}
		expect(caught).toBe(failure);
	});

	/**
	 * Several consumers may await the same prefetched promise (a discovery feeding two call sites). Each one
	 * must see the failure; a wrapper that consumed the rejection would give the second consumer a resolved
	 * `undefined` and produce two different beliefs about the same startup step.
	 */
	it("delivers the failure to every awaiting consumer", async () => {
		const failure = new Error("discoverAdvisorConfigs failed");
		const promise = prefetch(Promise.reject(failure));

		const results = await Promise.allSettled([promise, promise, promise]);

		expect(results.map(result => result.status)).toEqual(["rejected", "rejected", "rejected"]);
		expect(results.map(result => (result as PromiseRejectedResult).reason)).toEqual([failure, failure, failure]);
	});
});

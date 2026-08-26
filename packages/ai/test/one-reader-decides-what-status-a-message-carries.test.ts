/**
 * Contract: an HTTP status is read out of a failure by exactly one reader.
 *
 * WHY THIS EXISTS. Two extractors read the same evidence and disagreed about it.
 * `extractHttpStatusFromError` in `@veyyon/utils/fetch-retry` matched `error(503)` and
 * `502 error`; `AIError.status` in `@veyyon/ai/error/flags` matched `status_code: 429` and
 * `429 Too Many Requests`. Neither matched the other's set, and the two feed different
 * ladders: the auth ladder rotates a credential on a 401, the retry ladder backs off on a
 * 5xx. One provider message could therefore be a retryable 503 to one caller and an
 * unclassified failure to the other, on nothing but which spelling the provider chose.
 *
 * They also walked the cause chain differently. The utils reader asked an error for its own
 * message before asking its cause for a `status` field; the ai reader asked the cause first.
 * An error whose message says one thing and whose cause carries another got two answers.
 *
 * THE CLASS, not the incident: the suite sweeps every spelling BOTH readers ever matched and
 * requires the two entry points to agree on all of them, so a pattern added to one and not the
 * other fails here rather than in a retry decision. It also pins the precedence rule that
 * settled the traversal disagreement -- a structured field anywhere in the chain outranks
 * prose anywhere in it -- because "they agree" is satisfied by two readers that are both wrong.
 *
 * WHAT IT DOES NOT CATCH: whether a status a provider states is the status that provider meant.
 * These readers extract; they do not adjudicate.
 */

import { describe, expect, it } from "bun:test";
import * as AIError from "@veyyon/ai/error";
import { extractHttpStatusFromError } from "@veyyon/utils/fetch-retry";

/** Every spelling either reader matched before they were merged, with the status it names. */
const SPELLINGS: ReadonlyArray<readonly [string, number]> = [
	// Matched only by the utils reader.
	["upstream error (429)", 429],
	["got a 502 error", 502],
	["Error: 401 unauthorized", 401],
	// Matched only by the ai reader.
	["status_code: 429", 429],
	["status_code=503", 503],
	["gateway said 429 Too Many Requests", 429],
	["request failed: 502", 502],
	["failed 504 downstream", 504],
	// Matched by both.
	["HTTP 503 from gateway", 503],
	["status 401", 401],
	["status: 500", 500],
	["503 status returned", 503],
];

describe("both entry points read a status the same way", () => {
	const spellings: Array<readonly [string, number]> = [...SPELLINGS];

	it.each(spellings)("reads %p as %p through fetch-retry", (message, expected) => {
		expect(extractHttpStatusFromError(new Error(message))).toBe(expected);
	});

	it.each(spellings)("reads %p as %p through AIError.status", (message, expected) => {
		expect(AIError.status(new Error(message))).toBe(expected);
	});

	it("agrees on every spelling, including the ones neither reader used to share", () => {
		const disagreements = spellings
			.map(([message]) => {
				const fromUtils = extractHttpStatusFromError(new Error(message));
				const fromAi = AIError.status(new Error(message));
				return fromUtils === fromAi ? undefined : `${message}: ${fromUtils} vs ${fromAi}`;
			})
			.filter((entry): entry is string => entry !== undefined);

		expect(disagreements).toEqual([]);
	});
});

describe("a structured field outranks prose, at every depth", () => {
	it("prefers a cause's status field over the outer message", () => {
		// The traversal disagreement, in one value. The utils reader answered 429 here because
		// it read its own message before the cause; the ai reader answered 401. A field the
		// transport set is evidence, a message is a string somebody formatted.
		const error = new Error("HTTP 429 from gateway");
		Object.assign(error, { cause: { status: 401 } });

		expect(extractHttpStatusFromError(error)).toBe(401);
		expect(AIError.status(error)).toBe(401);
	});

	it("falls back to prose when no field in the chain holds a status", () => {
		const error = new Error("upstream error (503)");
		Object.assign(error, { cause: new Error("no status here") });

		expect(extractHttpStatusFromError(error)).toBe(503);
		expect(AIError.status(error)).toBe(503);
	});

	it("reads prose from a cause when the outer error has none", () => {
		const error = new Error("");
		Object.assign(error, { cause: new Error("status_code: 502") });

		expect(extractHttpStatusFromError(error)).toBe(502);
		expect(AIError.status(error)).toBe(502);
	});

	it("stops at depth 2 rather than walking an unbounded chain", () => {
		// Termination, asserted rather than assumed: a cause chain is provider-shaped data and
		// can be cyclic. Four links deep is past the bound, so the status is not found at all.
		const deep = new Error("outer");
		Object.assign(deep, { cause: { cause: { cause: { cause: { status: 418 } } } } });

		expect(extractHttpStatusFromError(deep)).toBeUndefined();
		expect(AIError.status(deep)).toBeUndefined();
	});

	it("rejects a number outside the status range", () => {
		expect(extractHttpStatusFromError({ status: 999 })).toBeUndefined();
		expect(AIError.status({ status: 999 })).toBeUndefined();
		expect(extractHttpStatusFromError(new Error("error: 999"))).toBeUndefined();
	});
});

describe("the readers are one function", () => {
	it("gives identical answers on a value neither list anticipated", () => {
		// Non-vacuity of the sweep above, which only proves agreement on spellings someone
		// wrote down. Two independent implementations can agree on a curated list and diverge
		// on the next string; one function cannot.
		for (const message of [
			"unexpected 418 Teapot",
			"HTTP/1.1 500",
			"no status at all",
			"status_code:404",
			"error = 403",
		]) {
			expect(AIError.status(new Error(message)), message).toBe(extractHttpStatusFromError(new Error(message)));
		}
	});
});

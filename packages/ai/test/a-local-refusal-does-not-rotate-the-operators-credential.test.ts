/**
 * Contract: a failure decided on this side of the wire never drives the auth ladder, and never
 * has to go silent to avoid it.
 *
 * WHY THIS EXISTS. `isAuthRetryableError` decides whether to refresh and rotate a credential, and
 * two of its three tests read prose: a 401 anywhere in an error's message or its cause chain is
 * taken as upstream refusing the key. That is right for a response and wrong for a decision made
 * here. `pi-native`'s `onPayload` hook is the case in the tree: a caller's sanitizer rejecting a
 * request is local policy, and a sanitizer whose own message quoted a 401 would have spent the
 * operator's credential pool walking siblings that were never asked anything.
 *
 * It avoided that by throwing away the rejection. The operator saw "pi-native onPayload hook
 * rejected" and nothing else -- the seam named, the failure not -- and the reason was unreachable:
 * it sat on a field no renderer read, and moving it to `message` or `cause` would have put it back
 * on the classifier's path, since `extractHttpStatusFromError` reads both.
 *
 * THE CLASS: an error may state that its text is its own. `AUTH_EVIDENCE_LOCAL` is that statement,
 * and the sweep below requires it to hold for every message the classifier would otherwise act on,
 * rather than for the one spelling that prompted it.
 *
 * WHAT IT DOES NOT CATCH: an error that SHOULD carry the marker and does not. Nothing can tell a
 * local refusal from an upstream one by looking at it; that is why the marker is set at the throw
 * site rather than inferred.
 */

import { describe, expect, it } from "bun:test";
import { AUTH_EVIDENCE_LOCAL, isAuthRetryableError } from "@veyyon/ai/error/auth-classify";

/** Messages the classifier acts on, so the marker has to survive all of them and not one. */
const ROTATING_MESSAGES = [
	"401 Unauthorized",
	"Error: 401 invalid api key",
	"status_code: 401",
	"HTTP 401 from gateway",
	"rate limit reached for your account",
];

class LocalRefusal extends Error {
	readonly [AUTH_EVIDENCE_LOCAL] = true;

	constructor(message: string) {
		super(message);
		this.name = "LocalRefusal";
	}
}

describe("the classifier acts on upstream evidence", () => {
	const messages: string[] = [...ROTATING_MESSAGES];

	it.each(messages)("rotates on %p when the failure came from upstream", message => {
		expect(isAuthRetryableError(new Error(message))).toBe(true);
	});

	it.each(messages)("does not rotate on %p when the failure was decided locally", message => {
		expect(isAuthRetryableError(new LocalRefusal(message))).toBe(false);
	});

	it("reads the marker on the error itself and not on its cause", () => {
		// A local failure wrapping an upstream one is still upstream evidence: the wrapper
		// saw a real 401. Only the error that claims the text is its own opts out.
		const wrapped = new Error("401 Unauthorized");
		Object.assign(wrapped, { cause: new LocalRefusal("local policy") });

		expect(isAuthRetryableError(wrapped)).toBe(true);
	});

	it("ignores a marker that is not exactly true", () => {
		// The opt-out disables credential rotation, so a truthy-looking value does not buy it.
		for (const value of ["true", 1, {}]) {
			const error = Object.assign(new Error("401 Unauthorized"), { [AUTH_EVIDENCE_LOCAL]: value });

			expect(isAuthRetryableError(error), String(value)).toBe(true);
		}
	});

	it("leaves a non-auth failure alone either way", () => {
		// Non-vacuity: the marker is not what makes these false.
		expect(isAuthRetryableError(new Error("500 Internal Server Error"))).toBe(false);
		expect(isAuthRetryableError(new LocalRefusal("500 Internal Server Error"))).toBe(false);
	});
});

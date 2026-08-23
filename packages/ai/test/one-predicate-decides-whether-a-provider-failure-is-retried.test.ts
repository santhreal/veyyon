import { describe, expect, it } from "bun:test";
import { classify, Flag, is, isProviderRetryableError, isTransientStatus } from "@veyyon/ai/error";
import * as fetchRetry from "@veyyon/utils/fetch-retry";

/**
 * WHY THIS SUITE EXISTS. One provider sentence was matched by two rule sets. `@veyyon/ai/error` had
 * the classifier and its transient vocabulary; `@veyyon/utils/fetch-retry` had `isRetryableError`
 * with a vocabulary of its own and a validation veto, and `isProviderRetryableError` consulted it as
 * a last resort. The two had drifted apart by a phrase — `unable to connect` was in one list and not
 * the other — so a provider that could not be reached at all was retried by the utils list while
 * carrying no flag, and the session layer, which reads flags, saw an unclassified failure. Every
 * disagreement between the two homes had been fixed at whichever call site noticed it.
 *
 * THE CLASS THIS CLOSES: a retry decision with two authors. `isProviderRetryableError` is the only
 * predicate that answers it now; `utils` keeps what a transport states about ITSELF (an HTTP/2 code,
 * a status number, a socket-close phrasing) and states no verdict. The four cases that used to be
 * asserted against the utils predicate live here, against the one that decides.
 *
 * WHAT IT DOES NOT CATCH. It does not sweep the retry LOOPS: thirteen of them still ask this
 * predicate rather than `recover(id, stage)`, and a loop that reaches its own conclusion from prose
 * would pass this file. Each is migrated with its own suite. It also does not decide whether an
 * abort should be retried — see the last block, which pins today's answer and says why.
 */

/** A `{status, message}` shape, which is what a provider SDK rejects with. */
function statusError(status: number, message: string): Error {
	return Object.assign(new Error(message), { status });
}

describe("the retry decision has one author", () => {
	/**
	 * Existence is the contract here: a second exported decision in `utils` is the defect, whatever it
	 * is named or however correct its answers are, because `ai` composes this module and the two
	 * cannot be kept in step by review.
	 */
	it("is not answered a second time in utils", () => {
		expect("isRetryableError" in fetchRetry).toBe(false);
	});

	/**
	 * The transport FACTS stay in utils and are still exported, because the registry composes them.
	 * Removing one of these is what would push a rule back into a second home.
	 */
	it("still reads the transport facts utils owns", () => {
		for (const name of [
			"http2ErrorCode",
			"http2RetryVerdict",
			"isRetryableStatus",
			"isUnexpectedSocketCloseMessage",
			"extractHttpStatusFromError",
		]) {
			expect(name in fetchRetry, `utils/fetch-retry no longer exports ${name}`).toBe(true);
		}
	});
});

describe("the cases the second home used to answer", () => {
	/**
	 * Migrated verbatim from `packages/utils/test/fetch-retry.test.ts`. Same inputs, same answers, one
	 * predicate: this is what proves the deletion changed no decision.
	 */
	it.each([
		["a timeout", new Error("request timed out"), true],
		["transient wording", new Error("model is overloaded"), true],
		["a failed fetch", new Error("fetch failed"), true],
		["a 401 with its own wording", statusError(401, "unauthorized"), false],
		["a 429", statusError(429, "rate limited"), true],
		["a validation shape", new Error("schema validation failed"), false],
		["wording nothing recognises", new Error("completely unknown"), false],
	])("answers %s the same as the predicate it replaced", (_label, error, expected) => {
		expect(isProviderRetryableError(error)).toBe(expected);
	});

	/**
	 * The one phrase the two lists disagreed on. It now sets a flag, which is the part that matters:
	 * the decision was already `true` through the utils fallback, but the failure reached the session
	 * carrying nothing, and a session that cannot see a transport fault cannot report one.
	 */
	it("classifies a host it could not reach at all, rather than only retrying it", () => {
		const error = new Error("unable to connect to api.example.com");

		expect(is(classify(error), Flag.Transient)).toBe(true);
		expect(isProviderRetryableError(error)).toBe(true);
	});

	/**
	 * A status with no message its rules recognise classifies to the bare number by design — an id
	 * that is only a status says so — so `Flag.Transient` is absent even for a 503 and the decision
	 * has to read the status. The set is `isTransientStatus`, read rather than re-derived, and this
	 * sweeps both sides of it so a fourth transient status cannot be added in one place only.
	 */
	it.each([408, 429, 500, 502, 503, 504])("retries a bare %i with nothing to read", status => {
		const error = statusError(status, "");

		expect(isTransientStatus(status)).toBe(true);
		expect(is(classify(error), Flag.Transient)).toBe(false);
		expect(isProviderRetryableError(error)).toBe(true);
	});

	it.each([400, 401, 403, 404, 409, 422])("refuses a bare %i with nothing to read", status => {
		expect(isTransientStatus(status)).toBe(false);
		expect(isProviderRetryableError(statusError(status, ""))).toBe(false);
	});
});

describe("an abort is retried here and refused everywhere else", () => {
	/**
	 * NOT A CONTRADICTION THIS REFACTOR RESOLVED, and the pin is deliberate. `retriable()` answers
	 * false for `Flag.Abort` and `Flag.SilentAbort`, while the utils fallback answered true for any
	 * error whose name or wording says aborted, so a provider ladder retries a cancellation the turn
	 * layer would not. Flipping it changes what happens when a user presses escape mid-stream, which
	 * is a product decision. These assertions record today's answer so the decision is visible and
	 * the flip is a deliberate edit to a test that says why, not an accident.
	 */
	it.each([
		["the DOM abort name", Object.assign(new Error("x"), { name: "AbortError" })],
		["the wording alone", new Error("the operation was aborted")],
	])("retries %s", (_label, error) => {
		expect(isProviderRetryableError(error)).toBe(true);
	});

	it("refuses the same failure at the turn, which is the disagreement", () => {
		expect(is(classify(new Error("the operation was aborted")), Flag.Transient)).toBe(false);
	});
});

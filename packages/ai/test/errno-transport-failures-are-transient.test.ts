/**
 * A dead socket is transient whether it is spelled in prose or as an errno.
 *
 * THE BUG. `TRANSIENT_TRANSPORT_PATTERN` matched every prose rendering of a broken
 * connection (`fetch failed`, `terminated`, `socket hang up`, `connection refused`,
 * `other side closed`) and no errno rendering of any of them. Node and undici
 * usually wrap the fault in one of those phrases, but not always: a rejection can
 * arrive carrying only `read ECONNRESET` or `connect ETIMEDOUT 10.0.0.1:443`.
 * Those turns were classified permanent and ended on their first attempt, while
 * the identical fault under its prose name spent the retry budget and normally
 * recovered.
 *
 * `OAUTH_TRANSIENT_FAILURE_PATTERN`, twenty lines away in the same file, has
 * always listed `ECONN(REFUSED|RESET)`, `ETIMEDOUT` and `EAI_AGAIN`. So a token
 * refresh retried exactly the bytes a model request gave up on, which is two
 * classifiers in one file disagreeing about one fault.
 *
 * WHICH DIRECTION THIS FAILS IN. Missing a transient failure ends a turn that
 * would have worked; matching too widely retries a permanent one through the whole
 * budget and hides the real error behind backoff. So both halves are asserted: the
 * codes are transient wherever a transport error puts them, and an identifier that
 * merely contains one is not, which is the same word-boundary discipline the status
 * numbers already carry (see
 * `transient-classification-does-not-read-digits-out-of-context.test.ts`).
 *
 * WHAT THIS DOES NOT COVER: whether a given turn is actually resampled. That also
 * depends on the retry budget and on whether the turn carries a tool call, which
 * makes replay unsafe. `packages/simulations/src/turn-sim/provider-error-taxonomy.test.ts`
 * drives that end to end through a real session.
 */
import { describe, expect, it } from "bun:test";
import * as AIError from "@veyyon/ai/error";
import { TRANSIENT_TRANSPORT_PATTERN } from "@veyyon/ai/error/flags";

/** Every errno the transport layer can hand up for a connection that died. */
const TRANSPORT_ERRNOS = ["ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN"] as const;

/** The shapes these arrive in, from Node, undici, and a wrapped cause chain. */
function renderings(code: string): string[] {
	return [
		code,
		`read ${code}`,
		`connect ${code} 10.0.0.1:443`,
		`request to https://api.example.com/v1/messages failed, reason: ${code}`,
		`Error: ${code}`,
	];
}

describe("errno transport failures classify as transient", () => {
	for (const code of TRANSPORT_ERRNOS) {
		it(`treats ${code} as a transport fault in every rendering`, () => {
			for (const message of renderings(code)) {
				expect(TRANSIENT_TRANSPORT_PATTERN.test(message)).toBe(true);
			}
		});
	}

	it("carries the whole set, so a new code is a decision rather than an omission", () => {
		expect(TRANSPORT_ERRNOS.length).toBe(6);
		expect(new Set(TRANSPORT_ERRNOS).size).toBe(TRANSPORT_ERRNOS.length);
	});

	for (const code of TRANSPORT_ERRNOS) {
		it(`makes an assistant message carrying ${code} retriable`, () => {
			// The pattern is an implementation detail; what the session acts on is
			// `retriable(classifyMessage(message))`, so the classification is asserted
			// through the seam the product actually reads.
			const id = AIError.classifyMessage({ errorMessage: `read ${code}` });
			expect(AIError.retriable(id)).toBe(true);
		});
	}

	it("does not resample an errno-shaped turn that carried a tool call", () => {
		// Replaying a turn whose tool call already ran can double-apply its side
		// effects, so `replayUnsafe` outranks transience. Without this the fix above
		// would have widened retry onto the one case that must not be retried.
		const id = AIError.classifyMessage({ errorMessage: "read ECONNRESET" });
		expect(AIError.retriable(id, { replayUnsafe: true })).toBe(false);
	});

	it("does not read an errno out of an identifier that contains one", () => {
		// The same false positive the status numbers had: a match anywhere in the
		// text turns a permanent failure into a retried one.
		expect(TRANSIENT_TRANSPORT_PATTERN.test("unknown model claude-ETIMEDOUT-9")).toBe(false);
		expect(TRANSIENT_TRANSPORT_PATTERN.test("invalid tool name myECONNRESETtool")).toBe(false);
		expect(TRANSIENT_TRANSPORT_PATTERN.test("bad argument EPIPELINE")).toBe(false);
	});

	it("still refuses the permanent failures that share no transport word", () => {
		// The floor that keeps the widening honest: a bad credential, a billing
		// wall, and a malformed request must stay permanent.
		expect(TRANSIENT_TRANSPORT_PATTERN.test("401 Unauthorized: invalid api key")).toBe(false);
		expect(TRANSIENT_TRANSPORT_PATTERN.test("402 Payment Required: You have depleted your credits")).toBe(false);
		expect(TRANSIENT_TRANSPORT_PATTERN.test("400 Bad Request: messages.1: tool_use ids must be unique")).toBe(false);
	});
});

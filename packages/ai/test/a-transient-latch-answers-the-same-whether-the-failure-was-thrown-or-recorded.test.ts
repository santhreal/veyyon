/**
 * WHY: `classify` and `classifyMessage` each decided on their own whether a
 * deterministic failure keeps {@link Flag.Transient}, and they disagreed.
 *
 * A failure reaches the classifier by two routes. It is THROWN, as an `Error`
 * with a `cause` chain, when a request fails and the ladder asks whether to try
 * again; it is RECORDED, as `{ errorMessage, errorStatus }` on an assistant
 * message, when the turn is written down and the transcript asks what happened.
 * Both routes are supposed to answer with the same id.
 *
 * `classifyMessage` latched llama.cpp's tool-call JSON parse failure — the
 * HTTP 500 the same prompt reproduces every time — and stripped Transient so the
 * recovery text surfaces at once. `classify` had no such branch, so the identical
 * body thrown from a request came back Transient and the retry ladder spent every
 * attempt on a result that could not change.
 *
 * THE CLASS. One fact with two owners: a post-walk latch that removes a flag,
 * written once in one entry point. It closes by both routes calling
 * `clearDeterministicTransient`, and by this suite asserting the two ids are
 * EQUAL for the same failure rather than asserting each separately — a latch
 * added to one side alone splits them again and turns this red.
 *
 * WHAT THIS DOES NOT CATCH. Latches are enumerated from the trace names the two
 * routes emit, so a latch that fires silently (clears a flag without pushing a
 * trace name) is invisible here;
 * `every-classified-failure-names-the-rule-that-classified-it.test.ts` is what
 * requires the name. Nor does it check the framing latch's own wording rules,
 * which that failure's own suite owns.
 */
import { describe, expect, it } from "bun:test";
import { classify, classifyMessage, explain, Flag, is } from "@veyyon/ai/error/flags";
import { STREAM_FRAME_LIMIT_ERROR_NAME } from "@veyyon/utils/stream-frame-limit";

/** llama.cpp's own wording for the deterministic parse failure, as it reaches the client. */
const LLAMA_CPP_500 = "HTTP 500: Failed to parse tool call arguments as JSON: [json.exception.parse_error.101]";

/** The status llama.cpp answers with, which on its own reads as retryable. */
const DETERMINISTIC_STATUS = 500;

/**
 * Every deterministic failure a latch is supposed to make non-transient, with the wording and
 * status each arrives carrying. A latch added without a row here leaves that failure unswept.
 */
const LATCHED_FAILURES: Record<string, { text: string; status: number; trace: string }> = {
	"llama.cpp tool-call parse": {
		text: LLAMA_CPP_500,
		status: DETERMINISTIC_STATUS,
		trace: "llama-cpp-tool-call-parse-clears-transient",
	},
};

/** A body whose status alone reads as retryable and which no latch names. */
const PLAIN_500 = "HTTP 500: Internal Server Error";

function thrown(text: string, status: number): Error {
	const error = new Error(text);
	Object.assign(error, { status });
	return error;
}

describe("a transient latch answers the same whether the failure was thrown or recorded", () => {
	for (const [name, failure] of Object.entries(LATCHED_FAILURES)) {
		it(`strips Transient from ${name} on both routes, with the same id`, () => {
			const thrownId = classify(thrown(failure.text, failure.status));
			const recordedId = classifyMessage({ errorMessage: failure.text, errorStatus: failure.status });

			expect(is(thrownId, Flag.Transient)).toBe(false);
			expect(is(recordedId, Flag.Transient)).toBe(false);
			expect(thrownId).toBe(recordedId);
		});

		it(`names ${failure.trace} on both routes`, () => {
			const thrownTrace: string[] = [];
			classify(thrown(failure.text, failure.status), undefined, thrownTrace);
			const recordedTrace: string[] = [];
			classifyMessage({ errorMessage: failure.text, errorStatus: failure.status }, recordedTrace);

			expect(thrownTrace).toContain(failure.trace);
			expect(recordedTrace).toContain(failure.trace);
		});

		it(`latches ${name} when it arrives wrapped in a retry wrapper's own prose`, () => {
			// The wrapper's sentence is classified before the cause carrying the failure is
			// reached, which is exactly why the latch runs after the walk rather than during it.
			const wrapped = new Error("connection error, please retry", {
				cause: thrown(failure.text, failure.status),
			});

			expect(is(classify(wrapped), Flag.Transient)).toBe(false);
		});
	}

	/**
	 * The opposite error. Stripping Transient from every 500 would make the ladder give up on a
	 * server hiccup that the next attempt clears, so the latch has to be keyed on the wording.
	 */
	it("leaves an unlatched 500 transient on both routes", () => {
		const thrownId = classify(thrown(PLAIN_500, DETERMINISTIC_STATUS));
		const recordedId = classifyMessage({ errorMessage: PLAIN_500, errorStatus: DETERMINISTIC_STATUS });

		expect(is(thrownId, Flag.Transient)).toBe(true);
		expect(is(recordedId, Flag.Transient)).toBe(true);
	});

	/**
	 * The framing latch is the other post-walk clear, and it reaches only the thrown route because
	 * a message record carries no error name. Pinning that asymmetry keeps a future reader from
	 * "fixing" it by inventing a name field on the record.
	 */
	it("clears Transient for a framing violation on the thrown route", () => {
		const framing = new Error("a line arrived with no line feed");
		framing.name = STREAM_FRAME_LIMIT_ERROR_NAME;
		const wrapped = new Error("connection error, please retry", { cause: framing });

		expect(is(classify(wrapped), Flag.Transient)).toBe(false);
		expect(explain(wrapped).rules).toContain("framing-violation-clears-transient");
	});
});

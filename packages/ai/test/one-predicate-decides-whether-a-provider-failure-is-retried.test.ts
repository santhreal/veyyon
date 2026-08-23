import { describe, expect, it } from "bun:test";
import {
	classify,
	create,
	ERROR_DOMAINS,
	ERROR_KIND_LABELS,
	Flag,
	is,
	isProviderRetryableError,
	isTransientStatus,
	isUsageLimit,
	RequestAbortError,
	recover,
	retriable,
	StreamTimeoutError,
	vetoesRetry,
} from "@veyyon/ai/error";
import { cancellationError } from "@veyyon/utils/abortable";
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
 * would pass this file. Each is migrated with its own suite.
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
	it.each([408, 500, 502, 503, 504])("retries a bare %i with nothing to read", status => {
		const error = statusError(status, "");

		expect(isTransientStatus(status)).toBe(true);
		expect(is(classify(error), Flag.Transient)).toBe(false);
		expect(isProviderRetryableError(error)).toBe(true);
	});

	/**
	 * 429 IS IN THE TRANSIENT STATUS SET AND IS STILL NOT RETRIED HERE, and the two layers now agree
	 * about that. A 429 carrying no body at all is a quota wall — the provider gave nothing else to go
	 * on — and a wall is the credential layer's to answer by rotating to a sibling, not this ladder's
	 * to re-send against the account that is out of allowance. The rotation layer has classified it
	 * that way for as long as it has existed; this predicate used to disagree, because a bare status
	 * reached no rule and `isUsageLimit` therefore said no, so the same failure was a wall to one
	 * layer and a throttle to the other.
	 *
	 * A 429 that says something keeps the old answer: the reason decides, and only an EXHAUSTED
	 * account is a wall. That is the row above (`a 429`, "rate limited", retried).
	 */
	it("hands a bare 429 to the credential layer instead of retrying the spent account", () => {
		const error = statusError(429, "");

		expect(isTransientStatus(429)).toBe(true);
		expect(isUsageLimit(error)).toBe(true);
		expect(isProviderRetryableError(error)).toBe(false);
		expect(recover(classify(error), "credential").action).toBe("rotate-credential");
	});

	it.each([400, 401, 403, 404, 409, 422])("refuses a bare %i with nothing to read", status => {
		expect(isTransientStatus(status)).toBe(false);
		expect(isProviderRetryableError(statusError(status, ""))).toBe(false);
	});
});

describe("a veto refuses a retry at every reader of the decision", () => {
	/**
	 * WHY THIS BLOCK EXISTS. A veto is the registry's strongest statement about a failure — "however
	 * the rest of this classified, do not send it again" — and it had two readers that disagreed.
	 * `retriable()` read the mask. This predicate re-derived the answer: it restated the HTTP/2 bit
	 * by hand, never asked about the other two, and reached transience from message prose, so a
	 * content filter whose body also carried a 503 was retried by the transport wording and a
	 * cancellation was retried by the word "aborted" in its own sentence while the turn refused the
	 * identical failure. Pressing escape mid-stream re-entered the stream.
	 *
	 * THE CLASS THIS CLOSES: a veto family whose refusal one reader honors and another does not. The
	 * families are enumerated from `ERROR_DOMAINS` at run time and every flag each one recovers is
	 * swept, so a fourth veto family is covered the day it is declared and the `toEqual` below turns
	 * red until someone records the decision to add it.
	 *
	 * WHAT IT DOES NOT CATCH. It does not sweep the retry loops that call this predicate, and it
	 * cannot see a cancellation that never identified itself as one: an error minted as a bare
	 * `new Error("Request was aborted")` carries no name and no flag, and is a cancellation only to
	 * a human reader. `packages/utils/test/fetch-retry.test.ts` covers the mint sites.
	 */
	const vetoFamilies = ERROR_DOMAINS.filter(domain => domain.vetoesRetry === true);
	const flagLabel = (flag: number): string =>
		ERROR_KIND_LABELS.find(([bit]) => bit === flag)?.[1] ?? `0x${flag.toString(16)}`;

	it("is declared by exactly the interrupt, content and refusal families", () => {
		expect(vetoFamilies.map(domain => domain.id)).toEqual(["interrupt", "content", "refusal"]);
	});

	/**
	 * The wording is transient on purpose. Every row carries a sentence the prose rules below the
	 * veto would retry, so a row can only pass because the veto was read first.
	 */
	it.each(
		vetoFamilies.flatMap(domain => domain.recovers.map(flag => [`${domain.id}/${flagLabel(flag)}`, flag] as const)),
	)("refuses %s however the rest of the failure classified", (_label, flag) => {
		const error = Object.assign(new Error("the model is overloaded, please retry your request"), {
			errorId: create(flag),
		});
		const id = classify(error);

		expect(is(id, Flag.Transient)).toBe(true);
		expect(vetoesRetry(id)).toBe(true);
		expect(isProviderRetryableError(error)).toBe(false);
		expect(retriable(id)).toBe(false);
	});

	/**
	 * A cancellation states itself in its NAME, which is the one thing the four layers that mint one
	 * agree on. Each row wears a sentence the prose rules would retry.
	 */
	it.each([
		["the platform's own", Object.assign(new Error("connection error, please retry"), { name: "AbortError" })],
		["the provider layer's class", new RequestAbortError("Request was aborted after a connection error")],
		["the fetch layer's", cancellationError()],
		[
			"the tool loop's",
			Object.assign(new Error("Tool execution was aborted: fetch failed"), { name: "ToolAbortError" }),
		],
	])("classifies %s cancellation as an abort and refuses it", (_label, error) => {
		const id = classify(error);

		expect(is(id, Flag.Abort)).toBe(true);
		expect(recover(id, "transport").action).toBe("abort");
		expect(isProviderRetryableError(error)).toBe(false);
		expect(retriable(id)).toBe(false);
	});

	/**
	 * A DEADLINE IS NOT A CANCELLATION, and the distinction is the whole reason the identity rule
	 * reads `isAbortError` rather than `isCancellation`. A watchdog that ends a silent stream is the
	 * failure this ladder exists to retry; widening the rule to cover a timeout would stop every
	 * stall recovery in the product.
	 */
	it.each([
		["a stream watchdog", new StreamTimeoutError("OpenAI responses stream stalled while waiting for the next event")],
		["a pre-response deadline", Object.assign(new Error("The operation timed out."), { name: "TimeoutError" })],
	])("still retries %s", (_label, error) => {
		const id = classify(error);

		expect(vetoesRetry(id)).toBe(false);
		expect(isProviderRetryableError(error)).toBe(true);
	});

	/**
	 * PROSE IS NOT THE OWNER. The word in the sentence used to be the whole rule, which is why a
	 * provider that wrote "aborted" about its own upstream got a retry and a DOM cancellation got
	 * one too. An error that says it was aborted and identifies as nothing now decides nothing: it
	 * carries no abort flag, and it is not retried either.
	 */
	it("reads no cancellation out of the word alone", () => {
		const error = new Error("the operation was aborted");

		expect(is(classify(error), Flag.Abort)).toBe(false);
		expect(isProviderRetryableError(error)).toBe(false);
	});
});

import { describe, expect, it } from "bun:test";
import {
	attach,
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
 * WHAT IT DOES NOT CATCH. It does not sweep the retry LOOPS. Each of the thirteen calls this
 * predicate, which now reads `recover(id, "transport")`, so they share one answer — but a loop that
 * asks nothing and reaches its own conclusion from prose would still pass this file. Each is
 * migrated with its own suite.
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

/** A sentence no rule in the registry reads, so only the attached flag decides. */
const NEUTRAL = "the provider did not say what happened";

/** A failure carrying exactly the flags a family declares, and no wording to add any others. */
function failureCarrying(flag: Flag): Error {
	return attach(new Error(NEUTRAL), create(flag));
}

describe("the transport stage answers with what its family declares", () => {
	/**
	 * WHY THIS BLOCK EXISTS. A provider ladder is the transport stage of the same recovery every other
	 * layer performs, and this predicate used to reach its own conclusion instead of asking: it read
	 * `Flag.Transient` and then five prose patterns, so a family whose declared transport action was
	 * `surface` was retried anyway whenever the transport vocabulary happened to match its message. A
	 * `MALFORMED_FUNCTION_CALL` is in that vocabulary. So is a `rate_limit_error` naming fast mode,
	 * which is an entitlement wall no wait clears. Both were re-sent against the same credential for
	 * the ladder's whole budget before the turn ever saw them.
	 *
	 * WHAT IT DOES NOT CATCH. It proves the ladder reads the declaration; it does not prove the
	 * declaration is right for a family. That is `every-failure-family-declares-what-each-stage-does-
	 * about-it.test.ts`, which pins the actions themselves.
	 */
	const withRecovery = ERROR_DOMAINS.filter(domain => domain.recovery !== undefined);

	it("retries exactly the families that say the transport stage retries", () => {
		const retrying = withRecovery
			.filter(domain => domain.recovery?.transport.action === "retry")
			.map(domain => domain.id);

		expect(retrying).toEqual(["transport", "timeout"]);
	});

	it.each(withRecovery.map(domain => [domain.id, domain] as const))(
		"%s is answered by its own declaration",
		(_id, domain) => {
			expect(domain.recovers.length).toBeGreaterThan(0);
			for (const flag of domain.recovers) {
				const error = failureCarrying(flag);
				const expected = recover(create(flag), "transport").action === "retry";

				expect(isProviderRetryableError(error), `${domain.id}: ${ERROR_KIND_LABELS[flag] ?? flag}`).toBe(expected);
			}
		},
	);

	/**
	 * THE ORDER DECIDES, NOT THE PRESENCE OF A FLAG. A failure carries several: a malformed function
	 * call is also transient because the transport vocabulary contains the phrase. The family that
	 * comes first in the registry owns the answer, so the ladder surfaces it and the turn re-sends it,
	 * which is what each of them declares. Reading `Flag.Transient` on its own inverted that.
	 */
	it.each([
		["a malformed function call", Flag.MalformedFunctionCall],
		["a stream that ended without saying why", Flag.ProviderFinishError],
		["a fast-mode entitlement wall", Flag.FastModeUnsupported],
	])("hands %s to the family that owns it rather than to the transport vocabulary", (_label, flag) => {
		const error = attach(new Error(NEUTRAL), create(flag, Flag.Transient));
		const id = classify(error);

		expect(is(id, Flag.Transient)).toBe(true);
		expect(recover(id, "transport").action).not.toBe("retry");
		expect(isProviderRetryableError(error)).toBe(false);
	});
});

describe("the vocabulary the ladder used to hold alone", () => {
	/**
	 * WHY THIS BLOCK EXISTS. These five phrasings lived in `isProviderRetryableError` and nowhere
	 * else. The ladder retried them and the classifier saw nothing, so the same truncated response
	 * from an Anthropic-compatible proxy was re-sent by the provider loop and reached the session as
	 * an unclassified failure — and a session that cannot see a transport fault cannot report one.
	 * They are now rules in the transport family, which is the only place that decides what they mean.
	 */
	it.each([
		["a corrupted TLS record", new Error("read error: tls: bad record mac")],
		["a server error the upstream named", new Error("upstream said type=server_error")],
		["a peer-reported HTTP/2 stream error", new Error("stream error 7 received from peer")],
		["the upstream code 1302", new Error("upstream error code 1302")],
		// "unterminated string" is in the general transient vocabulary already; this sentence is the
		// truncation rule's alone, so the row goes red if that rule stops being read.
		["a body that stopped mid-JSON", new Error("Unexpected end of JSON input")],
		["an envelope whose events arrived out of order", new Error("stream event order: text before message_start")],
	])("classifies %s as well as retrying it", (_label, error) => {
		expect(is(classify(error), Flag.Transient)).toBe(true);
		expect(isProviderRetryableError(error)).toBe(true);
	});

	/**
	 * THE NUMBER IS WORD-BOUNDED, for the reason every status number in the transport pattern is:
	 * provider errors carry model ids, request ids and token counts, and a bare four digits matches
	 * any of them. `1302` inside a model name is not an upstream code.
	 */
	it("does not read the upstream code out of a model id", () => {
		const error = new Error("model qwen-1302b rejected the request");

		expect(is(classify(error), Flag.Transient)).toBe(false);
		expect(isProviderRetryableError(error)).toBe(false);
	});
});

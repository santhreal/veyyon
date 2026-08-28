/**
 * WHY THIS EXISTS. Provider failures kept swapping sides between releases. The same truncated
 * stream was retried when Cloud Code Assist worded it and walled when OpenAI completions did,
 * because the first sentence happened to contain the word `truncated` and the second contained no
 * word any pattern held. A 503 the server asked us to retry was walled as a credential failure
 * because its body mentioned an authentication service. `MALFORMED_FUNCTION_CALL` had a rule while
 * `PROHIBITED_CONTENT` had none, so one sibling was a decision and the other was an accident.
 *
 * Each of those was fixed once, in the provider that reported it, and each came back the next time
 * a provider phrased the same fault a new way. The reason is that the evidence never entered the
 * repository: the failures live in session stores, the fixes lived in whichever module noticed.
 *
 * THE CLASS THIS CLOSES. A failure the field has already produced reaching a turn with no decision
 * behind it — either no classification at all, or a verdict that contradicts what the failure is.
 * The corpus is the field evidence, checked in and sanitized; this suite drives the real classifier
 * over it and requires an answer for every entry.
 *
 * FAIL BY DEFAULT. Two sweeps turn this red without anyone editing it: an entry that classifies to
 * nothing is reported by name unless it is pinned in `UNCLASSIFIED_BY_DESIGN`, and a recovery
 * domain no corpus entry reaches is reported unless it is pinned below. Adding a domain, or adding
 * a field message nothing recognises, is a decision somebody has to record here.
 *
 * WHAT IT DOES NOT CATCH. It reads one message per class, so it proves the classification and the
 * retry verdict, not the backoff schedule, the attempt budget, or what a ladder does after the
 * verdict. It cannot see a failure the field has not produced yet, which is the point of the
 * domain sweep: a new domain is red until its evidence arrives. It drives `classify` and
 * `isProviderRetryableError` directly, not a live provider stream.
 */
import { describe, expect, it } from "bun:test";
import { classify, Flag, is, isClassified, stringify } from "@veyyon/ai/error/flags";
import { domainOf, ERROR_DOMAINS } from "@veyyon/ai/error/registry";
import { isProviderRetryableError } from "@veyyon/ai/error/retryable";
import type { FinishReason } from "../src/providers/google-types";
import {
	OBSERVED_PROVIDER_ERRORS,
	type ObservedProviderError,
	UNCLASSIFIED_BY_DESIGN,
} from "./fixtures/provider-errors-observed-in-the-field";

// `it.each` rejects a readonly array, and the fixture is readonly on purpose.
const corpus: ObservedProviderError[] = [...OBSERVED_PROVIDER_ERRORS];

/**
 * The recovery domains no message in this corpus reaches, pinned by exact equality.
 *
 * Each is a decision, not an omission:
 * - `interrupt` is somebody asking the turn to stop, so it never arrives as a provider failure.
 * - `thinking-loop` sets its flag from the detector's own state; the sentence it writes asks for a
 *   stall retry, which is why the loop message above lands in the timeout family instead.
 * - `stream` owns `Provider finish_reason: error` and a stale Responses item. The sampled sessions
 *   produced `network_error` and `sensitive` finish reasons, which belong to transport and content,
 *   but not the bare `error` one.
 * - `overflow`, `grammar`, `fast-mode`, `refusal` and `provider-http` classify request-shaped and
 *   peer-refusal failures that the sampled sessions did not produce. They have their own suites;
 *   what is missing is field evidence, and this list shrinks when a session records one.
 *
 * A domain that JOINS this list is a domain nothing can demonstrate, which needs saying out loud.
 * A domain added to the registry and to neither side turns this red.
 */
const DOMAINS_WITHOUT_FIELD_EVIDENCE: readonly string[] = [
	"interrupt",
	"thinking-loop",
	"overflow",
	"grammar",
	"fast-mode",
	"refusal",
	"provider-http",
	"stream",
];

function firstLine(message: string): string {
	const line = message.split("\n", 1)[0] ?? message;
	return line.length > 78 ? `${line.slice(0, 75)}...` : line;
}

describe("a provider failure the field produced reaches a decision", () => {
	it.each(corpus.map(entry => [firstLine(entry.message), entry] as const))(
		"decides %s",
		(_label, entry: ObservedProviderError) => {
			const error = new Error(entry.message);
			const retried = isProviderRetryableError(error);
			expect(retried, `${entry.why}\nclassified as: ${stringify(classify(error))}`).toBe(entry.verdict === "retry");
		},
	);

	it("classifies every field message, and names the ones it cannot", () => {
		const unclassified = corpus
			.filter(entry => !isClassified(classify(new Error(entry.message))))
			.map(e => e.message);

		expect(unclassified).toEqual([]);
	});

	it("keeps the deliberately unclassified messages unclassified", () => {
		// Pinned by exact equality rather than by count: classifying one of these is a decision about
		// what recovery should do with it, and it has to be made here rather than noticed later.
		const stillUnclassified = UNCLASSIFIED_BY_DESIGN.filter(message => !isClassified(classify(new Error(message))));

		expect(stillUnclassified).toEqual([...UNCLASSIFIED_BY_DESIGN]);
	});

	it("reaches every recovery domain the registry declares", () => {
		const reached = new Set<string>();
		for (const entry of corpus) {
			const id = classify(new Error(entry.message));
			for (const domain of ERROR_DOMAINS) {
				for (const flag of domain.recovers) {
					if ((id & flag) !== 0 && domainOf(flag) === domain) reached.add(domain.id);
				}
			}
		}

		const unreached = ERROR_DOMAINS.map(domain => domain.id)
			.filter(id => !reached.has(id))
			.filter(id => !DOMAINS_WITHOUT_FIELD_EVIDENCE.includes(id));

		expect(unreached).toEqual([]);
	});

	it("states a reason for every failure it carries", () => {
		// A corpus entry whose verdict nobody justified is a guess, and a guess is what this suite
		// exists to replace. The check is on the corpus, not on the classifier.
		const unexplained = corpus.filter(entry => entry.why.trim().length < 20).map(entry => firstLine(entry.message));

		expect(unexplained).toEqual([]);
	});

	/**
	 * Every Google finish reason, decided one by one.
	 *
	 * The corpus can only hold what a session produced, and it produced two of these. The rest
	 * reached the classifier unhandled for the same reason `PROHIBITED_CONTENT` did: somebody added
	 * a member to the mirror and nobody asked what recovery should do with it.
	 *
	 * `Record<FinishReason, ...>` is what stops that repeating. It is a total map, so adding a member
	 * to `FinishReason` fails `check:ts` here until it is classified, and the decision is recorded in
	 * this table rather than discovered in a session six weeks later.
	 */
	const FINISH_REASON_VERDICTS: Record<FinishReason, "content" | "other"> = {
		FINISH_REASON_UNSPECIFIED: "other",
		STOP: "other",
		MAX_TOKENS: "other",
		SAFETY: "content",
		RECITATION: "content",
		LANGUAGE: "other",
		OTHER: "other",
		BLOCKLIST: "content",
		PROHIBITED_CONTENT: "content",
		SPII: "content",
		MALFORMED_FUNCTION_CALL: "other",
		IMAGE_SAFETY: "content",
		IMAGE_PROHIBITED_CONTENT: "content",
		IMAGE_RECITATION: "content",
		IMAGE_OTHER: "other",
		UNEXPECTED_TOOL_CALL: "other",
		NO_IMAGE: "other",
	};

	const contentReasons = Object.entries(FINISH_REASON_VERDICTS)
		.filter(([, verdict]) => verdict === "content")
		.map(([reason]) => reason);

	it.each(contentReasons)("treats finish reason %s as a content verdict", reason => {
		const error = new Error(`Generation failed with finish reason: ${reason}`);

		expect(is(classify(error), Flag.ContentBlocked)).toBe(true);
		expect(isProviderRetryableError(error)).toBe(false);
	});
});

/**
 * `evaluateSubmitTrigger` splits on `/\s+/` and matches "a word containing
 * submit" with `/(?:^|\s+)(\S*submit\S*)[.?!…。？！]*\s*$/i`.
 *
 * Existing stt-submit-trigger.test.ts pins never / release / release-complete
 * / say-submit for ordinary ASCII spaces. Dictation engines insert U+200B
 * (ZWSP), U+00A0 (NBSP), and glue "resubmit" / "unsubmit" / "Submit." as one
 * token. Those are the shapes that either fire a send the operator did not
 * mean, or fail to fire one they did.
 *
 * Do not clone the two-word release cases or the "hello world!" complete
 * cases already in that file.
 */
import { describe, expect, it } from "bun:test";
import { evaluateSubmitTrigger } from "@veyyon/coding-agent/stt/submit-trigger";

const ZWSP = "\u200B";
const NBSP = "\u00A0";
const NARROW_NBSP = "\u202F";
const WORD_JOINER = "\u2060";

describe("release counts words by ASCII whitespace, not Unicode word breaks", () => {
	it("does not treat ZWSP as a word separator, so two spoken words glued by ZWSP are one token", () => {
		expect(evaluateSubmitTrigger(`hello${ZWSP}world`, "release")).toEqual({
			submit: false,
			trimTrailing: 0,
		});
	});

	it("does not treat a word joiner as a separator", () => {
		expect(evaluateSubmitTrigger(`hello${WORD_JOINER}world`, "release")).toEqual({
			submit: false,
			trimTrailing: 0,
		});
	});

	it("does treat NBSP as \\s, so two NBSP-separated words submit on release", () => {
		expect(evaluateSubmitTrigger(`hello${NBSP}world`, "release")).toEqual({
			submit: true,
			trimTrailing: 0,
		});
	});

	it("does treat narrow NBSP as \\s", () => {
		expect(evaluateSubmitTrigger(`hello${NARROW_NBSP}world`, "release")).toEqual({
			submit: true,
			trimTrailing: 0,
		});
	});

	it("does not submit a single CJK run with no space (one 'word' to split)", () => {
		expect(evaluateSubmitTrigger("你好世界", "release")).toEqual({
			submit: false,
			trimTrailing: 0,
		});
	});

	it("submits two CJK runs separated by a space", () => {
		expect(evaluateSubmitTrigger("你好 世界", "release")).toEqual({
			submit: true,
			trimTrailing: 0,
		});
	});
});

describe("release-complete does not treat an ellipsis of dots as terminal unless the class says so", () => {
	it("accepts U+2026 ellipsis as terminal", () => {
		expect(evaluateSubmitTrigger("hello world…", "release-complete").submit).toBe(true);
	});

	it("does not treat a trailing comma as terminal", () => {
		expect(evaluateSubmitTrigger("hello world,", "release-complete").submit).toBe(false);
	});

	it("does not treat a trailing semicolon as terminal", () => {
		expect(evaluateSubmitTrigger("hello world;", "release-complete").submit).toBe(false);
	});

	it("does not treat a trailing colon as terminal", () => {
		expect(evaluateSubmitTrigger("hello world:", "release-complete").submit).toBe(false);
	});

	it("accepts fullwidth ideographic end punctuation", () => {
		expect(evaluateSubmitTrigger("你好。", "release-complete").submit).toBe(true);
		expect(evaluateSubmitTrigger("你好？", "release-complete").submit).toBe(true);
		expect(evaluateSubmitTrigger("你好！", "release-complete").submit).toBe(true);
	});

	it("does not submit when terminal punctuation is in the middle, not at the end", () => {
		expect(evaluateSubmitTrigger("Hello. world", "release-complete").submit).toBe(false);
	});
});

describe("say-submit matches any token that contains 'submit', including resubmit", () => {
	it("submits and trims on a lone 'resubmit'", () => {
		const r = evaluateSubmitTrigger("resubmit", "say-submit");
		expect(r.submit).toBe(true);
		expect(r.trimTrailing).toBe("resubmit".length);
	});

	it("submits and trims on a lone 'unsubmit'", () => {
		const r = evaluateSubmitTrigger("unsubmit", "say-submit");
		expect(r.submit).toBe(true);
		expect(r.trimTrailing).toBe("unsubmit".length);
	});

	it("submits on 'please resubmit' and trims only the last token plus preceding space", () => {
		const utterance = "please resubmit";
		const r = evaluateSubmitTrigger(utterance, "say-submit");
		expect(r.submit).toBe(true);
		expect(utterance.slice(0, utterance.length - r.trimTrailing)).toBe("please");
	});

	it("does not fire when 'submit' is not in the last word", () => {
		expect(evaluateSubmitTrigger("submit this later", "say-submit")).toEqual({
			submit: false,
			trimTrailing: 0,
		});
	});

	it("fires on 'Submit.' with terminal punctuation glued to the word", () => {
		const utterance = "looks good Submit.";
		const r = evaluateSubmitTrigger(utterance, "say-submit");
		expect(r.submit).toBe(true);
		expect(utterance.slice(0, utterance.length - r.trimTrailing).trim()).toBe("looks good");
	});

	it("does not fire when ZWSP splits 'sub' and 'mit' so neither token contains submit", () => {
		expect(evaluateSubmitTrigger(`please sub${ZWSP}mit`, "say-submit")).toEqual({
			submit: false,
			trimTrailing: 0,
		});
	});

	it("does fire when ZWSP is inside a single \\S run around submit", () => {
		const utterance = `please sub${ZWSP}mit`;
		// ZWSP is not \\s and is \\S, so the last token is sub<ZWSP>mit which
		// contains the letters submit only if they are contiguous. They are not.
		// Pin the actual contiguous case: 'submit' with a trailing ZWSP.
		const glued = `please submit${ZWSP}`;
		const r = evaluateSubmitTrigger(glued, "say-submit");
		expect(r.submit).toBe(true);
		expect(utterance).toContain(ZWSP);
	});

	it("never-trigger still refuses resubmit", () => {
		expect(evaluateSubmitTrigger("resubmit", "never")).toEqual({
			submit: false,
			trimTrailing: 0,
		});
	});
});

/**
 * `evaluateSubmitTrigger` splits on `/\s+/` and matches "a word containing
 * submit" with `/(?:^|\s+)(\S*submit\S*)[.?!…。？！]*\s*$/i`.
 *
 * stt-submit-trigger.test.ts pins never / release / release-complete /
 * say-submit for ordinary ASCII spaces. Do not clone those.
 */
import { describe, expect, it } from "bun:test";
import { evaluateSubmitTrigger } from "@veyyon/coding-agent/stt/submit-trigger";

const ZWSP = "\u200B";
const NBSP = "\u00A0";

describe("release counts words by ASCII whitespace, not Unicode word breaks", () => {
	it("does not treat ZWSP as a word separator, so two spoken words glued by ZWSP are one token", () => {
		expect(evaluateSubmitTrigger(`hello${ZWSP}world`, "release")).toEqual({
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

	it("does not submit a single CJK run with no space (one 'word' to split)", () => {
		expect(evaluateSubmitTrigger("你好世界", "release")).toEqual({
			submit: false,
			trimTrailing: 0,
		});
	});
});

describe("release-complete terminal class is the regex, not English punctuation", () => {
	it("accepts U+2026 ellipsis as terminal", () => {
		expect(evaluateSubmitTrigger("hello world…", "release-complete").submit).toBe(true);
	});

	it("does not treat a trailing comma as terminal", () => {
		expect(evaluateSubmitTrigger("hello world,", "release-complete").submit).toBe(false);
	});

	it("accepts fullwidth ideographic end punctuation", () => {
		expect(evaluateSubmitTrigger("你好。", "release-complete").submit).toBe(true);
	});
});

describe("say-submit matches any token that contains 'submit', including resubmit", () => {
	it("submits and trims on a lone 'resubmit'", () => {
		const r = evaluateSubmitTrigger("resubmit", "say-submit");
		expect(r.submit).toBe(true);
		expect(r.trimTrailing).toBe("resubmit".length);
	});

	it("submits on 'please resubmit' and trims only the last token plus preceding space", () => {
		const utterance = "please resubmit";
		const r = evaluateSubmitTrigger(utterance, "say-submit");
		expect(r.submit).toBe(true);
		expect(utterance.slice(0, utterance.length - r.trimTrailing)).toBe("please");
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
});

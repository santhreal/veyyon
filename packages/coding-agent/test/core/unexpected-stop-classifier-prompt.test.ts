/**
 * The unexpected-stop classifier prompt must never present an empty message.
 *
 * One PROMPTS["turn-control/unexpected-stop-classifier"].text serves two delivery shapes, and they disagreed. The LOCAL path
 * renders it with the message inlined; the ONLINE path sends the message as its
 * own user turn and renders the PROMPTS["turn-control/unexpected-stop-classifier"].text with no context at all. Because
 * templates compiled with `strict: false`, that second render emitted a bare
 *
 *     Message:
 *
 *     Answer with a single word: ...
 *
 * — a heading promising text that was not there, followed by an instruction to
 * judge it. Nothing failed, because nothing asserted the bytes; the classifier
 * simply ran against a prompt that pointed at a hole. This is the exact class
 * of defect SYSPROMPT-1's missing-variable check exists to catch, and it was the
 * first one it found.
 *
 * The slot is now guarded, so the heading appears only alongside a message.
 * These tests pin both shapes, because a fix that repaired one by breaking the
 * other would be no fix at all.
 */
import { describe, expect, it } from "bun:test";
import { PROMPTS } from "@veyyon/coding-agent/prompts/registry";
import { prompt } from "@veyyon/utils";

describe("rendered with no message, as the online path does", () => {
	const rendered = prompt.render(PROMPTS["turn-control/unexpected-stop-classifier"].text, {});

	it("emits no Message heading at all", () => {
		// The defect verbatim. A dangling heading is worse than no heading: it
		// tells the model the text it must judge should be right here.
		expect(rendered).not.toContain("Message:");
	});

	it("still carries the instruction and both example sets", () => {
		// The differential. Suppressing the heading by suppressing the whole
		// prompt would pass the assertion above and destroy the classifier.
		expect(rendered).toContain("whether an assistant message is an unexpected stop");
		expect(rendered).toContain("Examples of unexpected stops:");
		expect(rendered).toContain("Not an unexpected stop:");
		expect(rendered).toContain("Answer with a single word: YES if this is an unexpected stop, NO otherwise.");
	});

	it("leaves no blank run where the message section used to be", () => {
		// A guard that removed the text but kept its surrounding newlines would
		// still ship the gap, just without the label on it.
		expect(rendered).not.toMatch(/\n{3,}/);
	});
});

describe("rendered with a message, as the local path does", () => {
	const rendered = prompt.render(PROMPTS["turn-control/unexpected-stop-classifier"].text, {
		message: "Let me run the tests next.",
	});

	it("labels the message and includes it", () => {
		// The path that was always correct, pinned so the guard cannot regress it
		// into dropping the message entirely.
		expect(rendered).toContain("Message:\nLet me run the tests next.");
	});

	it("keeps the answer instruction after the message, not before it", () => {
		// Order is load-bearing: the instruction has to be the last thing the model
		// reads, or it answers about the examples instead of the message.
		expect(rendered.indexOf("Let me run the tests next.")).toBeLessThan(
			rendered.indexOf("Answer with a single word"),
		);
	});
});

describe("the classifier template's own contract", () => {
	it("declares message as optional rather than required", () => {
		// The analyzer's verdict is what keeps the online path renderable at all.
		// If `message` ever becomes required again, the online render throws at
		// module load and the classifier stops existing.
		const analysis = prompt.analyzePromptTemplate(PROMPTS["turn-control/unexpected-stop-classifier"].text);

		expect(analysis.required.map(v => v.name)).toEqual([]);
		expect(analysis.optional.map(v => v.name)).toEqual(["message"]);
	});
});

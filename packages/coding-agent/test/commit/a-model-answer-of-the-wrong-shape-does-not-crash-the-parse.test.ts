/**
 * WHY: when a model answers a commit-analysis or changelog request in text
 * instead of calling the tool, the reply was cast to the expected interface
 * without being checked. `normalizeAnalysis` then mapped over an absent
 * `details` and raised `Cannot read properties of undefined (reading 'map')`
 * from inside commit analysis, and `dedupeEntries` iterated a string value
 * character by character, filling a changelog with single-letter bullets rather
 * than reporting anything wrong.
 *
 * The scan made this reachable in a second way. It returns the first
 * brace-balanced object that parses, so a model that reasons in JSON before
 * answering — `{"thinking": "..."} {"type": "feat", "details": [...]}` — handed
 * the caller the reasoning object. A shape now selects the candidate, so the
 * scan walks past it.
 *
 * THE CLASS this closes: a text-fallback payload trusted without its shape. Both
 * fallbacks are swept over the same table of answer shapes a model really
 * produces. A third fallback added without a guard is not caught here — there is
 * no registry of them to enumerate — so the table below is the contract each new
 * one is expected to join.
 *
 * BACKTEST PROVENANCE: the shapes are the ones observed failing in a real
 * session, reduced to the structural feature that triggered each — a missing
 * key, a string where an array belongs, a leading reasoning object — and rewritten
 * with neutral content. No captured text, path, or identifier from that session
 * appears here.
 *
 * WHAT IT DOES NOT CATCH: a payload of the right shape carrying wrong VALUES. A
 * guard that accepts `details: []` cannot tell an empty analysis from a model
 * that declined, and nothing downstream distinguishes them either.
 */

import { describe, expect, it } from "bun:test";
import { parseJsonPayload } from "../../src/commit/utils/analysis";

/** The load-bearing shape of a conventional-analysis reply. */
function isAnalysis(value: unknown): value is { details: Array<{ text: string }> } {
	if (typeof value !== "object" || value === null || !Array.isArray((value as { details?: unknown }).details)) {
		return false;
	}
	return (value as { details: unknown[] }).details.every(
		detail =>
			typeof detail === "object" && detail !== null && typeof (detail as { text?: unknown }).text === "string",
	);
}

/** The load-bearing shape of a changelog reply. */
function isChangelog(value: unknown): value is { entries: Record<string, string[]> } {
	const entries = (value as { entries?: unknown })?.entries;
	if (typeof entries !== "object" || entries === null || Array.isArray(entries)) return false;
	return Object.values(entries).every(
		bullets => Array.isArray(bullets) && bullets.every(bullet => typeof bullet === "string"),
	);
}

/** Answer shapes a model produces instead of the payload, and what each used to do. */
const WRONG_SHAPES: Array<[string, string]> = [
	["a refusal object", '{"message": "No changes found"}'],
	["an error object", '{"error": "the diff was empty"}'],
	["the payload's siblings without details", '{"type": "feat", "scope": "core"}'],
	["details as a string", '{"type": "feat", "details": "one change"}'],
	["details holding bare strings", '{"type": "feat", "details": ["one change"]}'],
	["details holding an untexted object", '{"type": "feat", "details": [{"note": "one change"}]}'],
	["a JSON array rather than an object", '[{"text": "one change"}]'],
];

describe("a text answer of the wrong shape is reported, not cast", () => {
	it.each(WRONG_SHAPES)("rejects %s rather than returning it", (_label, answer) => {
		expect(() => parseJsonPayload(answer, isAnalysis)).toThrow(/No JSON payload/);
	});

	/**
	 * NON-VACUITY. A guard that rejected everything would satisfy the sweep above
	 * and break every text fallback, so the shape the code expects still parses.
	 */
	it("accepts the shape the caller expects", () => {
		const answer = '{"type": "feat", "scope": "core", "details": [{"text": "one change"}], "issue_refs": []}';

		expect(parseJsonPayload(answer, isAnalysis).details).toEqual([{ text: "one change" }]);
	});

	/**
	 * The scan's own selection. Before a shape was supplied it returned the FIRST
	 * balanced object, which is the model's reasoning, not its answer.
	 */
	it("walks past a leading object of the wrong shape to the real payload", () => {
		const answer = '{"thinking": "the diff adds a function"}\n{"type": "feat", "details": [{"text": "one change"}]}';

		expect(parseJsonPayload(answer, isAnalysis).details).toEqual([{ text: "one change" }]);
	});

	/** Prose around the payload is what the scan was written for; a shape must not break it. */
	it("finds a payload wrapped in prose and a fence", () => {
		const answer = 'Here is the analysis:\n```json\n{"type": "fix", "details": [{"text": "one change"}]}\n```\nDone.';

		expect(parseJsonPayload(answer, isAnalysis).details).toEqual([{ text: "one change" }]);
	});

	it("says the shape was missing rather than that no JSON was there", () => {
		expect(() => parseJsonPayload('{"message": "No changes found"}', isAnalysis)).toThrow(
			"No JSON payload of the expected shape in response",
		);
		expect(() => parseJsonPayload("no braces at all", isAnalysis)).toThrow("No JSON payload found in response");
	});
});

describe("a changelog answer of the wrong shape is reported, not iterated", () => {
	/** A string here used to become one bullet per character. */
	it.each([
		["entries as a string", '{"entries": "none"}'],
		["a category holding a string", '{"entries": {"Added": "one bullet"}}'],
		["a category holding numbers", '{"entries": {"Added": [1, 2]}}'],
		["entries as an array", '{"entries": []}'],
		["no entries key", '{"summary": "nothing to report"}'],
	])("rejects %s rather than returning it", (_label, answer) => {
		expect(() => parseJsonPayload(answer, isChangelog)).toThrow(/No JSON payload/);
	});

	it("accepts categories holding string arrays", () => {
		const answer = '{"entries": {"Added": ["one bullet"], "Fixed": ["another bullet"]}}';

		expect(parseJsonPayload(answer, isChangelog).entries).toEqual({
			Added: ["one bullet"],
			Fixed: ["another bullet"],
		});
	});

	/** An empty set of categories is a real answer: the model found nothing to say. */
	it("accepts an empty entries object", () => {
		expect(parseJsonPayload('{"entries": {}}', isChangelog).entries).toEqual({});
	});
});

/**
 * Regression guard for the htmlToMarkdown deep-nesting DoS.
 *
 * The native `htmlToMarkdown` recurses per nested element and hard-crashes the
 * whole process (unrecoverable native stack overflow, not a catchable throw) on
 * deeply nested HTML (~5000 elements). Fetch runs it on attacker-controlled
 * pages, so `htmlNestingExceeds` gates the native reader: over-nested HTML skips
 * it and falls through to another extractor instead of crashing. These asserts
 * verify the gate flags the attack while never rejecting realistic pages.
 *
 * The attack input is checked against the GATE only — never passed to the real
 * htmlToMarkdown, which would core-dump this test process.
 */
import { describe, expect, it } from "bun:test";
import { htmlNestingExceeds } from "@veyyon/coding-agent/tools/fetch";

const LIMIT = 500;

describe("html nesting DoS gate", () => {
	it("flags the deep-nesting attack that crashes the native converter", () => {
		// ~5000-deep is the empirically-observed core-dump depth; the gate must trip
		// well before it.
		const attack = `${"<div>".repeat(5000)}x${"</div>".repeat(5000)}`;
		expect(htmlNestingExceeds(attack, LIMIT)).toBe(true);
		// Just past the limit also trips.
		expect(htmlNestingExceeds(`${"<div>".repeat(LIMIT + 5)}x`, LIMIT)).toBe(true);
	});

	it("does not flag realistic pages, even large or void-heavy ones", () => {
		// A normal document nests only a handful deep.
		expect(htmlNestingExceeds("<html><body><main><article><p>hi</p></article></main></body></html>", LIMIT)).toBe(
			false,
		);
		// Depth ~20 (deeper than almost any real page) still passes.
		expect(htmlNestingExceeds(`${"<div>".repeat(20)}x${"</div>".repeat(20)}`, LIMIT)).toBe(false);
		// A long run of VOID elements does not nest — must not false-trip.
		expect(htmlNestingExceeds("<br>".repeat(3000), LIMIT)).toBe(false);
		expect(htmlNestingExceeds('<img src="x">'.repeat(3000), LIMIT)).toBe(false);
		// Self-closing tags are depth-neutral too.
		expect(htmlNestingExceeds("<input/>".repeat(3000), LIMIT)).toBe(false);
		// Wide-but-shallow: thousands of siblings, each closed — real-page shape.
		expect(htmlNestingExceeds("<li>item</li>".repeat(3000), LIMIT)).toBe(false);
	});

	it("counts depth from balanced open/close, not raw tag count", () => {
		// 600 opens but each immediately closed -> depth 1, under the limit.
		expect(htmlNestingExceeds("<span>x</span>".repeat(600), LIMIT)).toBe(false);
	});
});

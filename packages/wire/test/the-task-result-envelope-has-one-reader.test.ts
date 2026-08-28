/**
 * WHY: one envelope, two surfaces, and until now two readers.
 *
 * THE DEFECT CLASS. A finished subagent returns the `<task-result>` envelope written by
 * `packages/coding-agent/src/prompts/tools/task-summary.md`. It is addressed to the MODEL —
 * status, duration, the `agent://` pointer — and a person reading a job row wants only the
 * body. Two surfaces strip it: the TUI job tool and the shared React renderer that draws the
 * same rows for HTML export and collab-web. Each carried a byte-identical private copy of the
 * pattern. Two copies of one wire shape drift in exactly one direction: the surface nobody is
 * watching keeps the old pattern, stops matching, and shows a reader raw markup while the
 * other surface stays clean. Neither copy is wrong at the moment it is written, which is why
 * this kind of duplication survives review.
 *
 * THE SHAPE OF THE FIX. `stripTaskResultEnvelope` lives in `@veyyon/wire`, which is
 * dependency-free and which both surfaces already depend on. This file is the owner's own
 * suite. The renderers prove they ASK the owner
 * (`packages/tool-render/test/job-renderer-strips-the-task-result-envelope.test.ts`, and
 * `packages/coding-agent/test/job-renderer-preview.test.ts`, which renders the REAL prompt and
 * so also pins the tag names this parser looks for).
 *
 * WHAT IT DOES NOT CATCH. A third surface that grows its own copy: nothing here can see code
 * that never calls this function. It also says nothing about truncation or whitespace
 * normalization, which each surface applies afterwards and differently.
 */
import { describe, expect, it } from "bun:test";
import { stripTaskResultEnvelope } from "../src/task-result";

/** An envelope in the shape the prompt emits, with the attributes it always carries. */
function envelope(inner: string): string {
	return ['<task-result id="Probe" agent="deep" status="completed" duration="4s">', inner, "</task-result>"].join(
		"\n",
	);
}

describe("the task-result envelope has one reader", () => {
	it("returns the inner body for every wrapper the prompt can emit", () => {
		expect(stripTaskResultEnvelope(envelope("<output>\nthe answer\n</output>"))).toBe("the answer");
		expect(stripTaskResultEnvelope(envelope("<preview>\ntruncated answer\n</preview>"))).toBe("truncated answer");
		// The prompt emits `<preview lines="12" size="900">` when it truncates, so attributes
		// on the body tag must not stop it matching.
		expect(stripTaskResultEnvelope(envelope('<preview lines="12" size="900">\nbig one\n</preview>'))).toBe("big one");
		// `<meta />` and `<abort-reason>` precede the body in a real envelope.
		expect(
			stripTaskResultEnvelope(
				envelope('<meta lines="3" size="42" />\n<abort-reason>stopped</abort-reason>\n<output>\nbody\n</output>'),
			),
		).toBe("body");
	});

	it("keeps multi-line bodies whole and only trims their edges", () => {
		expect(stripTaskResultEnvelope(envelope("<output>\nfirst\n\nsecond\n</output>"))).toBe("first\n\nsecond");
	});

	it("passes through anything that is not an envelope", () => {
		// A bash job's result text, which must never be reshaped.
		expect(stripTaskResultEnvelope("built 4 targets in 2.1s")).toBe("built 4 targets in 2.1s");
		expect(stripTaskResultEnvelope("")).toBe("");
		// A body that merely mentions the tag is not one: the check is anchored at the start.
		const mentions = "the agent printed <task-result> and stopped";
		expect(stripTaskResultEnvelope(mentions)).toBe(mentions);
	});

	it("returns the envelope rather than nothing when there is no body to show", () => {
		// A preview that says nothing is worse than the markup it replaced, so these keep the
		// original text: an empty body, and a body tag the envelope never closed.
		const empty = envelope("<output>\n\n</output>");
		expect(stripTaskResultEnvelope(empty)).toBe(empty);
		const unterminated = '<task-result id="Probe" status="failed">\n<output>\nhalf a body';
		expect(stripTaskResultEnvelope(unterminated)).toBe(unterminated);
		const noBody = envelope('<meta lines="0" size="0" />');
		expect(stripTaskResultEnvelope(noBody)).toBe(noBody);
	});
});

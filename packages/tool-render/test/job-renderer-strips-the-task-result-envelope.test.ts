/**
 * The web/HTML job rows show a finished subagent's answer, not the markup around it.
 *
 * WHY THIS SUITE EXISTS. A settled `task` job carries the `<task-result>` envelope written
 * by the task-summary prompt: status, duration, an `agent://` pointer, and the body wrapped
 * in `<output>` or `<preview>`. All of that is addressed to the MODEL. A person scanning job
 * rows wants the answer, and a row whose one-line preview reads
 * `<task-result id="Probe" agent="deep" ...` has spent its only line on markup.
 *
 * THE CLASS IT CLOSES. This renderer used to carry its own private copy of the envelope
 * pattern, byte-identical to the one in the TUI job tool. Two copies of one wire shape drift
 * silently: the surface nobody is watching keeps the stale pattern and starts showing raw
 * markup. The parser now has one owner, `@veyyon/wire/task-result`, whose own contract suite
 * is `packages/wire/test/the-task-result-envelope-has-one-reader.test.ts`. This file is the
 * other half of that arrangement: it proves this renderer ASKS the owner rather than
 * answering for itself, by driving the real registry renderer and reading the emitted HTML.
 *
 * WHAT IT DOES NOT CATCH. Whether the envelope the prompt emits still has the tag names the
 * owner looks for; `packages/coding-agent/test/job-renderer-preview.test.ts` renders the real
 * prompt and pins that.
 */
import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { resolveToolRenderer } from "../src/registry";
import type { ToolRenderProps, ToolResultLike } from "../src/types";

const renderer = resolveToolRenderer("job");

function jobResult(overrides: Record<string, unknown>): ToolResultLike {
	return {
		content: [{ type: "text", text: "1 job." }],
		details: {
			jobs: [
				{
					id: "Probe",
					type: "task",
					status: "completed",
					label: "Probe",
					durationMs: 4200,
					resultText: "",
					errorText: "",
					...overrides,
				},
			],
		},
	};
}

function body(result: ToolResultLike): string {
	const Body = renderer.Body;
	if (!Body) throw new Error("job renderer has no Body");
	return renderToStaticMarkup(createElement(Body, { name: "job", args: {}, result } as ToolRenderProps));
}

/** An envelope in the shape the task-summary prompt emits. */
const ENVELOPE = [
	'<task-result id="Probe" agent="deep" status="completed" duration="4s">',
	'<meta lines="2" size="31" />',
	"<output>",
	"the migration is already applied",
	"</output>",
	"</task-result>",
].join("\n");

describe("the job rows strip the task-result envelope", () => {
	it("previews the body of a settled task job, never the wrapper", () => {
		const html = body(jobResult({ resultText: ENVELOPE }));
		expect(html).toContain("the migration is already applied");
		expect(html).not.toContain("task-result");
		expect(html).not.toContain("&lt;output&gt;");
	});

	it("strips it out of an error preview as well as a result preview", () => {
		// `errorText` wins over `resultText` in the preview, and an aborted subagent's
		// envelope reaches it by exactly the same route.
		const aborted = ENVELOPE.replace("the migration is already applied", "ran out of budget");
		const html = body(jobResult({ status: "failed", resultText: "", errorText: aborted }));
		expect(html).toContain("ran out of budget");
		expect(html).not.toContain("task-result");
	});

	it("leaves a non-envelope result alone", () => {
		// A bash job's output is not an envelope and must reach the row unreshaped.
		const html = body(jobResult({ type: "bash", resultText: "built 4 targets in 2.1s" }));
		expect(html).toContain("built 4 targets in 2.1s");
	});
});

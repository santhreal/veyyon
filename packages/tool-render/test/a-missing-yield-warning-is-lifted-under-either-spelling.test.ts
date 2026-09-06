/**
 * The task card lifts the runtime's missing-yield warning out of an agent's output whichever
 * spelling the session file recorded.
 *
 * WHY THIS SUITE EXISTS. The runtime prepends `SYSTEM WARNING: <Agent|Subagent> exited without
 * calling yield tool …` to an agent's output when the agent never called `yield`. The renderer
 * matches that first line by prefix and draws it as a warning note instead of as the first
 * line of the output preview. When the product retired the `subagent` vocabulary, the runtime's
 * spelling changed with it, and a renderer that matched only the new spelling would show every
 * pre-rename session's warning inline as ordinary output.
 *
 * THE CLASS IT CLOSES. A persisted string the renderer parses by prefix must keep matching every
 * spelling a session file ever recorded. The suite drives the real registry renderer with both
 * spellings and asserts the same lift for each, and with an unrelated first line to prove the
 * match is not vacuous.
 *
 * WHAT IT DOES NOT CATCH. A third spelling introduced later; the runtime constant in
 * `packages/coding-agent/src/task/executor.ts` is not read here.
 */
import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { resolveToolRenderer } from "../src/registry";
import type { ToolRenderProps, ToolResultLike } from "../src/types";

const renderer = resolveToolRenderer("task");

function taskResult(output: string): ToolResultLike {
	return {
		content: [{ type: "text", text: "1 agent." }],
		details: {
			results: [
				{
					id: "Probe",
					agent: "deep",
					status: "completed",
					output,
					durationMs: 4200,
				},
			],
		},
	};
}

function body(result: ToolResultLike): string {
	const Body = renderer.Body;
	if (!Body) throw new Error("task renderer has no Body");
	return renderToStaticMarkup(createElement(Body, { name: "task", args: {}, result } as ToolRenderProps));
}

const ANSWER = "the migration is already applied";

describe("a missing-yield warning is lifted under either spelling", () => {
	for (const spelling of ["Agent", "Subagent"]) {
		it(`draws the ${spelling} spelling as a warning note above the output, not inside it`, () => {
			const warning = `SYSTEM WARNING: ${spelling} exited without calling yield tool after 3 reminders.`;
			const html = body(taskResult(`${warning}\n\n${ANSWER}`));
			// The warning is the warn note, drawn once; the output preview opens on the answer.
			expect(html).toContain(`<div class="tv-note tv-note--warn">${warning}</div>`);
			expect(html.indexOf(warning)).toBe(html.lastIndexOf(warning));
			expect(html).toContain(ANSWER);
		});
	}

	it("leaves a first line that is not the warning inside the output preview", () => {
		const first = "SYSTEM NOTICE: the agent yielded early";
		const html = body(taskResult(`${first}\n\n${ANSWER}`));
		expect(html).toContain(first);
		expect(html).toContain(ANSWER);
		expect(html).not.toContain("tv-note");
	});
});

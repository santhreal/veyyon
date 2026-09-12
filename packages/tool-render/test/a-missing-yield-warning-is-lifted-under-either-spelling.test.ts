import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { resolveToolRenderer } from "../src/registry";
import type { ToolResultLike } from "../src/types";

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
	const renderer = resolveToolRenderer("task");
	const Body = renderer.Body;
	if (!Body) throw new Error("task renderer has no Body");
	return renderToStaticMarkup(createElement(Body, { name: "task", args: {}, result }));
}

const ANSWER = "the migration is already applied";

describe("a missing-yield warning is lifted under either spelling", () => {
	for (const spelling of ["Agent", "Subagent"]) {
		it(`draws the ${spelling} spelling in the output`, () => {
			const warning = `SYSTEM WARNING: ${spelling} exited without calling yield tool after 3 reminders.`;
			const html = body(taskResult(`${warning}\n\n${ANSWER}`));
			expect(html).toContain(warning);
			expect(html).toContain(ANSWER);
		});
	}

	it("leaves a first line that is not the warning inside the output preview", () => {
		const first = "SYSTEM NOTICE: the agent yielded early";
		const html = body(taskResult(`${first}\n\n${ANSWER}`));
		expect(html).toContain(first);
		expect(html).toContain(ANSWER);
	});
});
